import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { appendFileSync } from "fs";
import { askClaude } from "./claude.js";
import { getObservationsSince, pruneObservations, ensureBrainDir } from "./observer.js";
import { buildBrainPrompt } from "./brain-prompt.js";
import type { MessageQueue } from "./queue.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [brain] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

// Config from env
const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const TICK_INTERVAL = Number(process.env.BRAIN_TICK_INTERVAL ?? 60000);
const MAX_MESSAGES_PER_DAY = Number(process.env.BRAIN_MAX_MESSAGES_PER_DAY ?? 5);
const QUIET_START = Number(process.env.BRAIN_QUIET_START ?? 23);
const QUIET_END = Number(process.env.BRAIN_QUIET_END ?? 7);
const MIN_MESSAGE_INTERVAL = Number(process.env.BRAIN_MIN_MESSAGE_INTERVAL ?? 7200000);
const THINK_COOLDOWN = Number(process.env.BRAIN_THINK_COOLDOWN ?? 300000);
const NOTEBOOK_MAX_CHARS = Number(process.env.BRAIN_NOTEBOOK_MAX_CHARS ?? 8000);
const OWNER_NAME = process.env.OWNER_NAME || "Owner";
const BRAIN_ENABLED = process.env.BRAIN_ENABLED !== "false";

const STATE_FILE = `${BRAIN_DIR}/state.json`;
const NOTEBOOK_FILE = `${BRAIN_DIR}/notebook.md`;

interface BrainState {
  lastThinkTime: number;
  lastMessageTime: number;
  messagesToday: number;
  messagesTodayDate: string;
  lastObservationTime: number;
  totalThinks: number;
  totalCost: number;
}

function defaultState(): BrainState {
  return {
    lastThinkTime: 0,
    lastMessageTime: 0,
    messagesToday: 0,
    messagesTodayDate: "",
    lastObservationTime: 0,
    totalThinks: 0,
    totalCost: 0,
  };
}

function loadState(): BrainState {
  try {
    if (existsSync(STATE_FILE)) {
      return { ...defaultState(), ...JSON.parse(readFileSync(STATE_FILE, "utf-8")) };
    }
  } catch {
    log("Failed to read state, using defaults");
  }
  return defaultState();
}

function saveState(state: BrainState): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`Failed to save state: ${err}`);
  }
}

function loadNotebook(): string {
  try {
    if (existsSync(NOTEBOOK_FILE)) {
      const content = readFileSync(NOTEBOOK_FILE, "utf-8");
      if (content.length > NOTEBOOK_MAX_CHARS) {
        return content.slice(-NOTEBOOK_MAX_CHARS);
      }
      return content;
    }
  } catch {
    log("Failed to read notebook");
  }
  return "";
}

function saveNotebook(content: string): void {
  try {
    // Atomic write: write to temp file then rename
    const tmpFile = `${NOTEBOOK_FILE}.tmp`;
    writeFileSync(tmpFile, content);
    renameSync(tmpFile, NOTEBOOK_FILE);
  } catch (err) {
    log(`Failed to save notebook: ${err}`);
  }
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

interface BrainResponse {
  notebook: string | null;
  message: string | null;
  reasoning: string | null;
}

function parseBrainResponse(raw: string): BrainResponse | null {
  try {
    // Try to extract JSON from the response (Claude might wrap it in markdown)
    let jsonStr = raw.trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    const parsed = JSON.parse(jsonStr);
    return {
      notebook: parsed.notebook ?? null,
      message: parsed.message ?? null,
      reasoning: parsed.reasoning ?? null,
    };
  } catch {
    log(`Failed to parse brain response: ${raw.slice(0, 200)}`);
    return null;
  }
}

let brainInterval: ReturnType<typeof setInterval> | null = null;
let lastPruneDate = "";

export function startBrainLoop(
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
): void {
  if (!BRAIN_ENABLED) {
    log("Brain is disabled (BRAIN_ENABLED=false)");
    return;
  }

  ensureBrainDir();
  const ownerJid = `${process.env.OWNER_PHONE}@s.whatsapp.net`;

  log(`Brain loop starting (tick every ${TICK_INTERVAL / 1000}s, max ${MAX_MESSAGES_PER_DAY} msgs/day, quiet ${QUIET_START}:00-${QUIET_END}:00)`);

  brainInterval = setInterval(() => {
    tick(queue, sendMessage, ownerJid).catch((err) => {
      log(`Tick error: ${err}`);
    });
  }, TICK_INTERVAL);

  // Run initial tick after a short delay to let WhatsApp connect
  setTimeout(() => {
    tick(queue, sendMessage, ownerJid).catch((err) => {
      log(`Initial tick error: ${err}`);
    });
  }, 10000);
}

export function stopBrainLoop(): void {
  if (brainInterval) {
    clearInterval(brainInterval);
    brainInterval = null;
    log("Brain loop stopped");
  }
}

async function tick(
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
): Promise<void> {
  const state = loadState();
  const now = Date.now();
  const today = todayStr();

  // Reset daily counter
  if (state.messagesTodayDate !== today) {
    state.messagesToday = 0;
    state.messagesTodayDate = today;
  }

  // Daily pruning of old observations
  if (lastPruneDate !== today) {
    lastPruneDate = today;
    pruneObservations();
  }

  // Check for new observations
  const newObs = getObservationsSince(state.lastObservationTime);
  const timeSinceLastThink = now - state.lastThinkTime;

  // Decide if we should think
  const hasNewObs = newObs.length > 0;
  const cooldownPassed = timeSinceLastThink >= THINK_COOLDOWN;
  const timeAwarenessNeeded = timeSinceLastThink >= 30 * 60 * 1000;

  const shouldThink = (hasNewObs && cooldownPassed) || timeAwarenessNeeded;

  if (!shouldThink) return;

  // Defer to owner messages — skip if queue is busy
  if (!queue.idle) {
    log("Queue busy, deferring brain tick");
    return;
  }

  log(`Thinking... (${newObs.length} new observations, ${timeSinceLastThink / 1000}s since last think)`);

  const notebook = loadNotebook();
  const prompt = buildBrainPrompt({
    ownerName: OWNER_NAME,
    notebook,
    observations: newObs,
    lastThinkTime: state.lastThinkTime,
    lastMessageTime: state.lastMessageTime,
    messagesToday: state.messagesToday,
    maxMessagesPerDay: MAX_MESSAGES_PER_DAY,
    quietStart: QUIET_START,
    quietEnd: QUIET_END,
  });

  try {
    const result = await queue.add(async () => {
      return await askClaude(prompt, {
        timeout: 120_000,
        allowedTools: "",
        noSession: true,
      });
    });

    const responseText = result.messages.join("\n");
    const response = parseBrainResponse(responseText);

    if (!response) {
      log("Could not parse brain response, skipping");
      state.lastThinkTime = now;
      state.lastObservationTime = now;
      saveState(state);
      return;
    }

    log(`Reasoning: ${response.reasoning?.slice(0, 200) || "(none)"}`);

    // Update notebook
    if (response.notebook) {
      saveNotebook(response.notebook);
      log(`Notebook updated (${response.notebook.length} chars)`);
    }

    // Send proactive message if decided
    if (response.message) {
      const currentHour = new Date().getHours();
      const isQuiet = currentHour >= QUIET_START || currentHour < QUIET_END;
      const messageIntervalOk = (now - state.lastMessageTime) >= MIN_MESSAGE_INTERVAL;
      const underDailyLimit = state.messagesToday < MAX_MESSAGES_PER_DAY;

      if (isQuiet) {
        log("Suppressed message: quiet hours");
      } else if (!messageIntervalOk) {
        log(`Suppressed message: too soon (${Math.round((now - state.lastMessageTime) / 60000)}m since last)`);
      } else if (!underDailyLimit) {
        log(`Suppressed message: daily limit reached (${state.messagesToday}/${MAX_MESSAGES_PER_DAY})`);
      } else {
        try {
          await sendMessage(ownerJid, response.message);
          state.lastMessageTime = now;
          state.messagesToday++;
          log(`Sent proactive message (${response.message.length} chars, #${state.messagesToday} today)`);
        } catch (err) {
          log(`Failed to send proactive message: ${err}`);
        }
      }
    }

    // Update state
    state.lastThinkTime = now;
    state.lastObservationTime = now;
    state.totalThinks++;
    if (result.stats) {
      state.totalCost += result.stats.totalCostUsd || 0;
    }
    saveState(state);

    log(`Think #${state.totalThinks} complete (lifetime cost: $${state.totalCost.toFixed(4)})`);
  } catch (err) {
    log(`Think failed: ${err}`);
    // Still update timestamps to avoid retry storm
    state.lastThinkTime = now;
    state.lastObservationTime = now;
    saveState(state);
  }
}
