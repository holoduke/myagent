import { IncomingMessage, ServerResponse } from "http";
import { addAccount, removeAccount } from "../integrations/gmail.js";
import { addWorkspace as addSlackWorkspace, removeWorkspace as removeSlackWorkspace } from "../integrations/slack.js";
import { getLatestQr } from "../integrations/whatsapp.js";
import { getPublicKey, addTarget, removeTarget, testConnection } from "../integrations/ssh.js";
import { getCalendarStatus, createEvent, listCalendars, loadCalendarConfig, saveCalendarConfig } from "../integrations/calendar.js";
import type { CalendarConfigEntry } from "../integrations/calendar.js";
import { getHAStatus, saveConfig, restartHAPolling, regenerateWebhookToken, DEFAULT_WEATHER_REFLEX, DEFAULT_MIND_REFLEX, loadConfig as loadHAConfig } from "../integrations/homeassistant.js";
import type { HAConfig, HAConnectionMode, HAWeatherReflexConfig, HAButtonRule, HASpeechConfig } from "../integrations/homeassistant.js";
import { testHAConnection, buildTtsCall, buildVolumeCall } from "../integrations/ha-client.js";
import { getRecentEvents } from "../integrations/ha-events.js";
import { getCommandQueue, dispatchCommand } from "../integrations/ha-commands.js";
import { testReflex } from "../ha-reflexes.js";
import { restartHADigestLoop } from "../ha-digest.js";
import { getRSSStatus, addFeed, removeFeed } from "../integrations/rss.js";
import { getOwnTracksStatus } from "../integrations/owntracks.js";
import { loadSnapshot, refreshSnapshot, isPlayStoreConfigured, getPlayStoreConfig } from "../integrations/playstore.js";
import { getTwilioStatus, makeSimpleCall, makeAgentCall, saveConfig as saveTwilioConfig, loadCallHistory } from "../integrations/twilio.js";
import { getBrowserStatus, clearBrowserHistory, runWorkflow, runSession, navigateTo, takeScreenshot, extractText } from "../integrations/browser.js";
import { requestCaptchaVerification, getPendingCaptchas, getCaptchaHistory } from "../captcha-verify.js";
import { saveIntegrationsConfig, isValidIntegrationKey } from "../integrations/integration-config.js";
import { getTrustConfig, saveTrustConfig } from "../trust.js";
import type { TrustConfig } from "../trust.js";
import { sendImage } from "../integrations/whatsapp.js";
import { readFileSync, existsSync } from "fs";
import { isAuthenticated } from "./auth.js";
import { respondJson, apiHandler, apiGetHandler, ApiError } from "../utils/api-helpers.js";
import { OWNER_PHONE } from "../config.js";

export function handleIntegrationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  // -- SSH public key --
  if (pathname === "/api/ssh/public-key" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, { publicKey: getPublicKey() });
    return true;
  }

  // -- SSH targets CRUD --
  if (pathname === "/api/ssh/targets" && isAuthenticated(req)) {
    if (req.method === "POST") {
      handleSSHAddTarget(req, res);
      return true;
    }
    if (req.method === "DELETE") {
      handleSSHRemoveTarget(req, res);
      return true;
    }
  }

  // -- SSH test connection --
  if (pathname === "/api/ssh/test" && req.method === "POST" && isAuthenticated(req)) {
    handleSSHTest(req, res);
    return true;
  }

  // -- Slack workspace CRUD --
  if (pathname === "/api/slack/workspaces" && isAuthenticated(req)) {
    if (req.method === "POST") {
      handleSlackAddWorkspace(req, res);
      return true;
    }
    if (req.method === "DELETE") {
      handleSlackRemoveWorkspace(req, res);
      return true;
    }
  }

  // -- Gmail account CRUD --
  if (pathname === "/api/gmail/accounts" && isAuthenticated(req)) {
    if (req.method === "POST") {
      handleGmailAddAccount(req, res);
      return true;
    }
    if (req.method === "DELETE") {
      handleGmailRemoveAccount(req, res);
      return true;
    }
  }

  // -- WhatsApp QR --
  if (pathname === "/api/whatsapp/qr" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, { qr: getLatestQr() });
    return true;
  }

  // -- Calendar status --
  if (pathname === "/api/calendar/status" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getCalendarStatus());
    return true;
  }

  // -- Calendar event creation --
  if (pathname === "/api/calendar/events" && req.method === "POST" && isAuthenticated(req)) {
    handleCalendarCreateEvent(req, res);
    return true;
  }

  // -- Calendar list (Google calendars from account) --
  if (pathname === "/api/calendar/calendars" && req.method === "GET" && isAuthenticated(req)) {
    handleCalendarList(req, res);
    return true;
  }

  // -- Calendar config (tag assignments) --
  if (pathname === "/api/calendar/config" && isAuthenticated(req)) {
    if (req.method === "GET") {
      respondJson(res, 200, loadCalendarConfig());
      return true;
    }
    if (req.method === "POST") {
      handleCalendarConfigSave(req, res);
      return true;
    }
  }

  // -- Home Assistant config CRUD --
  if (pathname === "/api/homeassistant/status" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getHAStatus());
    return true;
  }

  if (pathname === "/api/homeassistant/config" && isAuthenticated(req)) {
    if (req.method === "GET") {
      respondJson(res, 200, getHAStatus());
      return true;
    }
    if (req.method === "PUT") {
      handleHASaveConfig(req, res);
      return true;
    }
  }

  if (pathname === "/api/homeassistant/test" && req.method === "POST" && isAuthenticated(req)) {
    handleHATestConnection(req, res);
    return true;
  }

  if (pathname === "/api/homeassistant/events" && req.method === "GET" && isAuthenticated(req)) {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    respondJson(res, 200, { events: getRecentEvents(limit) });
    return true;
  }

  if (pathname === "/api/homeassistant/commands" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, { commands: getCommandQueue() });
    return true;
  }

  if (pathname === "/api/homeassistant/token/regenerate" && req.method === "POST" && isAuthenticated(req)) {
    handleHARegenerateToken(req, res);
    return true;
  }

  if (pathname === "/api/homeassistant/reflex/test" && req.method === "POST" && isAuthenticated(req)) {
    handleHAReflexTest(req, res);
    return true;
  }

  if (pathname === "/api/homeassistant/speak" && req.method === "POST" && isAuthenticated(req)) {
    handleHASpeak(req, res);
    return true;
  }

  // -- RSS feeds CRUD --
  if (pathname === "/api/rss/feeds" && isAuthenticated(req)) {
    if (req.method === "GET") {
      respondJson(res, 200, getRSSStatus());
      return true;
    }
    if (req.method === "POST") {
      handleRSSAddFeed(req, res);
      return true;
    }
    if (req.method === "DELETE") {
      handleRSSRemoveFeed(req, res);
      return true;
    }
  }

  // -- Play Store status (cached snapshot; cheap) --
  if (pathname === "/api/playstore/status" && req.method === "GET" && isAuthenticated(req)) {
    const cfg = getPlayStoreConfig();
    respondJson(res, 200, {
      configured: isPlayStoreConfigured(),
      appLabel: cfg.appLabel,
      packageName: cfg.packageName,
      snapshot: loadSnapshot(),
    });
    return true;
  }

  // -- Play Store refresh (live fetch, updates the snapshot) --
  if (pathname === "/api/playstore/refresh" && req.method === "POST" && isAuthenticated(req)) {
    handlePlayStoreRefresh(req, res);
    return true;
  }

  // -- OwnTracks status --
  if (pathname === "/api/owntracks/status" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getOwnTracksStatus());
    return true;
  }

  // -- Twilio voice calling --
  if (pathname === "/api/twilio/status" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getTwilioStatus());
    return true;
  }

  if (pathname === "/api/twilio/config" && isAuthenticated(req)) {
    if (req.method === "GET") {
      respondJson(res, 200, getTwilioStatus());
      return true;
    }
    if (req.method === "PUT") {
      handleTwilioSaveConfig(req, res);
      return true;
    }
  }

  if (pathname === "/api/twilio/call" && req.method === "POST" && isAuthenticated(req)) {
    handleTwilioCall(req, res);
    return true;
  }

  if (pathname === "/api/twilio/history" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, loadCallHistory());
    return true;
  }

  // -- Browser automation --
  if (pathname === "/api/browser/status" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getBrowserStatus());
    return true;
  }

  if (pathname === "/api/browser/run" && req.method === "POST" && isAuthenticated(req)) {
    handleBrowserRun(req, res);
    return true;
  }

  if (pathname === "/api/browser/session" && req.method === "POST" && isAuthenticated(req)) {
    handleBrowserSession(req, res);
    return true;
  }

  if (pathname === "/api/browser/navigate" && req.method === "POST" && isAuthenticated(req)) {
    handleBrowserNavigate(req, res);
    return true;
  }

  if (pathname === "/api/browser/screenshot" && req.method === "POST" && isAuthenticated(req)) {
    handleBrowserScreenshot(req, res);
    return true;
  }

  if (pathname === "/api/browser/extract" && req.method === "POST" && isAuthenticated(req)) {
    handleBrowserExtract(req, res);
    return true;
  }

  if (pathname === "/api/browser/history" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getBrowserStatus().recentTasks);
    return true;
  }

  if (pathname === "/api/browser/history" && req.method === "DELETE" && isAuthenticated(req)) {
    clearBrowserHistory();
    respondJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === "/api/browser/captcha" && req.method === "POST" && isAuthenticated(req)) {
    handleCaptchaShare(req, res);
    return true;
  }

  if (pathname === "/api/browser/captcha/verify" && req.method === "POST" && isAuthenticated(req)) {
    handleCaptchaVerify(req, res);
    return true;
  }

  if (pathname === "/api/browser/captcha/pending" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getPendingCaptchas());
    return true;
  }

  if (pathname === "/api/browser/captcha/history" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getCaptchaHistory());
    return true;
  }

  // -- Integrations config --
  if (pathname === "/api/integrations/config" && req.method === "PUT" && isAuthenticated(req)) {
    handleIntegrationsConfigUpdate(req, res);
    return true;
  }

  // -- Trust / Security config --
  if (pathname === "/api/trust/config" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getTrustConfig());
    return true;
  }
  if (pathname === "/api/trust/config" && req.method === "PUT" && isAuthenticated(req)) {
    handleTrustConfigUpdate(req, res);
    return true;
  }
  if (pathname === "/api/trust/injection-log" && req.method === "GET" && isAuthenticated(req)) {
    handleInjectionLogGet(req, res);
    return true;
  }

  return false;
}

// -- SSH handlers --

const handlePlayStoreRefresh = apiHandler(async () => {
  if (!isPlayStoreConfigured()) {
    throw new ApiError(400, "Play Store not configured: service-account key missing");
  }
  const snapshot = await refreshSnapshot();
  return { snapshot };
});

const handleSSHAddTarget = apiHandler(async (_req, _res, body: { label?: string; host?: string; user?: string; port?: number }) => {
  if (!body.label || !body.host || !body.user) throw new ApiError(400, "label, host, and user are required");
  const target = addTarget(body.label, body.host, body.user, body.port || 22);
  return { success: true, target };
});

const handleSSHRemoveTarget = apiHandler(async (_req, _res, body: { id?: string }) => {
  if (!body.id) throw new ApiError(400, "id is required");
  return { success: removeTarget(body.id) };
});

const handleSSHTest = apiHandler(async (_req, _res, body: { id?: string }) => {
  if (!body.id) throw new ApiError(400, "id is required");
  return await testConnection(body.id);
});

// -- Slack handlers --

const handleSlackAddWorkspace = apiHandler(async (req, _res, body: { id?: string; teamName?: string; clientId?: string; clientSecret?: string; redirectUri?: string }) => {
  if (!body.id || !body.teamName || !body.clientId || !body.clientSecret) {
    throw new ApiError(400, "id, teamName, clientId, and clientSecret are required");
  }
  const uri = body.redirectUri || `${req.headers.origin || "http://localhost:3000"}/slack/callback`;
  const workspace = addSlackWorkspace(body.id, body.teamName, body.clientId, body.clientSecret, uri);
  return { success: true, workspace: { id: workspace.id, teamName: workspace.teamName } };
});

const handleSlackRemoveWorkspace = apiHandler(async (_req, _res, body: { id?: string }) => {
  if (!body.id) throw new ApiError(400, "id is required");
  return { success: removeSlackWorkspace(body.id) };
});

// -- Gmail handlers --

const handleGmailAddAccount = apiHandler(async (req, _res, body: { id?: string; email?: string; clientId?: string; clientSecret?: string; redirectUri?: string }) => {
  if (!body.id || !body.email || !body.clientId || !body.clientSecret) {
    throw new ApiError(400, "id, email, clientId, and clientSecret are required");
  }
  const uri = body.redirectUri || `${req.headers.origin || "http://localhost:3000"}/gmail/callback`;
  const account = addAccount(body.id, body.email, body.clientId, body.clientSecret, uri);
  return { success: true, account: { id: account.id, email: account.email } };
});

const handleGmailRemoveAccount = apiHandler(async (_req, _res, body: { id?: string }) => {
  if (!body.id) throw new ApiError(400, "id is required");
  return { success: removeAccount(body.id) };
});

// -- Calendar handlers --

const handleCalendarCreateEvent = apiHandler(async (_req, res, body: { accountId?: string; summary?: string; startDateTime?: string; endDateTime?: string; location?: string; calendarId?: string }) => {
  if (!body.accountId || !body.summary || !body.startDateTime || !body.endDateTime) {
    throw new ApiError(400, "Missing required fields: accountId, summary, startDateTime, endDateTime");
  }
  const result = await createEvent(body.accountId, body.summary, body.startDateTime, body.endDateTime, body.location, body.calendarId);
  respondJson(res, result.success ? 200 : 500, result);
});

const handleCalendarList = apiGetHandler(async (req, _res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const accountId = url.searchParams.get("accountId");
  if (!accountId) {
    throw new ApiError(400, "accountId query parameter is required");
  }
  const calendars = await listCalendars(accountId);
  return { calendars };
});

const handleCalendarConfigSave = apiHandler(async (_req, _res, body: { calendars?: CalendarConfigEntry[] }) => {
  if (!body.calendars || !Array.isArray(body.calendars)) {
    throw new ApiError(400, "calendars array is required");
  }
  const validTags = new Set(["private", "work", null]);
  for (const cal of body.calendars) {
    if (!cal.id || !cal.name) {
      throw new ApiError(400, "Each calendar must have id and name");
    }
    if (!validTags.has(cal.tag)) {
      throw new ApiError(400, `Invalid tag "${cal.tag}" — must be "private", "work", or null`);
    }
  }
  saveCalendarConfig({ calendars: body.calendars });
  return { success: true };
});

// -- RSS handlers --

const handleRSSAddFeed = apiHandler(async (_req, _res, body: { name?: string; url?: string }) => {
  if (!body.name || !body.url) throw new ApiError(400, "name and url are required");
  const feed = addFeed(body.name.trim(), body.url.trim());
  return { success: true, feed };
});

const handleRSSRemoveFeed = apiHandler(async (_req, _res, body: { id?: string }) => {
  if (!body.id) throw new ApiError(400, "id is required");
  return { success: removeFeed(body.id) };
});

// -- Browser handlers --

const handleBrowserRun = apiHandler(async (_req, _res, body: Record<string, unknown>) => {
  const { tasks } = body;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new ApiError(400, "tasks array is required");
  if (tasks.length > 10) throw new ApiError(400, "max 10 tasks per workflow");
  const results = await runWorkflow(tasks);
  return { success: true, results };
});

const handleBrowserSession = apiHandler(async (_req, _res, body: Record<string, unknown>) => {
  const { tasks, sessionTimeoutMs } = body;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new ApiError(400, "tasks array is required");
  if (tasks.length > 20) throw new ApiError(400, "max 20 tasks per session");
  const results = await runSession(tasks, sessionTimeoutMs as number | undefined);
  return { success: true, results };
});

const handleBrowserNavigate = apiHandler(async (_req, _res, body: { url?: string }) => {
  if (!body.url) throw new ApiError(400, "url is required");
  return await navigateTo(body.url);
});

const handleBrowserScreenshot = apiHandler(async (_req, _res, body: { url?: string }) => {
  if (!body.url) throw new ApiError(400, "url is required");
  return await takeScreenshot(body.url);
});

const handleBrowserExtract = apiHandler(async (_req, _res, body: { url?: string; selector?: string }) => {
  if (!body.url || !body.selector) throw new ApiError(400, "url and selector are required");
  return await extractText(body.url, body.selector);
});

// -- Captcha handlers --

const handleCaptchaShare = apiHandler(async (_req, res, body: { url?: string; selector?: string; jid?: string; caption?: string }) => {
  if (!body.url) throw new ApiError(400, "url is required");

  let result;
  if (body.selector) {
    result = await runWorkflow([
      { id: `captcha_nav_${Date.now()}`, type: "navigate", url: body.url },
      { id: `captcha_ss_${Date.now()}`, type: "screenshot", url: body.url },
    ]);
    result = result[result.length - 1];
  } else {
    result = await takeScreenshot(body.url);
  }

  if (!result.success || !result.screenshotPath) {
    respondJson(res, 500, { error: result.error || "Screenshot failed", result });
    return;
  }

  const targetJid = body.jid || (process.env.OWNER_PHONE ? `${process.env.OWNER_PHONE}@s.whatsapp.net` : "");
  if (targetJid) {
    await sendImage(targetJid, result.screenshotPath, body.caption || "captcha screenshot");
  }

  return {
    ok: true,
    screenshotPath: result.screenshotPath,
    sentTo: targetJid || null,
    url: result.url,
  };
});

const handleCaptchaVerify = apiHandler(async (_req, _res, body: { imagePath?: string; caption?: string; timeout?: number }) => {
  if (!body.imagePath) throw new ApiError(400, "imagePath is required");
  const answer = await requestCaptchaVerification(body.imagePath, body.caption || undefined, body.timeout || 300_000);
  return { ok: true, answer };
});

// -- Integrations config handler --

const handleIntegrationsConfigUpdate = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  for (const [key, val] of Object.entries(data)) {
    if (!isValidIntegrationKey(key)) throw new ApiError(400, `Unknown integration key: ${key}`);
    if (typeof val !== "boolean") throw new ApiError(400, `Value for "${key}" must be a boolean`);
  }
  return saveIntegrationsConfig(data);
});

// -- Trust config handlers --

const handleTrustConfigUpdate = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  return saveTrustConfig(data as Partial<TrustConfig>);
});

const handleInjectionLogGet = apiGetHandler(() => {
  const logFile = "/data/brain/injection-attempts.jsonl";
  try {
    if (!existsSync(logFile)) return [];
    const content = readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines
      .slice(-100)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch { return []; }
});

// -- Home Assistant handlers --

const HA_MODES: HAConnectionMode[] = ["webhook", "direct_api", "cloud"];
const ENTITY_ID_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

function parseConnection(raw: unknown, current: { url: string; token: string } | undefined, label: string): { url: string; token: string } | undefined {
  if (!raw || typeof raw !== "object") return current;
  const obj = raw as Record<string, unknown>;
  const url = String(obj.url || "").trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//.test(url)) throw new ApiError(400, `${label}.url must start with http:// or https://`);
  // "***" is the masked token echoed back by the status endpoint — keep the stored one.
  const rawToken = String(obj.token || "");
  const token = rawToken && rawToken !== "***" ? rawToken : (current?.token || "");
  return url || token ? { url, token } : undefined;
}

function parseButtonRule<T extends HAButtonRule>(raw: unknown, current: T, label: string): T {
  if (!raw || typeof raw !== "object") return current;
  const r = raw as Record<string, unknown>;
  const actions = Array.isArray(r.actions) ? r.actions.filter((a): a is string => typeof a === "string" && /^[a-z0-9_]+$/.test(a)) : current.actions;
  if (actions.length === 0) throw new ApiError(400, `${label} needs at least one button action`);
  const device = typeof r.device === "string" ? r.device.trim() : current.device;
  if (!device) throw new ApiError(400, `${label} device is required`);
  return {
    ...current,
    enabled: typeof r.enabled === "boolean" ? r.enabled : current.enabled,
    device,
    actions,
    pushTts: typeof r.pushTts === "boolean" ? r.pushTts : current.pushTts,
  };
}

function parseWeatherReflex(raw: unknown, current: HAWeatherReflexConfig): HAWeatherReflexConfig {
  const rule = parseButtonRule(raw, current, "weather reflex");
  if (!raw || typeof raw !== "object") return rule;
  const r = raw as Record<string, unknown>;
  const weatherEntity = typeof r.weatherEntity === "string" ? r.weatherEntity.trim() : current.weatherEntity;
  if (!ENTITY_ID_RE.test(weatherEntity)) throw new ApiError(400, "weatherEntity must be an entity id");
  const eveningHour = typeof r.eveningHour === "number" ? r.eveningHour : current.eveningHour;
  if (!Number.isInteger(eveningHour) || eveningHour < 0 || eveningHour > 23) throw new ApiError(400, "eveningHour must be 0-23");
  return { ...rule, weatherEntity, eveningHour };
}

function parseSpeech(raw: unknown, current: HASpeechConfig): HASpeechConfig {
  if (!raw || typeof raw !== "object") return current;
  const r = raw as Record<string, unknown>;
  const mediaPlayer = typeof r.mediaPlayer === "string" ? r.mediaPlayer.trim() : current.mediaPlayer;
  if (!ENTITY_ID_RE.test(mediaPlayer)) throw new ApiError(400, "speech mediaPlayer must be a media_player entity id");
  return {
    mediaPlayer,
    ttsEngine: typeof r.ttsEngine === "string" && /^[a-z0-9_.]+$/.test(r.ttsEngine) ? r.ttsEngine : current.ttsEngine,
    // "nl", "nl-NL" or a full voice name such as "nl-NL-FennaNeural" (Edge/Azure style engines take the voice as language).
    language: typeof r.language === "string" && /^[a-z]{2}(-[A-Za-z]{2})?(-[A-Za-z0-9]+)?$/.test(r.language) ? r.language : current.language,
    ttsVolume: parseTtsVolume(r.ttsVolume, current.ttsVolume),
  };
}

function parseTtsVolume(raw: unknown, current: number | null): number | null {
  if (raw === undefined) return current;
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new ApiError(400, "ttsVolume must be between 0 and 1 (or empty to leave the volume alone)");
  return n;
}

const handleHASaveConfig = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  const current = getHAStatus().config;
  const mode = (data.mode ?? current.mode) as HAConnectionMode;
  if (!HA_MODES.includes(mode)) throw new ApiError(400, `mode must be one of ${HA_MODES.join(", ")}`);

  // Unmasked config for merging — the status endpoint masks tokens.
  const existing = loadHAConfig();
  const updates: Partial<HAConfig> = {
    mode,
    entities: Array.isArray(data.entities) ? data.entities.filter((e): e is string => typeof e === "string") : existing.entities,
    pollInterval: typeof data.pollInterval === "number" ? data.pollInterval : existing.pollInterval,
    digestIntervalMs: typeof data.digestIntervalMs === "number" ? data.digestIntervalMs : existing.digestIntervalMs,
    direct_api: parseConnection(data.direct_api, existing.direct_api, "direct_api"),
    cloud: parseConnection(data.cloud, existing.cloud, "cloud"),
    speech: parseSpeech(data.speech, existing.speech),
    reflexes: {
      weatherBriefing: parseWeatherReflex((data.reflexes as Record<string, unknown> | undefined)?.weatherBriefing, existing.reflexes.weatherBriefing ?? DEFAULT_WEATHER_REFLEX),
      mindBriefing: parseButtonRule((data.reflexes as Record<string, unknown> | undefined)?.mindBriefing, existing.reflexes.mindBriefing ?? DEFAULT_MIND_REFLEX, "mind reflex"),
    },
  };
  if (data.location && typeof data.location === "object") {
    const loc = data.location as Record<string, unknown>;
    const lat = Number(loc.lat), lon = Number(loc.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new ApiError(400, "location must have valid lat/lon");
    updates.location = { lat, lon };
  }

  saveConfig(updates);
  restartHAPolling();
  restartHADigestLoop();
  return { success: true, status: getHAStatus() };
});

const handleHATestConnection = apiHandler(async (_req, _res, body: { url?: string; token?: string }) => {
  if (!body.url || !body.token) throw new ApiError(400, "url and token are required");
  return await testHAConnection(body.url, body.token);
});

const handleHARegenerateToken = apiHandler(async () => {
  const token = regenerateWebhookToken();
  return { success: true, webhookToken: token };
});

const handleHAReflexTest = apiHandler(async (_req, _res, body: { reflexId?: string; push?: boolean }) => {
  const reflexId = body.reflexId || "weather_briefing";
  const result = await testReflex(reflexId);
  let pushed: string | null = null;
  if (body.push && result.tts) {
    const dispatched = await dispatchCommand(result.tts, "api", `dashboard test of ${reflexId}`);
    pushed = dispatched.mode;
  }
  return { success: true, result, pushed };
});

const handleHASpeak = apiHandler(async (_req, _res, body: { text?: string; player?: string }) => {
  const text = (body.text || "").trim();
  if (!text || text.length > 400) throw new ApiError(400, "text is required (max 400 chars)");
  const speech = getHAStatus().config.speech;
  const player = body.player?.trim() || speech.mediaPlayer;
  if (!ENTITY_ID_RE.test(player)) throw new ApiError(400, "player must be a media_player entity id");
  if (speech.ttsVolume !== null) {
    await dispatchCommand(buildVolumeCall(player, speech.ttsVolume), "api", "announcement volume");
  }
  const call = buildTtsCall(text, { player, engine: speech.ttsEngine, language: speech.language });
  const dispatched = await dispatchCommand(call, "api", "dashboard speak");
  return { success: true, mode: dispatched.mode, command: dispatched.command };
});

// -- Twilio handlers --

const handleTwilioSaveConfig = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  if (!data.accountSid || !data.authToken || !data.phoneNumber || !data.webhookBaseUrl) {
    throw new ApiError(400, "accountSid, authToken, phoneNumber, and webhookBaseUrl are required");
  }
  const config = {
    accountSid: String(data.accountSid),
    authToken: String(data.authToken),
    phoneNumber: String(data.phoneNumber),
    webhookBaseUrl: String(data.webhookBaseUrl).replace(/\/+$/, ""),
    defaultVoice: String(data.defaultVoice || "Polly.Lotte"),
    defaultLanguage: String(data.defaultLanguage || "nl-NL"),
    maxCallDurationSec: Number(data.maxCallDurationSec) || 600,
    model: String(data.model || "claude-opus-4-7"),
  };
  saveTwilioConfig(config);
  return { success: true, status: getTwilioStatus() };
});

const handleTwilioCall = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  const { to, mode, message, systemPrompt, greeting, voice, language, model } = data as {
    to?: string; mode?: string; message?: string; systemPrompt?: string;
    greeting?: string; voice?: string; language?: string; model?: string;
  };
  if (!to) throw new ApiError(400, "to is required");

  if (mode === "agent") {
    return await makeAgentCall(
      to,
      systemPrompt || "You are ARIA, a helpful AI assistant making a phone call. Be concise and natural.",
      greeting || "Hello, this is ARIA calling.",
      voice, language, model,
    );
  } else {
    if (!message) throw new ApiError(400, "message is required for simple calls");
    return await makeSimpleCall(to, message, voice, language);
  }
});
