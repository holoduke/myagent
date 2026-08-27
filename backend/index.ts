import "dotenv/config";
import { createServer } from "http";
import { createLogger } from "./logger.js";
import { validateConfig, CLAUDE_TIMEOUT, WA_STARTUP_DELAY, OWNER_PHONE } from "./config.js";
import { startWhatsApp, sendMessage, sendReaction, sendTypingIndicator, stopTypingIndicator, getLatestQr } from "./integrations/whatsapp.js";
import { MessageQueue } from "./queue.js";
import { handleWebRoutes } from "./web.js";
import { startTokenRefreshLoop } from "./auth-refresh.js";
import { recordObservation } from "./observer.js";
import { startBrainLoop, stopBrainLoop, getBrainHealth } from "./brain.js";
import { startGmailPolling, stopGmailPolling, getAccountStatus } from "./integrations/gmail.js";
import { handleGmailRoutes } from "./integrations/gmail-routes.js";
import { startCalendarPolling, stopCalendarPolling } from "./integrations/calendar.js";
import { startHAPolling, stopHAPolling } from "./integrations/homeassistant.js";
import { startRSSPolling, stopRSSPolling } from "./integrations/rss.js";
import { startPlayStorePolling, stopPlayStorePolling } from "./integrations/playstore-poll.js";
import { startSlackPolling, stopSlackPolling } from "./integrations/slack.js";
import { handleSlackRoutes } from "./integrations/slack-routes.js";
import { handleOwnTracksWebhook } from "./integrations/owntracks.js";
import { initReplyAgent } from "./reply-agent.js";
import { initMessageHandlers } from "./message-handlers.js";
import { initBrowser, closeBrowser } from "./integrations/browser.js";
import { handleTwiml, handleTurn, handleStatus as handleTwilioStatus } from "./integrations/twilio.js";
import { createOwnerHandler } from "./owner-handler.js";
import { bootstrapDefaultProvider } from "./providers/index.js";

const queue = new MessageQueue();
const log = createLogger("index");
const startedAt = Date.now();

// ── Service Lifecycle ──

function cleanupServices(): void {
  stopBrainLoop();
  stopGmailPolling();
  stopSlackPolling();
  stopCalendarPolling();
  stopHAPolling();
  stopRSSPolling();
  stopPlayStorePolling();
  closeBrowser();
}

async function main() {
  validateConfig();

  const ownerPhone = OWNER_PHONE;

  // Bootstrap default provider profile on first boot
  bootstrapDefaultProvider();

  // Start background OAuth token refresh loop
  startTokenRefreshLoop();

  // Start autonomous brain loop
  startBrainLoop(queue, sendMessage);

  // Initialize reply agent (auto-reply system)
  initReplyAgent(sendMessage);

  // Initialize message handlers (user-defined filters)
  initMessageHandlers(sendMessage);

  // Start integration pollers
  startGmailPolling();
  startCalendarPolling();
  startHAPolling();
  startRSSPolling();
  startSlackPolling();
  startPlayStorePolling();

  // Initialize browser automation (lazy — launches on first task)
  initBrowser();

  // ── HTTP server ──
  const server = createServer((req, res) => {
    // Security headers
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "script-src 'none'; frame-ancestors 'none';");

    if (handleWebRoutes(req, res, queue)) return;
    if (handleGmailRoutes(req, res)) return;
    if (handleSlackRoutes(req, res)) return;

    // Twilio webhooks (public endpoints)
    if (req.url?.startsWith("/twilio/twiml") && req.method === "POST") { handleTwiml(req, res); return; }
    if (req.url?.startsWith("/twilio/turn") && req.method === "POST") { handleTurn(req, res); return; }
    if (req.url?.startsWith("/twilio/status") && req.method === "POST") { handleTwilioStatus(req, res); return; }

    // OwnTracks webhook (public endpoint)
    if (req.url === "/owntracks" && req.method === "POST") { handleOwnTracksWebhook(req, res); return; }

    // Public status endpoint — uses cached stats from BrainState, no file I/O
    if (req.url === "/status") {
      const health = getBrainHealth();
      const uptime = Date.now() - startedAt;
      const uptimeHours = Math.floor(uptime / 3600000);
      const uptimeMinutes = Math.floor((uptime % 3600000) / 60000);
      const gmailAccounts = getAccountStatus();

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
          nodes: health.nodeCount,
          edges: health.edgeCount,
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

    // Default: health endpoint with brain status
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
      cleanupServices();
      process.exit(1);
    }
    log(`HTTP server error: ${err.message}`);
  });

  server.listen(3000, () => log.info("Health check on :3000"));

  log.info("Starting WhatsApp Claude Agent");
  log.info(`Owner phone: ${ownerPhone}`);
  log.info(`Claude timeout: ${CLAUDE_TIMEOUT}ms`);

  // Delay WhatsApp connection to let health check pass first.
  // During rolling deploys, Coolify stops the old container after the new one is healthy.
  // This prevents two containers from competing for the same WhatsApp session.
  if (WA_STARTUP_DELAY > 0) {
    log.info(`Waiting ${WA_STARTUP_DELAY / 1000}s before connecting WhatsApp (deploy safety)...`);
    await new Promise((r) => setTimeout(r, WA_STARTUP_DELAY));
  }

  const ownerHandler = createOwnerHandler({
    sendMessage, sendReaction, sendTypingIndicator, stopTypingIndicator,
  });

  await startWhatsApp(
    (jid, text, message) => queue.add(() => ownerHandler(jid, text, message)),
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

// ── Graceful Shutdown ──

function shutdown() {
  log.info("Shutting down...");
  cleanupServices();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}\n${err.stack || ""}`);
  cleanupServices();
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  log(`Unhandled rejection: ${err}`);
});

main().catch((err) => {
  log.error(`Fatal error: ${err}`);
  process.exit(1);
});
