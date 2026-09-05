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
import {
  describeImageDetailed,
  isVisionRefusal,
  logCaptionFailure,
  type CaptionFailureReason,
} from "../utils/vision.js";
import { normalizeJid, invalidateJidAliasMap } from "./jid-alias.js";
import { logDelivery } from "../scheduler.js";
import { OutboundBuffer } from "./outbound-buffer.js";

// Emits 'logout' when WhatsApp session is logged out and 'replaced' when
// another client took over the session (Baileys code 440 — during a rolling
// deploy that is the new container). Listeners decide what to do next.
export const whatsappEvents = new EventEmitter();

export interface SendResult {
  /** sent: delivered to the socket; buffered: socket down, queued for the
   *  next `open`; deduped: identical text sent to this JID within 5 min. */
  status: "sent" | "buffered" | "deduped";
}

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
  /** WhatsApp message id — stable dedup/reply key across restarts. */
  messageId?: string;
}

export type ObservationHandler = (obs: ObservationEvent) => void;

const logger = pino({ level: "silent" });
const log = createLogger("whatsapp");

let sock: ReturnType<typeof makeWASocket>;
let latestQr: string | null = null;
let isConnected = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Set by stopWhatsApp() (shutdown / demotion) and on connectionReplaced so the
// close handler never schedules a reconnect that would fight the other side.
let stopping = false;
const MAX_RECONNECT_DELAY = 60_000; // 60s max
const BASE_RECONNECT_DELAY = 5_000; // 5s base
// Owner-bound messages that arrive while the socket is down wait here and
// are flushed, in order, on the next `connection === "open"`.
const outbound = new OutboundBuffer();
// Owner-DM stub/undecryptable fallback, throttled so a burst of bad-MAC
// retries doesn't spam the owner.
const STUB_FALLBACK_TEXT = "Ik kon je laatste bericht niet lezen, stuur het nog eens";
const STUB_FALLBACK_INTERVAL_MS = 5 * 60 * 1000;
let lastStubFallbackAt = 0;

function getOwnerJid(): string {
  return `${process.env.OWNER_PHONE}@s.whatsapp.net`;
}
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

/**
 * Close the socket and suppress reconnects. Used on SIGTERM and when this
 * instance is demoted to passive. `startWhatsApp` re-arms everything.
 */
export function stopWhatsApp(): void {
  stopping = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  isConnected = false;
  if (sock) {
    try {
      sock.end(undefined);
    } catch (err) {
      log(`Failed to close socket on stop: ${err}`);
    }
  }
  log.info("WhatsApp stopped");
}

// ── Connection lifecycle helpers ──

function scheduleReconnect(onMessage: MessageHandler, onObservation?: ObservationHandler): void {
  // Exponential backoff: 5s, 10s, 20s, 40s, 60s (max)
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY);
  reconnectAttempt++;
  log.warn(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsApp(onMessage, onObservation).catch((err) => log.error(`Reconnect failed: ${err}`));
  }, delay);
}

function handleConnectionReplaced(): void {
  // Another client (the replacement container during a rolling deploy) took
  // the session. Reconnecting would only bounce it back and forth.
  stopping = true;
  log.warn("Connection REPLACED by another client (code 440) — not reconnecting; releasing to the replacement");
  whatsappEvents.emit("replaced");
}

function handleLoggedOut(): void {
  log.error("Logged out. Delete auth_state/ and restart to re-scan QR.");
  log.info("Emitting logout event for graceful shutdown...");
  whatsappEvents.emit("logout");
  // Fallback: force exit after 5s if listeners haven't shut down
  setTimeout(() => {
    log.error("Graceful shutdown timeout (5s) — forcing exit.");
    process.exit(1);
  }, 5_000).unref();
}

function handleConnectionClose(
  statusCode: number | undefined,
  onMessage: MessageHandler,
  onObservation?: ObservationHandler,
): void {
  isConnected = false;
  log.warn(`Connection closed (code: ${statusCode ?? "unknown"})`);
  if (stopping) {
    log.info("Socket closed while stopping — no reconnect");
    return;
  }
  if (statusCode === DisconnectReason.connectionReplaced) {
    handleConnectionReplaced();
    return;
  }
  if (statusCode === DisconnectReason.loggedOut) {
    handleLoggedOut();
    return;
  }
  scheduleReconnect(onMessage, onObservation);
}

/** Look up a friendly stub-type name for logs. */
function stubTypeName(stubType: number): string {
  const name = (proto.WebMessageInfo.StubType as Record<number, string | undefined>)[stubType];
  return name ? `${name}(${stubType})` : `#${stubType}`;
}

/**
 * A message without readable content but with a stub type — most often
 * CIPHERTEXT, i.e. Baileys could not decrypt it (typical right after a
 * session swap). Owner DMs get a short fallback so the owner can resend.
 */
async function handleStubMessage(msg: proto.IWebMessageInfo, jid: string, isOwnerDm: boolean): Promise<void> {
  const stubType = msg.messageStubType as number;
  const params = msg.messageStubParameters?.join(", ") || "";
  const detail = `stub=${stubTypeName(stubType)} jid=${jid} id=${msg.key.id ?? "?"}${params ? ` params=${params}` : ""}`;
  if (!isOwnerDm) {
    log.warn(`Unreadable message: ${detail}`);
    return;
  }
  log.warn(`Unreadable OWNER message: ${detail}`);
  const now = Date.now();
  if (now - lastStubFallbackAt < STUB_FALLBACK_INTERVAL_MS) {
    log.debug("Stub fallback suppressed (sent within the last 5 min)");
    return;
  }
  lastStubFallbackAt = now;
  try {
    await sendMessage(getOwnerJid(), STUB_FALLBACK_TEXT, "system");
  } catch (err) {
    log.error(`Failed to send stub fallback to owner: ${err}`);
  }
}

export async function startWhatsApp(
  onMessage: MessageHandler,
  onObservation?: ObservationHandler,
): Promise<void> {
  const ownerJid = getOwnerJid();
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
  stopping = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

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
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      handleConnectionClose(statusCode, onMessage, onObservation);
    } else if (connection === "open") {
      isConnected = true;
      reconnectAttempt = 0; // Reset backoff on successful connection
      log.info("Connected!");
      void flushOutbound();
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
        const mimetype = m.imageMessage.mimetype || "image/jpeg";
        let description: string | null = null;
        let failureReason: CaptionFailureReason | undefined;
        let failureSnippet: string | undefined;
        let buffer: Buffer | null = null;
        try {
          buffer = await downloadMediaMessage(msg, "buffer", {}) as Buffer;
        } catch (err) {
          failureReason = "download-error";
          failureSnippet = String(err).slice(0, 120);
          log(`Failed to download image message: ${err}`);
        }
        if (buffer) {
          try {
            const caption = m.imageMessage.caption || undefined;
            const result = await describeImageDetailed(buffer, mimetype, caption);
            description = result.description;
            failureReason = result.failureReason;
            failureSnippet = result.failureSnippet;
          } catch (err) {
            failureReason = "exception";
            failureSnippet = String(err).slice(0, 120);
            log(`Failed to process image message: ${err}`);
          }
        }
        // Defense in depth: re-check the description for refusal-style text in
        // case it slipped past describeImage's own guard.
        if (description && !isVisionRefusal(description)) {
          resolvedText = `[image] ${description}`;
          log.info(`Described image: ${description.slice(0, 80)}`);
        } else {
          if (description) {
            failureReason = "late-refusal";
            failureSnippet = description.slice(0, 120);
          }
          if (!failureReason) failureReason = "empty-result";
          log(`Image caption failed (${failureReason})${failureSnippet ? `: ${failureSnippet}` : ""}`);
          logCaptionFailure({
            chatJid: jid,
            mimetype,
            reason: failureReason,
            snippet: failureSnippet,
          });
          // Caption failed (vision unavailable, refusal, error). Keep a neutral
          // marker so downstream reasoning sees an image arrived without
          // ingesting fabricated/refusal content as if the sender wrote it.
          resolvedText = "[image — caption failed]";
        }
      }

      const isOwnerChat = !isGroup && (jid === ownerJid || (ownerLid !== null && jid === ownerLid));

      if (!resolvedText.trim()) {
        if (msg.messageStubType) await handleStubMessage(msg, jid, isOwnerChat && !msg.key.fromMe);
        continue;
      }

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
        if (!isGroup && ownerLid !== null && jid === ownerLid) {
          // Owner DM delivered via the @lid alias: normalise to the canonical
          // owner JID so memory/frequency tracking sees one identity.
          senderJid = ownerJid;
          chatJid = ownerJid;
          const contact = contactStore.get(ownerJid);
          chatName = contact?.notify || contact?.name || process.env.OWNER_NAME || ownerJid.split("@")[0];
        } else if (!isGroup) {
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
            messageId: msg.key.id ?? undefined,
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

      // Always reply to owner's @s.whatsapp.net JID (LID replies may not deliver).
      // The handler must never abort this loop: the observation above already
      // happened, and the remaining messages in the batch still need it.
      try {
        await onMessage(ownerJid, resolvedText, msg);
      } catch (err) {
        log.error(`Owner message handler failed for ${msgId ?? "?"}: ${err}`);
      }
    }
  });
}

// ── Outbound ──

/** Actual socket send + delivery-log record. Caller has checked connectivity. */
async function deliver(jid: string, text: string, source: string): Promise<void> {
  await sock.sendMessage(jid, { text });
  // Every successful outbound send lands in delivery-log.json — the brain's
  // ground truth for delivery verification. A log failure must not mask a
  // delivery that already happened.
  try {
    logDelivery(jid, source, text);
  } catch (err) {
    log.warn(`Failed to record delivery in log (message WAS sent to ${jid}): ${err}`);
  }
}

/** Send everything buffered while the socket was down, oldest first. */
async function flushOutbound(): Promise<void> {
  const { ready, expired } = outbound.drain();
  if (expired.length > 0) log.warn(`Dropped ${expired.length} buffered owner message(s) older than the TTL`);
  if (ready.length === 0) return;
  log.info(`Flushing ${ready.length} buffered owner message(s)`);
  for (const [i, entry] of ready.entries()) {
    if (!isConnected) {
      // Socket dropped mid-flush: keep the rest for the next open.
      for (const rest of ready.slice(i)) outbound.push(rest);
      log.warn(`Flush interrupted — ${ready.length - i} message(s) re-buffered`);
      return;
    }
    try {
      await deliver(entry.jid, entry.text, entry.source);
    } catch (err) {
      log.error(`Failed to flush buffered message to ${entry.jid}: ${err}`);
    }
  }
}

function isDuplicateSend(jid: string, text: string): { duplicate: boolean; dedupKey: string } {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const dedupKey = `${jid}|${hash}`;
  return { duplicate: sentMessages.has(dedupKey), dedupKey };
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

export async function sendMessage(jid: string, text: string, source: string = "chat"): Promise<SendResult> {
  const isOwner = jid === getOwnerJid();

  if (!isConnected) {
    if (!isOwner) {
      log.warn("Cannot send message — not connected");
      throw new Error("WhatsApp not connected");
    }
    const { dropped } = outbound.push({ jid, text, source, queuedAt: Date.now() });
    if (dropped) log.warn(`Outbound buffer full — dropped oldest owner message ("${dropped.text.slice(0, 40)}")`);
    log.warn(`Not connected — buffered owner message (${outbound.size} waiting)`);
    return { status: "buffered" };
  }

  // Outgoing dedup: prevent duplicate sends within 5 minutes (mirrors the
  // incoming dedup pattern). Never applied to the owner: a repeated answer
  // ("ok", "done") to the owner is legitimate and must not vanish.
  const { duplicate, dedupKey } = isDuplicateSend(jid, text);
  if (!isOwner && duplicate) {
    log.debug(`Outgoing dedup skip: already sent to ${jid} (key=${dedupKey})`);
    return { status: "deduped" };
  }

  await deliver(jid, text, source);
  // Only record dedup AFTER a successful send — recording before meant a failed
  // send silently blocked retries for 5 minutes while callers assumed delivery.
  if (!isOwner) sentMessages.set(dedupKey, Date.now());
  return { status: "sent" };
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
