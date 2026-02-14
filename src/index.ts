import "dotenv/config";
import { appendFileSync } from "fs";
import { startWhatsApp, sendMessage, sendReaction } from "./whatsapp.js";
import { askClaude } from "./claude.js";
import { MessageQueue } from "./queue.js";

const queue = new MessageQueue();
const LOG_FILE = process.env.LOG_FILE || "./agent.log";

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

async function main() {
  const ownerPhone = process.env.OWNER_PHONE;
  if (!ownerPhone) {
    console.error("OWNER_PHONE is not set in .env");
    process.exit(1);
  }

  console.log(`[agent] Starting WhatsApp Claude Agent`);
  console.log(`[agent] Owner phone: ${ownerPhone}`);
  console.log(`[agent] Claude timeout: ${process.env.CLAUDE_TIMEOUT ?? 300000}ms`);

  await startWhatsApp(async (jid, text, message) => {
    await queue.add(async () => {
      log(`Received from ${jid}: "${text}"`);

      try {
        await sendReaction(jid, message.key, "\u23f3");
        log("Sent hourglass reaction");
      } catch (err) {
        log(`Failed to send reaction: ${err}`);
      }

      try {
        log(`Calling Claude with: "${text.slice(0, 80)}"`);
        const responses = await askClaude(text);
        log(`Claude returned ${responses.length} chunk(s), first 200 chars: ${responses[0]?.slice(0, 200)}`);

        for (const chunk of responses) {
          log(`Sending chunk (${chunk.length} chars) to ${jid}`);
          await sendMessage(jid, chunk);
          log("Chunk sent successfully");
        }

        await sendReaction(jid, message.key, "\u2705");
        log(`Done - responded with ${responses.length} message(s)`);
      } catch (err) {
        log(`ERROR: ${err}`);
        const errorMsg =
          err instanceof Error ? err.message : "Unknown error occurred";
        try {
          await sendMessage(jid, `Error: ${errorMsg}`);
          await sendReaction(jid, message.key, "\u274c");
        } catch (sendErr) {
          log(`Failed to send error message: ${sendErr}`);
        }
      }
    });
  });
}

// Graceful shutdown
function shutdown() {
  console.log("\n[agent] Shutting down...");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}`);
});
process.on("unhandledRejection", (err) => {
  log(`Unhandled rejection: ${err}`);
});

main().catch((err) => {
  console.error("[agent] Fatal error:", err);
  process.exit(1);
});
