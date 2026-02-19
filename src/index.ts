import "dotenv/config";
import { appendFileSync, readFileSync, existsSync } from "fs";
import { createServer } from "http";
import { startWhatsApp, sendMessage, sendReaction, getLatestQr } from "./whatsapp.js";
import { askClaude, resetSession } from "./claude.js";
import { MessageQueue } from "./queue.js";
import { handleWebRoutes } from "./web.js";
import { addMessage, clearHistory, getUsageStats } from "./history.js";
import { startTokenRefreshLoop } from "./auth-refresh.js";
import { recordObservation } from "./observer.js";
import { startBrainLoop, stopBrainLoop, getBrainHealth } from "./brain.js";
import { startGmailPolling, stopGmailPolling, getAccountStatus } from "./gmail.js";
import { handleGmailRoutes } from "./gmail-routes.js";
import { startCalendarPolling, stopCalendarPolling } from "./calendar.js";
import { startHAPolling, stopHAPolling } from "./homeassistant.js";
import { startRSSPolling, stopRSSPolling } from "./rss.js";
import { handleOwnTracksWebhook } from "./owntracks.js";

const queue = new MessageQueue();
const LOG_FILE = process.env.LOG_FILE || "./agent.log";
const startedAt = Date.now();

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

  // Start background OAuth token refresh loop
  startTokenRefreshLoop();

  // Start autonomous brain loop
  startBrainLoop(queue, sendMessage);

  // Start Gmail polling (if accounts configured)
  startGmailPolling();

  // Start new integration pollers
  startCalendarPolling();
  startHAPolling();
  startRSSPolling();

  // HTTP server: health check, QR code, web chat, and Gmail OAuth
  const server = createServer((req, res) => {
    // Security headers
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "script-src 'none'; frame-ancestors 'none';");

    // Web chat routes
    if (handleWebRoutes(req, res, queue)) return;

    // Gmail OAuth routes
    if (handleGmailRoutes(req, res)) return;

    // OwnTracks webhook (public endpoint)
    if (req.url === "/owntracks" && req.method === "POST") {
      handleOwnTracksWebhook(req, res);
      return;
    }

    // Public status endpoint (no auth needed)
    if (req.url === "/status") {
      const health = getBrainHealth();
      const uptime = Date.now() - startedAt;
      const uptimeHours = Math.floor(uptime / 3600000);
      const uptimeMinutes = Math.floor((uptime % 3600000) / 60000);
      const gmailAccounts = getAccountStatus();
      const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";

      let memoryNodeCount = 0;
      let memoryEdgeCount = 0;
      try {
        const nf = `${BRAIN_DIR}/graph/nodes.json`;
        const ef = `${BRAIN_DIR}/graph/edges.json`;
        if (existsSync(nf)) memoryNodeCount = Object.keys(JSON.parse(readFileSync(nf, "utf-8"))).length;
        if (existsSync(ef)) memoryEdgeCount = (JSON.parse(readFileSync(ef, "utf-8")) as unknown[]).length;
      } catch {}

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        name: "ARIA",
        version: "1.0.0",
        status: health.healthy ? "operational" : "degraded",
        uptime: `${uptimeHours}h ${uptimeMinutes}m`,
        uptimeMs: uptime,
        brain: {
          healthy: health.healthy,
          consecutiveFailures: health.consecutiveFailures,
          pendingSelfMod: health.pendingSelfMod,
          lastSuccessfulTick: health.lastSuccessfulTick,
        },
        memory: {
          nodes: memoryNodeCount,
          edges: memoryEdgeCount,
        },
        queue: {
          depth: queue.size,
          processing: queue.isProcessing,
        },
        gmail: {
          accounts: gmailAccounts.length,
          authenticated: gmailAccounts.filter(a => a.authenticated).length,
        },
        timestamp: Date.now(),
      }));
      return;
    }

    if (req.url === "/qr") {
      const qr = getLatestQr();
      if (!qr) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>No QR code available</h1><p>Already connected or waiting for QR generation.</p><script>setTimeout(()=>location.reload(),3000)</script>");
        return;
      }
      const qrEncoded = encodeURIComponent(qr);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>WhatsApp QR</title></head>
<body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111">
<div style="text-align:center"><h1 style="color:#25D366">Scan with WhatsApp</h1>
<img src="https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${qrEncoded}" alt="QR Code" style="border-radius:8px"/>
<p style="color:#aaa">Linked Devices &gt; Link a Device</p></div>
<script>setTimeout(()=>location.reload(),20000);</script></body></html>`);
      return;
    }
    // Health endpoint with brain status
    const health = getBrainHealth();
    const statusCode = health.healthy ? 200 : 503;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: health.healthy ? "ok" : "unhealthy",
      brain: health,
    }));
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log("Port 3000 already in use — exiting so process manager can restart cleanly");
      stopBrainLoop();
      stopGmailPolling();
      process.exit(1);
    }
    log(`HTTP server error: ${err.message}`);
  });

  server.listen(3000, () => console.log("[agent] Health check on :3000"));

  console.log(`[agent] Starting WhatsApp Claude Agent`);
  console.log(`[agent] Owner phone: ${ownerPhone}`);
  console.log(`[agent] Claude timeout: ${process.env.CLAUDE_TIMEOUT ?? 300000}ms`);

  // Delay WhatsApp connection to let health check pass first.
  // During rolling deploys, Coolify stops the old container after the new one is healthy.
  // This prevents two containers from competing for the same WhatsApp session.
  const startupDelay = Number(process.env.WA_STARTUP_DELAY ?? 40) * 1000;
  if (startupDelay > 0) {
    console.log(`[agent] Waiting ${startupDelay / 1000}s before connecting WhatsApp (deploy safety)...`);
    await new Promise((r) => setTimeout(r, startupDelay));
  }

  await startWhatsApp(
    // Owner message handler (direct responses)
    async (jid, text, message) => {
      await queue.add(async () => {
        log(`Received from ${jid}: "${text}"`);

        try {
          await sendReaction(jid, message.key, "\u23f3");
          log("Sent hourglass reaction");
        } catch (err) {
          log(`Failed to send reaction: ${err}`);
        }

        try {
          // Handle /reset command to start a fresh conversation
          if (text.trim().toLowerCase() === "/reset") {
            resetSession();
            clearHistory();
            await sendMessage(jid, "Session reset. Starting fresh conversation.");
            await sendReaction(jid, message.key, "\u2705");
            return;
          }

          // Handle /usage command
          if (text.trim().toLowerCase() === "/usage") {
            const stats = getUsageStats();
            await sendMessage(jid, stats);
            await sendReaction(jid, message.key, "\u2705");
            return;
          }

          // Save user message to history
          addMessage({ role: "user", content: text, timestamp: Date.now(), source: "whatsapp" });

          log(`Calling Claude with: "${text.slice(0, 80)}"`);
          const result = await askClaude(text);
          log(`Claude returned ${result.messages.length} chunk(s), first 200 chars: ${result.messages[0]?.slice(0, 200)}`);

          // Save assistant response to history
          addMessage({ role: "assistant", content: result.messages.join("\n"), timestamp: Date.now(), source: "whatsapp" });

          for (const chunk of result.messages) {
            log(`Sending chunk (${chunk.length} chars) to ${jid}`);
            await sendMessage(jid, chunk);
            log("Chunk sent successfully");
          }

          await sendReaction(jid, message.key, "\u2705");
          log(`Done - responded with ${result.messages.length} message(s)`);
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
    },
    // Observation handler (ALL messages → brain memory)
    (obs) => {
      recordObservation({
        timestamp: Date.now(),
        sender: obs.senderName,
        senderJid: obs.senderJid,
        isGroup: obs.isGroup,
        groupName: obs.groupName,
        isFromMe: obs.isFromMe,
        text: obs.text,
        source: "whatsapp",
        chatJid: obs.chatJid,
        chatName: obs.chatName,
      });
    },
  );
}

// Graceful shutdown
function shutdown() {
  console.log("\n[agent] Shutting down...");
  stopBrainLoop();
  stopGmailPolling();
  stopCalendarPolling();
  stopHAPolling();
  stopRSSPolling();
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
