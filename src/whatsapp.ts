import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
// @ts-ignore - no types available
import qrcode from "qrcode-terminal";

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
}

export type ObservationHandler = (obs: ObservationEvent) => void;

const logger = pino({ level: "silent" });

let sock: ReturnType<typeof makeWASocket>;
let latestQr: string | null = null;
const processedMessages = new Set<string>();
const groupNameCache = new Map<string, string>();

export function getLatestQr(): string | null {
  return latestQr;
}

export async function startWhatsApp(
  onMessage: MessageHandler,
  onObservation?: ObservationHandler,
): Promise<void> {
  const ownerJid = `${process.env.OWNER_PHONE}@s.whatsapp.net`;
  let ownerLid: string | null = null;

  const authDir = process.env.AUTH_STATE_DIR || "./auth_state";
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      qrcode.generate(qr, { small: true });
      console.log("[whatsapp] Scan the QR code above with WhatsApp");
      console.log(`[whatsapp] Or visit http://<host>:3000/qr`);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `[whatsapp] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(onMessage, onObservation), 3000);
      } else {
        console.error("[whatsapp] Logged out. Delete auth_state/ and restart to re-scan QR.");
        process.exit(1);
      }
    } else if (connection === "open") {
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

      // Detect owner's LID early — before text filter, so non-text messages (images, reactions) also set it
      if (msg.key.fromMe && jid.endsWith("@lid") && !ownerLid) {
        ownerLid = jid;
        console.log(`[whatsapp] Detected owner LID: ${ownerLid}`);
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

        const senderJid = isGroup
          ? (msg.key.participant || jid)
          : jid;

        try {
          onObservation({
            senderName,
            senderJid,
            isGroup,
            groupName,
            isFromMe: msg.key.fromMe ?? false,
            text,
          });
        } catch (err) {
          console.error("[whatsapp] Observation handler error:", err);
        }
      }

      // --- Direct command handling: owner only, non-group ---
      if (isGroup) continue;

      const matchesJid = jid === ownerJid;
      const matchesLid = jid === ownerLid;
      const matchesFromMe = msg.key.fromMe === true && jid.endsWith("@lid");
      const isOwner = matchesJid || matchesLid || matchesFromMe;

      console.log(`[whatsapp] DM check: jid=${jid} ownerJid=${ownerJid} ownerLid=${ownerLid || "unset"} fromMe=${msg.key.fromMe} matchJid=${matchesJid} matchLid=${matchesLid} matchFromMe=${matchesFromMe} → isOwner=${isOwner}`);

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

export async function sendMessage(jid: string, text: string): Promise<void> {
  await sock.sendMessage(jid, { text });
}

export async function sendReaction(
  jid: string,
  messageKey: proto.IMessageKey,
  emoji: string
): Promise<void> {
  await sock.sendMessage(jid, {
    react: { text: emoji, key: messageKey },
  });
}
