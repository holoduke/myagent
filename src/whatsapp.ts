import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";

export type MessageHandler = (
  jid: string,
  text: string,
  message: proto.IWebMessageInfo
) => Promise<void>;

const logger = pino({ level: "silent" });

let sock: ReturnType<typeof makeWASocket>;

export async function startWhatsApp(onMessage: MessageHandler): Promise<void> {
  const ownerJid = `${process.env.OWNER_PHONE}@s.whatsapp.net`;

  const { state, saveCreds } = await useMultiFileAuthState("./auth_state");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("[whatsapp] Scan the QR code above with WhatsApp");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `[whatsapp] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        startWhatsApp(onMessage);
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
      // Ignore own messages
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid) continue;

      // Ignore group messages and status updates
      if (jid.endsWith("@g.us") || jid === "status@broadcast") continue;

      // Only respond to owner
      if (jid !== ownerJid) {
        console.log(`[whatsapp] Ignored message from non-owner: ${jid}`);
        continue;
      }

      // Extract text content
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      if (!text.trim()) {
        console.log("[whatsapp] Ignored non-text message");
        continue;
      }

      console.log(`[whatsapp] Message from owner: ${text.slice(0, 100)}`);

      await onMessage(jid, text, msg);
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
