import { IncomingMessage, ServerResponse } from "http";
import { FileStore } from "../utils/file-store.js";
import { spawn } from "child_process";
import Twilio from "twilio";
import { createLogger } from "../logger.js";
import { recordObservation } from "../observer.js";
import { isIntegrationEnabled } from "./integration-config.js";
import { getBrainConfig } from "../brain-config.js";

const log = createLogger("twilio");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Twilio SDK has strict enum types for voice/language; user config is runtime strings
function sayOpts(voice: string, language: string): Record<string, any> {
  return { voice, language };
}
function gatherLang(language: string): any {
  return language;
}

const TWILIO_DIR = "/data/twilio";
const CONFIG_FILE = `${TWILIO_DIR}/config.json`;
const STATE_FILE = `${TWILIO_DIR}/state.json`;
const HISTORY_FILE = `${TWILIO_DIR}/call-history.json`;
const MAX_HISTORY = 50;

// ── Types ──

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  webhookBaseUrl: string;
  defaultVoice: string;
  defaultLanguage: string;
  maxCallDurationSec: number;
  model: string;
}

export interface ConversationTurn {
  role: "assistant" | "user";
  text: string;
  timestamp: number;
}

export interface TwilioCallRecord {
  callSid: string;
  to: string;
  from: string;
  mode: "simple" | "agent";
  status: string;
  startedAt: number;
  endedAt?: number;
  duration?: number;
  systemPrompt?: string;
  greeting?: string;
  message?: string;
  turns?: ConversationTurn[];
  summary?: string;
  model?: string;
}

interface ActiveCall {
  callSid: string;
  callId: string;
  to: string;
  mode: "simple" | "agent";
  systemPrompt: string;
  greeting: string;
  message: string;
  conversationHistory: ConversationTurn[];
  startedAt: number;
  maxDurationSec: number;
  voice: string;
  language: string;
  model: string;
}

export interface TwilioStatus {
  enabled: boolean;
  configured: boolean;
  phoneNumber: string;
  webhookBaseUrl: string;
  activeCalls: number;
  totalCalls: number;
  lastCallAt: number;
  recentCalls: TwilioCallRecord[];
  config: Omit<TwilioConfig, "authToken"> | null;
}

// ── In-memory state ──

const activeCalls = new Map<string, ActiveCall>();
// Map callId → ActiveCall for pre-connect lookup
const pendingCalls = new Map<string, ActiveCall>();

// ── File helpers ──

const configStore = new FileStore<TwilioConfig | null>({ filePath: CONFIG_FILE, defaultValue: null });
const twilioStateStore = new FileStore<{ totalCalls: number; lastCallAt: number }>({ filePath: STATE_FILE, defaultValue: { totalCalls: 0, lastCallAt: 0 } });
const callHistoryStore = new FileStore<TwilioCallRecord[]>({ filePath: HISTORY_FILE, defaultValue: [] });

export function loadConfig(): TwilioConfig | null {
  return configStore.load();
}

export function saveConfig(cfg: TwilioConfig): void {
  configStore.save(cfg);
  log("Config saved");
}

function loadState(): { totalCalls: number; lastCallAt: number } {
  return twilioStateStore.load();
}

function saveState(state: { totalCalls: number; lastCallAt: number }): void {
  twilioStateStore.save(state);
}

export function loadCallHistory(): TwilioCallRecord[] {
  return callHistoryStore.load();
}

function saveCallHistory(history: TwilioCallRecord[]): void {
  callHistoryStore.save(history.slice(-MAX_HISTORY));
}

function appendCallToHistory(record: TwilioCallRecord): void {
  const history = loadCallHistory();
  history.push(record);
  saveCallHistory(history);
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── Status ──

export function getTwilioStatus(): TwilioStatus {
  const cfg = loadConfig();
  const state = loadState();
  const history = loadCallHistory();

  return {
    enabled: isIntegrationEnabled("twilio"),
    configured: !!cfg,
    phoneNumber: cfg?.phoneNumber || "",
    webhookBaseUrl: cfg?.webhookBaseUrl || "",
    activeCalls: activeCalls.size,
    totalCalls: state.totalCalls,
    lastCallAt: state.lastCallAt,
    recentCalls: history.slice(-10).reverse(),
    config: cfg ? {
      accountSid: cfg.accountSid,
      phoneNumber: cfg.phoneNumber,
      webhookBaseUrl: cfg.webhookBaseUrl,
      defaultVoice: cfg.defaultVoice,
      defaultLanguage: cfg.defaultLanguage,
      maxCallDurationSec: cfg.maxCallDurationSec,
      model: cfg.model,
    } : null,
  };
}

// ── Twilio request validation ──

function parseTwilioBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const params: Record<string, string> = {};
        for (const pair of body.split("&")) {
          const [key, val] = pair.split("=");
          if (key) params[decodeURIComponent(key)] = decodeURIComponent(val || "");
        }
        resolve(params);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function _validateTwilioSignature(req: IncomingMessage, params: Record<string, string>): boolean {
  const cfg = loadConfig();
  if (!cfg) return false;

  const signature = req.headers["x-twilio-signature"] as string;
  if (!signature) {
    log("Missing X-Twilio-Signature header");
    return false;
  }

  const url = `${cfg.webhookBaseUrl}${req.url || ""}`;
  const valid = Twilio.validateRequest(cfg.authToken, signature, url, params);
  if (!valid) {
    log(`Invalid Twilio signature for ${req.url}`);
  }
  return valid;
}

// ── Call initiation ──

export async function makeSimpleCall(
  to: string,
  message: string,
  voice?: string,
  language?: string,
): Promise<TwilioCallRecord> {
  const cfg = loadConfig();
  if (!cfg) throw new Error("Twilio not configured");
  if (!isIntegrationEnabled("twilio")) throw new Error("Twilio integration disabled");

  const callId = generateId();
  const v = voice || cfg.defaultVoice;
  const lang = language || cfg.defaultLanguage;

  const activeCall: ActiveCall = {
    callSid: "",
    callId,
    to,
    mode: "simple",
    systemPrompt: "",
    greeting: "",
    message,
    conversationHistory: [],
    startedAt: Date.now(),
    maxDurationSec: cfg.maxCallDurationSec,
    voice: v,
    language: lang,
    model: cfg.model,
  };
  pendingCalls.set(callId, activeCall);

  const client = Twilio(cfg.accountSid, cfg.authToken);
  const twimlUrl = `${cfg.webhookBaseUrl}/twilio/twiml?mode=simple&callId=${callId}`;
  const statusUrl = `${cfg.webhookBaseUrl}/twilio/status?callId=${callId}`;

  log(`Initiating simple call to ${to} (callId: ${callId})`);

  const call = await client.calls.create({
    to,
    from: cfg.phoneNumber,
    url: twimlUrl,
    method: "POST",
    statusCallback: statusUrl,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
    timeout: 30,
  });

  activeCall.callSid = call.sid;
  activeCalls.set(call.sid, activeCall);
  pendingCalls.delete(callId);

  log(`Call initiated: ${call.sid}`);

  const state = loadState();
  state.totalCalls++;
  state.lastCallAt = Date.now();
  saveState(state);

  recordObservation({
    timestamp: Date.now(),
    sender: "ARIA",
    senderJid: "twilio:outbound",
    isGroup: false,
    isFromMe: true,
    text: `[CALL] Outbound simple call to ${to}: "${message.slice(0, 100)}"`,
    source: "twilio",
    callMeta: { callSid: call.sid, to, from: cfg.phoneNumber, mode: "simple" },
  });

  return {
    callSid: call.sid,
    to,
    from: cfg.phoneNumber,
    mode: "simple",
    status: "initiated",
    startedAt: Date.now(),
    message,
  };
}

export async function makeAgentCall(
  to: string,
  systemPrompt: string,
  greeting: string,
  voice?: string,
  language?: string,
  model?: string,
): Promise<TwilioCallRecord> {
  const cfg = loadConfig();
  if (!cfg) throw new Error("Twilio not configured");
  if (!isIntegrationEnabled("twilio")) throw new Error("Twilio integration disabled");

  const callId = generateId();
  const v = voice || cfg.defaultVoice;
  const lang = language || cfg.defaultLanguage;
  const m = model || cfg.model;

  const activeCall: ActiveCall = {
    callSid: "",
    callId,
    to,
    mode: "agent",
    systemPrompt,
    greeting,
    message: "",
    conversationHistory: [],
    startedAt: Date.now(),
    maxDurationSec: cfg.maxCallDurationSec,
    voice: v,
    language: lang,
    model: m,
  };
  pendingCalls.set(callId, activeCall);

  const client = Twilio(cfg.accountSid, cfg.authToken);
  const twimlUrl = `${cfg.webhookBaseUrl}/twilio/twiml?mode=agent&callId=${callId}`;
  const statusUrl = `${cfg.webhookBaseUrl}/twilio/status?callId=${callId}`;

  log(`Initiating agent call to ${to} (callId: ${callId}, model: ${m})`);

  const call = await client.calls.create({
    to,
    from: cfg.phoneNumber,
    url: twimlUrl,
    method: "POST",
    statusCallback: statusUrl,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
    timeout: 30,
  });

  activeCall.callSid = call.sid;
  activeCalls.set(call.sid, activeCall);
  pendingCalls.delete(callId);

  log(`Agent call initiated: ${call.sid}`);

  const state = loadState();
  state.totalCalls++;
  state.lastCallAt = Date.now();
  saveState(state);

  recordObservation({
    timestamp: Date.now(),
    sender: "ARIA",
    senderJid: "twilio:outbound",
    isGroup: false,
    isFromMe: true,
    text: `[CALL] Outbound agent call to ${to} (model: ${m}). Prompt: "${systemPrompt.slice(0, 100)}"`,
    source: "twilio",
    callMeta: { callSid: call.sid, to, from: cfg.phoneNumber, mode: "agent" },
  });

  return {
    callSid: call.sid,
    to,
    from: cfg.phoneNumber,
    mode: "agent",
    status: "initiated",
    startedAt: Date.now(),
    systemPrompt,
    greeting,
    model: m,
  };
}

// ── TwiML webhook (initial call setup) ──

export async function handleTwiml(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const params = await parseTwilioBody(req);
    const urlObj = new URL(req.url || "/", "http://localhost");
    const mode = urlObj.searchParams.get("mode") || "simple";
    const callId = urlObj.searchParams.get("callId") || "";
    const callSid = params.CallSid || "";

    // Look up the call
    const call = activeCalls.get(callSid) || pendingCalls.get(callId);
    if (call && !call.callSid && callSid) {
      call.callSid = callSid;
      activeCalls.set(callSid, call);
      pendingCalls.delete(callId);
    }

    const cfg = loadConfig();
    const voice = call?.voice || cfg?.defaultVoice || "Polly.Lotte";
    const language = call?.language || cfg?.defaultLanguage || "nl-NL";

    const VoiceResponse = Twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();

    if (mode === "agent" && call) {
      // Agent mode: greeting + gather
      log(`Agent TwiML for ${callSid}: greeting "${call.greeting.slice(0, 60)}"`);

      call.conversationHistory.push({
        role: "assistant",
        text: call.greeting,
        timestamp: Date.now(),
      });

      twiml.say(sayOpts(voice, language), call.greeting);

      const turnUrl = `${cfg?.webhookBaseUrl || ""}/twilio/turn?callSid=${callSid}`;
      const gather = twiml.gather({
        input: ["speech"],
        action: turnUrl,
        method: "POST",
        speechTimeout: "auto",
        language: gatherLang(language),
        timeout: 10,
      });
      gather.say(sayOpts(voice, language), "");

      // Fallback if no speech detected
      twiml.say(sayOpts(voice, language), "I didn't hear anything. Goodbye.");
      twiml.hangup();
    } else {
      // Simple mode: say message + hang up
      const message = call?.message || "Hello, this is ARIA.";
      log(`Simple TwiML for ${callSid}: "${message.slice(0, 60)}"`);

      twiml.say(sayOpts(voice, language), message);
      twiml.hangup();
    }

    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(twiml.toString());
  } catch (err) {
    log(`handleTwiml error: ${err}`);
    const twiml = new Twilio.twiml.VoiceResponse();
    twiml.say("Sorry, an error occurred.");
    twiml.hangup();
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(twiml.toString());
  }
}

// ── Agent turn webhook ──

export async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const params = await parseTwilioBody(req);
    const urlObj = new URL(req.url || "/", "http://localhost");
    const callSid = urlObj.searchParams.get("callSid") || params.CallSid || "";
    const speechResult = params.SpeechResult || "";

    const call = activeCalls.get(callSid);
    if (!call) {
      log(`handleTurn: unknown call ${callSid}`);
      const twiml = new Twilio.twiml.VoiceResponse();
      twiml.say("Sorry, I lost track of our conversation. Goodbye.");
      twiml.hangup();
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(twiml.toString());
      return;
    }

    const cfg = loadConfig();
    const voice = call.voice;
    const language = call.language;

    log(`Turn for ${callSid}: caller said "${speechResult.slice(0, 100)}"`);

    // Add user turn
    call.conversationHistory.push({
      role: "user",
      text: speechResult,
      timestamp: Date.now(),
    });

    // Check duration cap
    const elapsed = (Date.now() - call.startedAt) / 1000;
    if (elapsed > call.maxDurationSec) {
      log(`Call ${callSid} exceeded duration cap (${elapsed}s > ${call.maxDurationSec}s)`);
      const twiml = new Twilio.twiml.VoiceResponse();
      twiml.say(sayOpts(voice, language), "I need to wrap up now. Thank you for the conversation. Goodbye.");
      twiml.hangup();
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(twiml.toString());
      return;
    }

    // Get Claude's response
    const { text: responseText, shouldEnd } = await callClaudeForTurn(call);

    // Add assistant turn
    call.conversationHistory.push({
      role: "assistant",
      text: responseText,
      timestamp: Date.now(),
    });

    const twiml = new Twilio.twiml.VoiceResponse();

    if (shouldEnd) {
      twiml.say(sayOpts(voice, language), responseText);
      twiml.hangup();
    } else {
      twiml.say(sayOpts(voice, language), responseText);

      const turnUrl = `${cfg?.webhookBaseUrl || ""}/twilio/turn?callSid=${callSid}`;
      const gather = twiml.gather({
        input: ["speech"],
        action: turnUrl,
        method: "POST",
        speechTimeout: "auto",
        language: gatherLang(language),
        timeout: 10,
      });
      gather.say(sayOpts(voice, language), "");

      // Fallback if no speech
      twiml.say(sayOpts(voice, language), "Are you still there?");
      const retryGather = twiml.gather({
        input: ["speech"],
        action: turnUrl,
        method: "POST",
        speechTimeout: "auto",
        language: gatherLang(language),
        timeout: 8,
      });
      retryGather.say(sayOpts(voice, language), "");

      twiml.say(sayOpts(voice, language), "Goodbye.");
      twiml.hangup();
    }

    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(twiml.toString());
  } catch (err) {
    log(`handleTurn error: ${err}`);
    const twiml = new Twilio.twiml.VoiceResponse();
    twiml.say("I'm having trouble right now. Let me call you back.");
    twiml.hangup();
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(twiml.toString());
  }
}

// ── Claude CLI for agent turns ──

async function callClaudeForTurn(call: ActiveCall): Promise<{ text: string; shouldEnd: boolean }> {
  if (!getBrainConfig().enabled) {
    return { text: "I'm currently offline. Goodbye.", shouldEnd: true };
  }
  const TIMEOUT_MS = 12_000;

  // Build conversation context for Claude
  const conversationLines = call.conversationHistory.map(
    (t) => `${t.role === "assistant" ? "You" : "Caller"}: ${t.text}`,
  ).join("\n");

  const prompt = [
    call.systemPrompt,
    "",
    "You are on a phone call. Keep responses SHORT and natural — this is spoken aloud.",
    "Max 2-3 sentences per turn. Be conversational, not robotic.",
    `If the conversation is done, end your response with [END_CALL].`,
    "",
    "Conversation so far:",
    conversationLines,
    "",
    "Respond with what you should say next. Only output the spoken words, nothing else.",
  ].join("\n");

  try {
    const result = await runClaudeCLI(prompt, call.model, TIMEOUT_MS);
    const shouldEnd = result.includes("[END_CALL]");
    const text = result.replace("[END_CALL]", "").trim();
    return { text: text || "Thank you. Goodbye.", shouldEnd };
  } catch (err) {
    log(`Claude turn error: ${err}`);
    return { text: "Could you repeat that?", shouldEnd: false };
  }
}

function runClaudeCLI(prompt: string, model: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", model,
      "--allowedTools", "",
    ];

    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      CLAUDECODE: "",
      HOME: process.env.CLAUDE_HOME || process.env.HOME || "/root",
    };

    const child = spawn("claude", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      reject(new Error(`Claude timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;

      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 200)}`));
        return;
      }

      try {
        const response = JSON.parse(stdout) as { result: string; is_error?: boolean };
        resolve(response.result || "");
      } catch {
        // Raw text fallback
        resolve(stdout.trim());
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.end();
  });
}

// ── Status callback webhook ──

export async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const params = await parseTwilioBody(req);
    const urlObj = new URL(req.url || "/", "http://localhost");
    const callId = urlObj.searchParams.get("callId") || "";
    const callSid = params.CallSid || "";
    const callStatus = params.CallStatus || "";
    const callDuration = params.CallDuration ? Number(params.CallDuration) : undefined;

    log(`Status callback: ${callSid} → ${callStatus} (duration: ${callDuration ?? "?"}s)`);

    const call = activeCalls.get(callSid) || pendingCalls.get(callId);

    const isTerminal = ["completed", "failed", "busy", "no-answer", "canceled"].includes(callStatus);

    if (isTerminal && call) {
      // Save to history
      const cfg = loadConfig();
      const record: TwilioCallRecord = {
        callSid: call.callSid || callSid,
        to: call.to,
        from: cfg?.phoneNumber || "",
        mode: call.mode,
        status: callStatus,
        startedAt: call.startedAt,
        endedAt: Date.now(),
        duration: callDuration,
        systemPrompt: call.mode === "agent" ? call.systemPrompt : undefined,
        greeting: call.mode === "agent" ? call.greeting : undefined,
        message: call.mode === "simple" ? call.message : undefined,
        turns: call.mode === "agent" ? call.conversationHistory : undefined,
        model: call.model,
      };

      appendCallToHistory(record);

      // Record observation
      const turnCount = call.conversationHistory.length;
      const durationStr = callDuration ? `${Math.floor(callDuration / 60)}m ${callDuration % 60}s` : "unknown";
      recordObservation({
        timestamp: Date.now(),
        sender: "ARIA",
        senderJid: "twilio:outbound",
        isGroup: false,
        isFromMe: true,
        text: `[CALL ENDED] ${call.mode} call to ${call.to} — status: ${callStatus}, duration: ${durationStr}${turnCount > 0 ? `, ${turnCount} turns` : ""}`,
        source: "twilio",
        callMeta: { callSid: call.callSid || callSid, to: call.to, from: cfg?.phoneNumber || "", mode: call.mode, duration: callDuration },
      });

      // Clean up
      activeCalls.delete(callSid);
      activeCalls.delete(call.callSid);
      pendingCalls.delete(callId);
      pendingCalls.delete(call.callId);

      log(`Call ${callSid} cleaned up (${callStatus})`);
    }

    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end("<Response/>");
  } catch (err) {
    log(`handleStatus error: ${err}`);
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end("<Response/>");
  }
}
