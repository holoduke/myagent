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

const logger = pino({ level: "silent" });

let sock: ReturnType<typeof makeWASocket>;
let latestQr: string | null = null;
const processedMessages = new Set<string>();

export function getLatestQr(): string | null {
  return latestQr;
}

export async function startWhatsApp(onMessage: MessageHandler): Promise<void> {
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
        setTimeout(() => startWhatsApp(onMessage), 3000);
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

      // Ignore status updates and group messages
      if (jid === "status@broadcast" || jid.endsWith("@g.us")) continue;

      // Detect owner's LID on first fromMe message
      if (msg.key.fromMe && jid.endsWith("@lid") && !ownerLid) {
        ownerLid = jid;
        console.log(`[whatsapp] Detected owner LID: ${ownerLid}`);
      }

      // Accept messages from owner (classic JID or LID format)
      const isOwner = jid === ownerJid || jid === ownerLid || (msg.key.fromMe && jid.endsWith("@lid"));
      if (!isOwner) {
        console.log(`[whatsapp] Ignored non-owner: ${jid}`);
        continue;
      }

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

      if (!text.trim()) {
        console.log("[whatsapp] Ignored non-text message");
        continue;
      }

      // Deduplicate messages (Baileys can deliver same message via @lid and @s.whatsapp.net)
      const msgId = msg.key.id;
      if (msgId && processedMessages.has(msgId)) {
        console.log(`[whatsapp] Skipped duplicate message: ${msgId}`);
        continue;
      }
      if (msgId) {
        processedMessages.add(msgId);
        // Clean up old IDs after 5 minutes to prevent memory leak
        setTimeout(() => processedMessages.delete(msgId), 5 * 60 * 1000);
      }

      console.log(`[whatsapp] Message from owner: ${text.slice(0, 100)}`);

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
