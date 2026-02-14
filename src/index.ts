import "dotenv/config";
import { startWhatsApp, sendMessage, sendReaction } from "./whatsapp.js";
import { askClaude } from "./claude.js";
import { MessageQueue } from "./queue.js";

const queue = new MessageQueue();

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
      // React with hourglass to show we're processing
      await sendReaction(jid, message.key, "\u23f3");

      try {
        console.log(`[agent] Processing: "${text.slice(0, 80)}"`);
        const responses = await askClaude(text);

        for (const chunk of responses) {
          await sendMessage(jid, chunk);
        }

        // React with checkmark when done
        await sendReaction(jid, message.key, "\u2705");
        console.log(`[agent] Responded with ${responses.length} message(s)`);
      } catch (err) {
        console.error("[agent] Error:", err);
        const errorMsg =
          err instanceof Error ? err.message : "Unknown error occurred";
        await sendMessage(jid, `Error: ${errorMsg}`);
        // React with X on failure
        await sendReaction(jid, message.key, "\u274c");
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

main().catch((err) => {
  console.error("[agent] Fatal error:", err);
  process.exit(1);
});
