import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  proto,
  Contact,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
// @ts-ignore - no types available
import qrcode from "qrcode-terminal";
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";

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
}

export type ObservationHandler = (obs: ObservationEvent) => void;

const logger = pino({ level: "silent" });

let sock: ReturnType<typeof makeWASocket>;
let latestQr: string | null = null;
let isConnected = false;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY = 60_000; // 60s max
const BASE_RECONNECT_DELAY = 5_000; // 5s base
const processedMessages = new Set<string>();
const groupNameCache = new Map<string, string>();

// --- Contact store ---
const CONTACTS_PATH = process.env.DATA_DIR
  ? `${process.env.DATA_DIR}/brain/contacts.json`
  : "/data/brain/contacts.json";

const contactStore = new Map<string, Contact>();

function loadContacts(): void {
  if (!existsSync(CONTACTS_PATH)) return;
  try {
    const data = JSON.parse(readFileSync(CONTACTS_PATH, "utf-8")) as Contact[];
    for (const c of data) {
      contactStore.set(c.id, c);
    }
    console.log(`[whatsapp] Loaded ${contactStore.size} contacts from disk`);
  } catch (err) {
    console.error("[whatsapp] Failed to load contacts:", err);
  }
}

function saveContacts(): void {
  const tmp = CONTACTS_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(Array.from(contactStore.values()), null, 2));
  renameSync(tmp, CONTACTS_PATH);
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
    } catch {
      // Socket may already be closed
    }
  }
  isConnected = false;

  const authDir = process.env.AUTH_STATE_DIR || "./auth_state";
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  // Detect owner LID from stored credentials (strip device suffix for matching)
  const credLid = (state.creds.me as { lid?: string } | undefined)?.lid;
  if (credLid) {
    ownerLid = credLid.replace(/:\d+@/, "@");
    console.log(`[whatsapp] Owner LID from credentials: ${ownerLid}`);
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
    console.log(`[whatsapp] contacts.upsert: ${added} contacts`);
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
    console.log(`[whatsapp] contacts.update: ${updated} contacts`);
    saveContacts();
  });

  // Also capture messaging-history.set for initial sync
  sock.ev.on("messaging-history.set", ({ contacts }) => {
    if (!contacts?.length) return;
    for (const c of contacts) {
      const existing = contactStore.get(c.id);
      contactStore.set(c.id, { ...existing, ...c });
    }
    console.log(`[whatsapp] messaging-history.set: ${contacts.length} contacts synced`);
    saveContacts();
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      qrcode.generate(qr, { small: true });
      console.log("[whatsapp] Scan the QR code above with WhatsApp");
      console.log(`[whatsapp] Or visit http://<host>:3000/qr`);
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

      console.log(
        `[whatsapp] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect} (attempt ${reconnectAttempt}, delay ${Math.round(delay / 1000)}s)`
      );

      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(onMessage, onObservation), delay);
      } else {
        console.error("[whatsapp] Logged out. Delete auth_state/ and restart to re-scan QR.");
        process.exit(1);
      }
    } else if (connection === "open") {
      isConnected = true;
      reconnectAttempt = 0; // Reset backoff on successful connection
      console.log("[whatsapp] Connected!");
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
      console.log(`[whatsapp] MSG jid=${jid} fromMe=${msg.key.fromMe} group=${isGroup} participant=${msg.key.participant || "N/A"} text=${text.slice(0, 50) || "(no text)"}`);

      // Update owner LID from credentials if not yet set (e.g. after reconnect)
      if (!ownerLid && sock?.user) {
        const lid = (sock.user as { lid?: string }).lid;
        if (lid) {
          ownerLid = lid.replace(/:\d+@/, "@");
          console.log(`[whatsapp] Owner LID from socket: ${ownerLid}`);
        }
      }

      if (!text.trim()) continue;

      // Deduplicate messages (Baileys can deliver same message via @lid and @s.whatsapp.net)
      const msgId = msg.key.id;
      if (msgId && processedMessages.has(msgId)) {
        console.log(`[whatsapp] Dedup skip: ${msgId} from ${jid}`);
        continue;
      }
      if (msgId) {
        processedMessages.add(msgId);
        setTimeout(() => processedMessages.delete(msgId), 5 * 60 * 1000);
      }

      // --- Observation: fire for ALL messages (groups, contacts, own) ---
      if (onObservation) {
        const senderName = msg.key.fromMe
          ? (process.env.OWNER_NAME || "Me")
          : (msg.pushName || jid.split("@")[0]);

        // For group messages, resolve group name
        let groupName: string | undefined;
        if (isGroup) {
          groupName = groupNameCache.get(jid);
          if (!groupName) {
            try {
              const meta = await sock.groupMetadata(jid);
              groupName = meta.subject;
              groupNameCache.set(jid, groupName);
            } catch {
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

        // For DMs, resolve the chat counterpart's name
        let chatJid: string | undefined;
        let chatName: string | undefined;
        if (!isGroup) {
          chatJid = jid; // remoteJid is always the other party in a DM
          const contact = contactStore.get(jid);
          chatName = contact?.notify || contact?.name || jid.split("@")[0];
        }

        try {
          onObservation({
            senderName,
            senderJid,
            isGroup,
            groupName,
            isFromMe: msg.key.fromMe ?? false,
            text,
            chatJid,
            chatName,
          });
        } catch (err) {
          console.error("[whatsapp] Observation handler error:", err);
        }
      }

      // --- Direct command handling: owner only, non-group ---
      if (isGroup) continue;

      const matchesJid = jid === ownerJid;
      const matchesLid = ownerLid !== null && jid === ownerLid;
      const isOwner = matchesJid || matchesLid;

      console.log(`[whatsapp] DM check: jid=${jid} ownerJid=${ownerJid} ownerLid=${ownerLid || "unset"} fromMe=${msg.key.fromMe} matchJid=${matchesJid} matchLid=${matchesLid} → isOwner=${isOwner}`);

      if (!isOwner) {
        console.log(`[whatsapp] Skipping non-owner DM from: ${jid}`);
        continue;
      }

      console.log(`[whatsapp] Processing owner message: ${text.slice(0, 100)}`);

      // Always reply to owner's @s.whatsapp.net JID (LID replies may not deliver)
      await onMessage(ownerJid, text, msg);
    }
  });
}

/** Force a contact sync via Baileys app state resync. */
export async function syncContacts(): Promise<void> {
  if (!sock) {
    console.log("[whatsapp] syncContacts: socket not ready");
    return;
  }
  console.log("[whatsapp] Triggering contact sync via resyncAppState...");
  await sock.resyncAppState(["regular_high", "regular_low"], false);
  console.log("[whatsapp] Contact sync triggered, waiting for events...");
}

export async function sendMessage(jid: string, text: string): Promise<void> {
  if (!isConnected) {
    console.log(`[whatsapp] Cannot send message — not connected`);
    throw new Error("WhatsApp not connected");
  }
  await sock.sendMessage(jid, { text });
}

export async function sendReaction(
  jid: string,
  messageKey: proto.IMessageKey,
  emoji: string
): Promise<void> {
  if (!isConnected) return; // Silently skip reactions when disconnected
  await sock.sendMessage(jid, {
    react: { text: emoji, key: messageKey },
  });
}
