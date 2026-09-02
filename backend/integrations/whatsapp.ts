import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  proto,
  Contact,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
// @ts-expect-error - no types available
import qrcode from "qrcode-terminal";
import { readFileSync, existsSync } from "fs";
import { safeReadJSON, atomicWriteJSON } from "../utils/file-store.js";
import { createHash } from "crypto";
import { EventEmitter } from "events";
import { createLogger } from "../logger.js";
import { transcribeAudio } from "../utils/transcribe.js";
import { describeImage, isVisionRefusal } from "../utils/vision.js";
import { normalizeJid, invalidateJidAliasMap } from "./jid-alias.js";

// Emits 'logout' when WhatsApp session is logged out.
// Listeners can perform cleanup before the process exits.
export const whatsappEvents = new EventEmitter();

export type MessageHandler = (
  jid: string,
  text: string,
  message: proto.IWebMessageInfo
) => Promise<void>;

export interface ObservationEvent {
  senderName: string;
  senderJid: string;
  isGroup: boolean;
  groupName?: string;
  isFromMe: boolean;
  text: string;
  chatJid?: string;     // For DMs: the remote JID (who the chat is with)
  chatName?: string;    // For DMs: resolved name of the chat counterpart
  mediaType?: "voice" | "image" | "document"; // Media type if message contains non-text media
}

export type ObservationHandler = (obs: ObservationEvent) => void;

const logger = pino({ level: "silent" });
const log = createLogger("whatsapp");

let sock: ReturnType<typeof makeWASocket>;
let latestQr: string | null = null;
let isConnected = false;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY = 60_000; // 60s max
const BASE_RECONNECT_DELAY = 5_000; // 5s base
// Message dedup caches with TTL (timestamp-tracked Maps + periodic sweep)
const MESSAGE_DEDUP_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_DEDUP_CACHE_SIZE = 10_000;
const DEDUP_SWEEP_INTERVAL = 60 * 1000; // sweep every 60s
const processedMessages = new Map<string, number>(); // msgId → timestamp
const sentMessages = new Map<string, number>(); // dedupKey → timestamp

function sweepDedupCache(cache: Map<string, number>, ttl: number, maxSize: number): void {
  const now = Date.now();
  for (const [key, ts] of cache) {
    if (now - ts > ttl) cache.delete(key);
  }
  // Safety cap: if still over max, remove oldest entries
  if (cache.size > maxSize) {
    const sorted = [...cache.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = cache.size - maxSize;
    for (let i = 0; i < toRemove; i++) {
      cache.delete(sorted[i][0]);
    }
  }
}

setInterval(() => {
  sweepDedupCache(processedMessages, MESSAGE_DEDUP_TTL, MAX_DEDUP_CACHE_SIZE);
  sweepDedupCache(sentMessages, MESSAGE_DEDUP_TTL, MAX_DEDUP_CACHE_SIZE);
}, DEDUP_SWEEP_INTERVAL).unref();

// Group name cache with TTL to prevent unbounded memory growth
const GROUP_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const MAX_GROUP_CACHE_SIZE = 500;
const groupNameCache = new Map<string, { name: string; cachedAt: number }>();

// --- Contact store ---
const CONTACTS_PATH = process.env.DATA_DIR
  ? `${process.env.DATA_DIR}/brain/contacts.json`
  : "/data/brain/contacts.json";

const MAX_CONTACT_STORE_SIZE = 10_000;
const contactStore = new Map<string, Contact>();

function loadContacts(): void {
  if (!existsSync(CONTACTS_PATH)) return;
  const data = safeReadJSON<Contact[]>(CONTACTS_PATH, []);
  for (const c of data) {
    contactStore.set(c.id, c);
  }
  if (data.length > 0) {
    log.info(`Loaded ${contactStore.size} contacts from disk`);
  }
}

function saveContacts(): void {
  if (contactStore.size > MAX_CONTACT_STORE_SIZE) {
    log.warn(`Contact store size (${contactStore.size}) exceeds max (${MAX_CONTACT_STORE_SIZE}) — consider cleanup`);
  }
  atomicWriteJSON(CONTACTS_PATH, Array.from(contactStore.values()));
  // Contact pairs (lid ↔ phone JID) may have changed — let alias consumers rebuild.
  invalidateJidAliasMap();
}

/** Search contacts by name (case-insensitive partial match on name or notify). */
export function findContacts(query: string): Contact[] {
  const q = query.toLowerCase();
  return Array.from(contactStore.values()).filter(
    (c) =>
      c.name?.toLowerCase().includes(q) ||
      c.notify?.toLowerCase().includes(q)
  );
}

/** Get all contacts. */
export function getAllContacts(): Contact[] {
  return Array.from(contactStore.values());
}

export function getLatestQr(): string | null {
  return latestQr;
}

export function getWhatsAppStatus(): { connected: boolean; contactCount: number } {
  return {
    connected: isConnected,
    contactCount: contactStore.size,
  };
}

/** Check if WhatsApp socket is connected and ready to send messages. */
export function isWhatsAppConnected(): boolean {
  return isConnected && !!sock;
}

export async function startWhatsApp(
  onMessage: MessageHandler,
  onObservation?: ObservationHandler,
): Promise<void> {
  const ownerJid = `${process.env.OWNER_PHONE}@s.whatsapp.net`;
  // Owner LID will be set from credentials after auth state is loaded
  let ownerLid: string | null = null;

  // Clean up previous socket if it exists
  if (sock) {
    try {
      sock.end(undefined);
    } catch (err) {
      log(`Failed to close previous socket: ${err}`);
    }
  }
  isConnected = false;

  const authDir = process.env.AUTH_STATE_DIR || "./auth_state";
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  // Detect owner LID from stored credentials (strip device suffix for matching)
  const credLid = (state.creds.me as { lid?: string } | undefined)?.lid;
  if (credLid) {
    ownerLid = normalizeJid(credLid);
    log.info(`Owner LID from credentials: ${ownerLid}`);
  }

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
  });

  sock.ev.on("creds.update", saveCreds);

  // --- Contact sync ---
  loadContacts();

  sock.ev.on("contacts.upsert", (contacts) => {
    let added = 0;
    for (const c of contacts) {
      const existing = contactStore.get(c.id);
      contactStore.set(c.id, { ...existing, ...c });
      added++;
    }
    log.info(`contacts.upsert: ${added} contacts`);
    saveContacts();
  });

  sock.ev.on("contacts.update", (updates) => {
    let updated = 0;
    for (const u of updates) {
      const existing = contactStore.get(u.id!);
      if (existing) {
        contactStore.set(u.id!, { ...existing, ...u });
        updated++;
      } else {
        contactStore.set(u.id!, u as Contact);
        updated++;
      }
    }
    log.info(`contacts.update: ${updated} contacts`);
    saveContacts();
  });

  // Also capture messaging-history.set for initial sync
  sock.ev.on("messaging-history.set", ({ contacts }) => {
    if (!contacts?.length) return;
    for (const c of contacts) {
      const existing = contactStore.get(c.id);
      contactStore.set(c.id, { ...existing, ...c });
    }
    log.info(`messaging-history.set: ${contacts.length} contacts synced`);
    saveContacts();
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      qrcode.generate(qr, { small: true });
      log.info("Scan the QR code above with WhatsApp");
      log.info("Or visit http://<host>:3000/qr");
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      // Exponential backoff: 5s, 10s, 20s, 40s, 60s (max)
      const delay = Math.min(
        BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempt),
        MAX_RECONNECT_DELAY,
      );
      reconnectAttempt++;

      log.warn(
        `Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect} (attempt ${reconnectAttempt}, delay ${Math.round(delay / 1000)}s)`
      );

      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(onMessage, onObservation), delay);
      } else {
        log.error("Logged out. Delete auth_state/ and restart to re-scan QR.");
        log.info("Emitting logout event for graceful shutdown...");
        whatsappEvents.emit("logout");
        // Fallback: force exit after 5s if listeners haven't shut down
        setTimeout(() => {
          log.error("Graceful shutdown timeout (5s) — forcing exit.");
          process.exit(1);
        }, 5_000).unref();
      }
    } else if (connection === "open") {
      isConnected = true;
      reconnectAttempt = 0; // Reset backoff on successful connection
      log.info("Connected!");
    }
  });

  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid) continue;

      // Ignore status updates
      if (jid === "status@broadcast") continue;

      const isGroup = jid.endsWith("@g.us");

      // Extract text content from various message types
      const m = msg.message;
      const text =
        m?.conversation ||
        m?.extendedTextMessage?.text ||
        m?.imageMessage?.caption ||
        m?.videoMessage?.caption ||
        m?.buttonsResponseMessage?.selectedDisplayText ||
        m?.listResponseMessage?.title ||
        m?.templateButtonReplyMessage?.selectedDisplayText ||
        "";

      // Log all incoming messages for debugging (before any filtering)
      log.debug(`MSG jid=${jid} fromMe=${msg.key.fromMe} group=${isGroup} participant=${msg.key.participant || "N/A"} text=${text.slice(0, 50) || "(no text)"}`);

      // Update owner LID from credentials if not yet set (e.g. after reconnect)
      if (!ownerLid && sock?.user) {
        const lid = (sock.user as { lid?: string }).lid;
        if (lid) {
          ownerLid = normalizeJid(lid);
          log.info(`Owner LID from socket: ${ownerLid}`);
        }
      }

      // ── Multimodal: voice message transcription ──
      let mediaType: "voice" | "image" | "document" | undefined;
      let resolvedText = text;

      if (!resolvedText.trim() && m?.audioMessage) {
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {}) as Buffer;
          const mimetype = m.audioMessage.mimetype || "audio/ogg";
          const transcription = await transcribeAudio(buffer, mimetype);
          if (transcription) {
            resolvedText = `[voice] ${transcription}`;
            mediaType = "voice";
            log.info(`Transcribed voice message: ${transcription.slice(0, 80)}`);
          }
        } catch (err) {
          log(`Failed to process voice message: ${err}`);
        }
      }

      // ── Multimodal: image understanding ──
      if (!resolvedText.trim() && m?.imageMessage) {
        mediaType = "image";
        let description: string | null = null;
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {}) as Buffer;
          const mimetype = m.imageMessage.mimetype || "image/jpeg";
          const caption = m.imageMessage.caption || undefined;
          description = await describeImage(buffer, mimetype, caption);
        } catch (err) {
          log(`Failed to process image message: ${err}`);
        }
        // Defense in depth: re-check the description for refusal-style text in
        // case it slipped past describeImage's own guard.
        if (description && !isVisionRefusal(description)) {
          resolvedText = `[image] ${description}`;
          log.info(`Described image: ${description.slice(0, 80)}`);
        } else {
          // Caption failed (vision unavailable, refusal, error). Keep a neutral
          // marker so downstream reasoning sees an image arrived without
          // ingesting fabricated/refusal content as if the sender wrote it.
          resolvedText = "[image — caption failed]";
        }
      }

      if (!resolvedText.trim()) continue;

      // Deduplicate messages (Baileys can deliver same message via @lid and @s.whatsapp.net)
      const msgId = msg.key.id;
      if (msgId && processedMessages.has(msgId)) {
        log.debug(`Dedup skip: ${msgId} from ${jid}`);
        continue;
      }
      if (msgId) {
        processedMessages.set(msgId, Date.now());
      }

      // --- Observation: fire for ALL messages (groups, contacts, own) ---
      if (onObservation) {
        const senderName = msg.key.fromMe
          ? (process.env.OWNER_NAME || "Me")
          : (msg.pushName || jid.split("@")[0]);

        // For group messages, resolve group name
        let groupName: string | undefined;
        if (isGroup) {
          const cached = groupNameCache.get(jid);
          if (cached && (Date.now() - cached.cachedAt) < GROUP_CACHE_TTL) {
            groupName = cached.name;
          } else {
            if (cached) groupNameCache.delete(jid); // expired
            try {
              const meta = await sock.groupMetadata(jid);
              groupName = meta.subject;
              // Evict oldest entries if cache is full
              if (groupNameCache.size >= MAX_GROUP_CACHE_SIZE) {
                let oldestKey: string | undefined;
                let oldestTime = Infinity;
                for (const [key, val] of groupNameCache) {
                  if (val.cachedAt < oldestTime) {
                    oldestTime = val.cachedAt;
                    oldestKey = key;
                  }
                }
                if (oldestKey) groupNameCache.delete(oldestKey);
              }
              groupNameCache.set(jid, { name: groupName, cachedAt: Date.now() });
            } catch (err) {
              log(`Failed to fetch group metadata for ${jid}: ${err}`);
              groupName = jid.split("@")[0];
            }
          }
        }

        // senderJid should always be the actual sender's JID
        let senderJid: string;
        if (msg.key.fromMe) {
          senderJid = ownerJid; // Outgoing: sender is always the owner
        } else if (isGroup) {
          senderJid = msg.key.participant || jid;
        } else {
          senderJid = jid; // Incoming DM: remote JID is the sender
        }

        // Resolve the chat identity: for DMs the counterpart, for groups the
        // group itself (@g.us JID) — downstream consumers (frequency tracking,
        // observe-tick reinforcement, group-scoped directives, reply targeting)
        // key on chatJid to identify the conversation.
        let chatJid: string | undefined;
        let chatName: string | undefined;
        if (!isGroup) {
          chatJid = jid; // remoteJid is always the other party in a DM
          const contact = contactStore.get(jid);
          chatName = contact?.notify || contact?.name || jid.split("@")[0];
        } else {
          chatJid = jid; // the group's @g.us JID
          chatName = groupName;
        }

        try {
          onObservation({
            senderName,
            senderJid,
            isGroup,
            groupName,
            isFromMe: msg.key.fromMe ?? false,
            text: resolvedText,
            chatJid,
            chatName,
            mediaType,
          });
        } catch (err) {
          log.error(`Observation handler error: ${err}`);
        }
      }

      // --- Direct command handling: owner only, non-group ---
      if (isGroup) continue;

      const matchesJid = jid === ownerJid;
      const matchesLid = ownerLid !== null && jid === ownerLid;
      const isOwner = matchesJid || matchesLid;

      log.debug(`DM check: jid=${jid} ownerJid=${ownerJid} ownerLid=${ownerLid || "unset"} fromMe=${msg.key.fromMe} matchJid=${matchesJid} matchLid=${matchesLid} → isOwner=${isOwner}`);

      if (!isOwner) {
        log.debug(`Skipping non-owner DM from: ${jid}`);
        continue;
      }

      log.info(`Processing owner message: ${resolvedText.slice(0, 100)}`);

      // Always reply to owner's @s.whatsapp.net JID (LID replies may not deliver)
      await onMessage(ownerJid, resolvedText, msg);
    }
  });
}

/** Force a contact sync via Baileys app state resync. */
export async function syncContacts(): Promise<void> {
  if (!sock) {
    log.warn("syncContacts: socket not ready");
    return;
  }
  log.info("Triggering contact sync via resyncAppState...");
  await sock.resyncAppState(["regular_high", "regular_low"], false);
  log.info("Contact sync triggered, waiting for events...");
}

export async function sendMessage(jid: string, text: string): Promise<void> {
  if (!isConnected) {
    log.warn("Cannot send message — not connected");
    throw new Error("WhatsApp not connected");
  }

  // Outgoing dedup: prevent duplicate sends within 5 minutes (mirrors incoming dedup pattern)
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const dedupKey = `${jid}|${hash}`;
  if (sentMessages.has(dedupKey)) {
    log.debug(`Outgoing dedup skip: already sent to ${jid} (hash=${hash})`);
    return;
  }

  await sock.sendMessage(jid, { text });
  // Only record dedup AFTER a successful send — recording before meant a failed
  // send silently blocked retries for 5 minutes while callers assumed delivery.
  sentMessages.set(dedupKey, Date.now());
}

export async function sendImage(
  jid: string,
  imagePath: string,
  caption?: string,
): Promise<void> {
  if (!isConnected) {
    log.warn("Cannot send image — not connected");
    throw new Error("WhatsApp not connected");
  }

  const imageBuffer = readFileSync(imagePath);
  await sock.sendMessage(jid, {
    image: imageBuffer,
    caption: caption || undefined,
  });
  log.info(`Image sent to ${jid}: ${imagePath}`);
}

export async function sendTypingIndicator(jid: string): Promise<void> {
  if (!isConnected || !sock) return;
  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch (err) {
    log(`Failed to send typing indicator to ${jid}: ${err}`);
  }
}

export async function stopTypingIndicator(jid: string): Promise<void> {
  if (!isConnected || !sock) return;
  try {
    await sock.sendPresenceUpdate("paused", jid);
  } catch (err) {
    log(`Failed to stop typing indicator for ${jid}: ${err}`);
  }
}

export async function sendReaction(
  jid: string,
  messageKey: proto.IMessageKey | null | undefined,
  emoji: string
): Promise<void> {
  if (!isConnected || !messageKey) return; // Silently skip reactions when disconnected or no key
  await sock.sendMessage(jid, {
    react: { text: emoji, key: messageKey },
  });
}
