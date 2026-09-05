import "dotenv/config";
import { createServer } from "http";
import { createLogger } from "./logger.js";
import { validateConfig, CLAUDE_TIMEOUT, WA_STARTUP_DELAY, OWNER_PHONE, SHUTDOWN_DRAIN_MS } from "./config.js";
import { getLatestQr, whatsappEvents } from "./integrations/whatsapp.js";
import { handleWebRoutes } from "./web.js";
import { getBrainHealth } from "./brain.js";
import { getAccountStatus } from "./integrations/gmail.js";
import { handleGmailRoutes } from "./integrations/gmail-routes.js";
import { handleHAEventWebhook, handleHACommandsPull } from "./integrations/ha-webhook.js";
import { handleTtsAudio } from "./ha-voice.js";
import { handleSlackRoutes } from "./integrations/slack-routes.js";
import { handleOwnTracksWebhook } from "./integrations/owntracks.js";
import { handleTwiml, handleTurn, handleStatus as handleTwilioStatus } from "./integrations/twilio.js";
import { bootstrapDefaultProvider } from "./providers/index.js";
import { createInstanceLease } from "./instance-lease.js";
import { createRuntime } from "./runtime.js";

const log = createLogger("index");
const startedAt = Date.now();
const HTTP_PORT = 3000;
// Hard exit guard: drain deadline plus a margin for socket close + lease release.
const SHUTDOWN_HARD_EXIT_MS = SHUTDOWN_DRAIN_MS + 5_000;
// After a WhatsApp "session replaced" demotion, wait before re-acquiring the
// lease so two instances cannot ping-pong the session every few seconds.
const REPLACED_REACQUIRE_DELAY_MS = 30_000;

const lease = createInstanceLease();
const runtime = createRuntime({ lease });
const queue = runtime.queue;

// ── Lease acquisition ──

/**
 * Become ACTIVE as soon as the lease allows. A lock that never existed means
 * the previous container predates the lease; give it WA_STARTUP_DELAY to die.
 */
async function acquireAndActivate(): Promise<void> {
  if (lease.inspect() === "none" && WA_STARTUP_DELAY > 0) {
    log.info(`No instance lock found — legacy grace period of ${WA_STARTUP_DELAY / 1000}s before activating`);
    await new Promise((r) => setTimeout(r, WA_STARTUP_DELAY));
  }
  if (lease.tryAcquire()) {
    await runtime.activate("lease acquired on boot");
    return;
  }
  log.info(`Another instance holds the lease — running PASSIVE (HTTP only) until it releases`);
  runtime.passive("lease held by another instance");
  await waitThenActivate();
}

async function waitThenActivate(): Promise<void> {
  const outcome = await lease.waitForLease();
  if (outcome === "cancelled") {
    log.info("Lease wait cancelled (shutting down)");
    return;
  }
  await runtime.activate(`lease ${outcome}`);
}

// ── HTTP ──

function writeJson(res: import("http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleStatus(res: import("http").ServerResponse): void {
  const health = getBrainHealth();
  const uptime = Date.now() - startedAt;
  const gmailAccounts = getAccountStatus();
  writeJson(res, 200, {
    name: "ARIA",
    version: "1.0.0",
    status: health.healthy ? "operational" : "degraded",
    mode: runtime.mode,
    uptime: `${Math.floor(uptime / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m`,
    uptimeMs: uptime,
    brain: {
      healthy: health.healthy,
      consecutiveFailures: health.consecutiveFailures,
      pendingSelfMod: health.pendingSelfMod,
      lastSuccessfulTick: health.lastSuccessfulTick,
      lastTickFailure: health.lastTickFailure,
    },
    memory: { nodes: health.nodeCount, edges: health.edgeCount },
    queue: { depth: queue.size, processing: queue.isProcessing },
    gmail: {
      accounts: gmailAccounts.length,
      authenticated: gmailAccounts.filter(a => a.authenticated).length,
    },
    timestamp: Date.now(),
  });
}

function handleQr(res: import("http").ServerResponse): void {
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
}

/** Public webhooks (Twilio, OwnTracks, Home Assistant). Returns true when handled. */
function handlePublicWebhooks(req: import("http").IncomingMessage, res: import("http").ServerResponse): boolean {
  const url = req.url ?? "";
  const isPost = req.method === "POST";
  const isGet = req.method === "GET";

  if (isPost && url.startsWith("/twilio/twiml")) { handleTwiml(req, res); return true; }
  if (isPost && url.startsWith("/twilio/turn")) { handleTurn(req, res); return true; }
  if (isPost && url.startsWith("/twilio/status")) { handleTwilioStatus(req, res); return true; }
  if (isPost && url === "/owntracks") { handleOwnTracksWebhook(req, res); return true; }
  // Home Assistant (shared-token auth)
  if (isPost && url === "/homeassistant/event") { void handleHAEventWebhook(req, res); return true; }
  if (isGet && url.startsWith("/homeassistant/commands")) { handleHACommandsPull(req, res); return true; }
  if (isGet && url.startsWith("/homeassistant/tts/")) { handleTtsAudio(req, res); return true; }
  return false;
}

function createHttpServer() {
  return createServer((req, res) => {
    // Security headers
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "script-src 'none'; frame-ancestors 'none';");

    // Liveness (Docker HEALTHCHECK curls "/"): 200 whenever the process is
    // up, including PASSIVE mode — Coolify must consider the new container
    // healthy so it can stop the old one and hand over the lease. Must come
    // before the web router, which also answers "/".
    if (req.url === "/" || req.url === "/health") { handleLiveness(res); return; }

    // Brain readiness: 503 while the brain circuit breaker is open.
    if (req.url === "/health/brain") { handleBrainHealth(res); return; }

    if (handleWebRoutes(req, res, queue)) return;
    if (handleGmailRoutes(req, res)) return;
    if (handleSlackRoutes(req, res)) return;
    if (handlePublicWebhooks(req, res)) return;

    // Public status endpoint — uses cached stats from BrainState, no file I/O
    if (req.url === "/status") { handleStatus(res); return; }
    if (req.url === "/qr") { handleQr(res); return; }

    handleLiveness(res);
  });
}

function handleLiveness(res: import("http").ServerResponse): void {
  writeJson(res, 200, {
    name: "ARIA Backend API",
    status: "ok",
    mode: runtime.mode,
    instanceId: lease.instanceId,
    uptimeMs: Date.now() - startedAt,
  });
}

function handleBrainHealth(res: import("http").ServerResponse): void {
  const health = getBrainHealth();
  writeJson(res, health.healthy ? 200 : 503, {
    status: health.healthy ? "ok" : "unhealthy",
    mode: runtime.mode,
    brain: health,
  });
}

// ── Main ──

async function main() {
  validateConfig();
  bootstrapDefaultProvider();

  const server = createHttpServer();
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(`Port ${HTTP_PORT} already in use — exiting so process manager can restart cleanly`);
      void shutdown("EADDRINUSE", 1);
      return;
    }
    log.error(`HTTP server error: ${err.message}`);
  });
  server.listen(HTTP_PORT, () => log.info(`Health check on :${HTTP_PORT}`));

  log.info("Starting WhatsApp Claude Agent");
  log.info(`Owner phone: ${OWNER_PHONE}`);
  log.info(`Claude timeout: ${CLAUDE_TIMEOUT}ms`);
  log.info(`Instance ${lease.instanceId} pid ${process.pid}`);

  whatsappEvents.on("replaced", () => {
    runtime.demote("whatsapp session replaced by another client")
      .then(() => new Promise((r) => setTimeout(r, REPLACED_REACQUIRE_DELAY_MS)))
      .then(() => { if (!shuttingDown) return waitThenActivate(); })
      .catch((err) => log.error(`Demotion failed: ${err}`));
  });
  whatsappEvents.on("logout", () => { void shutdown("whatsapp logout", 1); });

  await acquireAndActivate();
}

// ── Graceful Shutdown ──

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Shutting down (${signal})...`);
  const hardExit = setTimeout(() => {
    log.error(`Shutdown exceeded ${SHUTDOWN_HARD_EXIT_MS}ms — forcing exit`);
    process.exit(exitCode || 1);
  }, SHUTDOWN_HARD_EXIT_MS);
  hardExit.unref();
  try {
    await runtime.shutdown(signal);
  } catch (err) {
    log.error(`Shutdown error: ${err}`);
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${err.message}\n${err.stack || ""}`);
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (err) => {
  log.error(`Unhandled rejection: ${err}`);
});

main().catch((err) => {
  log.error(`Fatal error: ${err}`);
  void shutdown("fatal", 1);
});
