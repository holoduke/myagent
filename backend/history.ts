import { appendFileSync, existsSync, readFileSync } from "fs";
import { safeReadJSON, atomicWriteFile } from "./utils/file-store.js";
import { createLogger } from "./logger.js";

const log = createLogger("history");

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  source: "web" | "whatsapp";
  stats?: {
    durationMs: number;
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    numTurns: number;
  };
}

const MAX_MESSAGES = 500;
/** Legacy snapshot file (whole-array JSON); read once for migration. */
const HISTORY_FILE = process.env.HISTORY_FILE || "/data/chat-history.json";
/** Append-only log — one JSON message per line. Two overlapping instances can both append safely. */
const HISTORY_LOG_FILE = HISTORY_FILE.replace(/\.json$/, "") + ".jsonl";
/** Compact the log once this many lines were appended since the last load/compaction. */
const COMPACT_EVERY_APPENDS = MAX_MESSAGES;

let cache: ChatMessage[] | null = null;
let appendsSinceCompact = 0;

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.role === "string" && typeof v.content === "string" && typeof v.timestamp === "number";
}

function readLog(): ChatMessage[] {
  if (!existsSync(HISTORY_LOG_FILE)) return [];
  const messages: ChatMessage[] = [];
  for (const line of readFileSync(HISTORY_LOG_FILE, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isChatMessage(parsed)) messages.push(parsed);
    } catch (err) {
      log.warn(`Skipping corrupt history line: ${err}`);
    }
  }
  return messages;
}

function writeLog(messages: ChatMessage[]): void {
  atomicWriteFile(HISTORY_LOG_FILE, messages.map(m => JSON.stringify(m)).join("\n") + (messages.length ? "\n" : ""));
  appendsSinceCompact = 0;
}

/** One-time migration from the legacy whole-array snapshot to the jsonl log. */
function migrateLegacySnapshot(): ChatMessage[] {
  const legacy = safeReadJSON<unknown>(HISTORY_FILE, []);
  const messages = Array.isArray(legacy) ? legacy.filter(isChatMessage).slice(-MAX_MESSAGES) : [];
  if (messages.length > 0) {
    try {
      writeLog(messages);
      log.info(`Migrated ${messages.length} chat message(s) from ${HISTORY_FILE} to ${HISTORY_LOG_FILE}`);
    } catch (err) {
      log.error(`Failed to migrate chat history: ${err}`);
    }
  }
  return messages;
}

export function getHistory(): ChatMessage[] {
  if (cache) return cache;
  cache = existsSync(HISTORY_LOG_FILE) ? readLog().slice(-MAX_MESSAGES) : migrateLegacySnapshot();
  appendsSinceCompact = 0;
  return cache;
}

/**
 * Rewrite the log with only the most recent messages. Re-reads the file
 * first so lines appended by another instance are kept.
 */
function compactLog(): void {
  try {
    const merged = readLog().slice(-MAX_MESSAGES);
    writeLog(merged);
    cache = merged;
  } catch (err) {
    log.error(`Failed to compact history log: ${err}`);
  }
}

export function addMessage(msg: ChatMessage): void {
  const history = getHistory();
  cache = [...history, msg].slice(-MAX_MESSAGES);
  try {
    appendFileSync(HISTORY_LOG_FILE, JSON.stringify(msg) + "\n");
  } catch (err) {
    log.error(`Failed to append chat history: ${err}`);
    return;
  }
  appendsSinceCompact += 1;
  if (appendsSinceCompact >= COMPACT_EVERY_APPENDS) compactLog();
}

export function clearHistory(): void {
  cache = [];
  try {
    writeLog([]);
  } catch (err) {
    log.error(`Failed to clear history: ${err}`);
  }
}

/**
 * Build a compact recap of recent conversation for session continuity.
 * Used when a session is auto-reset to give the new session context
 * about what was just being discussed. Keeps it short to avoid
 * bloating the initial prompt.
 */
export function getRecentConversationRecap(maxMessages = 10, maxCharsPerMsg = 200): string {
  const history = getHistory();
  if (history.length === 0) return "";

  // Take the most recent messages (user + assistant only)
  const recent = history
    .filter(m => m.role === "user" || m.role === "assistant")
    .slice(-maxMessages);

  if (recent.length === 0) return "";

  const lines = recent.map(m => {
    const role = m.role === "user" ? "User" : "ARIA";
    const content = m.content.length > maxCharsPerMsg
      ? m.content.slice(0, maxCharsPerMsg) + "..."
      : m.content;
    return `  ${role}: ${content}`;
  });

  return `\n\n═══ RECENT CONVERSATION (session was auto-compacted for performance) ═══\nThe previous session was reset to keep responses fast. Here's what was just discussed:\n${lines.join("\n")}`;
}

export interface UsageData {
  totalMessages: number;
  totalResponses: number;
  webMessages: number;
  whatsappMessages: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  avgDurationMs: number;
  avgCostUsd: number;
  avgTurns: number;
  historyDays: number;
  todayResponses: number;
  todayTokens: number;
  todayCostUsd: number;
}

interface UsageTotals {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  duration: number;
  turns: number;
  web: number;
  whatsapp: number;
}

function sumUsage(messages: ChatMessage[]): UsageTotals {
  return messages.reduce<UsageTotals>((acc, msg) => {
    const s = msg.stats!;
    return {
      cost: acc.cost + s.totalCostUsd,
      inputTokens: acc.inputTokens + s.inputTokens,
      outputTokens: acc.outputTokens + s.outputTokens,
      duration: acc.duration + s.durationMs,
      turns: acc.turns + s.numTurns,
      web: acc.web + (msg.source === "web" ? 1 : 0),
      whatsapp: acc.whatsapp + (msg.source === "whatsapp" ? 1 : 0),
    };
  }, { cost: 0, inputTokens: 0, outputTokens: 0, duration: 0, turns: 0, web: 0, whatsapp: 0 });
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function getUsageData(): UsageData {
  const history = getHistory();
  const assistantMsgs = history.filter((m) => m.role === "assistant" && m.stats);
  const userMsgs = history.filter((m) => m.role === "user");
  const totals = sumUsage(assistantMsgs);

  const first = history[0]?.timestamp;
  const last = history[history.length - 1]?.timestamp;
  const days = first && last ? Math.max(1, Math.ceil((last - first) / 86400000)) : 1;

  const todayMsgs = assistantMsgs.filter((m) => m.timestamp >= startOfToday());
  const today = sumUsage(todayMsgs);
  const n = assistantMsgs.length;

  return {
    totalMessages: userMsgs.length,
    totalResponses: n,
    webMessages: totals.web,
    whatsappMessages: totals.whatsapp,
    totalTokens: totals.inputTokens + totals.outputTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    totalCostUsd: totals.cost,
    avgDurationMs: n > 0 ? totals.duration / n : 0,
    avgCostUsd: n > 0 ? totals.cost / n : 0,
    avgTurns: n > 0 ? totals.turns / n : 0,
    historyDays: days,
    todayResponses: todayMsgs.length,
    todayTokens: today.inputTokens + today.outputTokens,
    todayCostUsd: today.cost,
  };
}

export function getUsageStats(): string {
  const u = getUsageData();
  if (u.totalResponses === 0) {
    return "No usage data yet.";
  }

  const lines = [
    `**Usage Statistics**`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Messages | ${u.totalMessages} sent, ${u.totalResponses} responses |`,
    `| Source | ${u.webMessages} web, ${u.whatsappMessages} WhatsApp |`,
    `| Total tokens | ${u.totalTokens.toLocaleString()} (${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out) |`,
    `| Total cost | $${u.totalCostUsd.toFixed(4)} |`,
    `| Avg response | ${(u.avgDurationMs / 1000).toFixed(1)}s, $${u.avgCostUsd.toFixed(4)} |`,
    `| Avg turns | ${u.avgTurns.toFixed(1)} per response |`,
    `| History span | ${u.historyDays} day${u.historyDays > 1 ? "s" : ""} |`,
    ``,
    `**Today**: ${u.todayResponses} responses, ${u.todayTokens.toLocaleString()} tokens, $${u.todayCostUsd.toFixed(4)}`,
  ];

  return lines.join("\n");
}
