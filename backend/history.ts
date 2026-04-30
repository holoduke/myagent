import { safeReadJSON, atomicWriteJSON } from "./utils/file-store.js";
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
const HISTORY_FILE = process.env.HISTORY_FILE || "/data/chat-history.json";

let cache: ChatMessage[] | null = null;

export function getHistory(): ChatMessage[] {
  if (cache) return cache;
  cache = safeReadJSON<ChatMessage[]>(HISTORY_FILE, []);
  return cache;
}

function save(): void {
  try {
    atomicWriteJSON(HISTORY_FILE, cache, 0);
  } catch (err) {
    log.error(`Failed to save: ${err}`);
  }
}

export function addMessage(msg: ChatMessage): void {
  const history = getHistory();
  history.push(msg);
  // Trim to max size
  if (history.length > MAX_MESSAGES) {
    cache = history.slice(-MAX_MESSAGES);
  }
  save();
}

export function clearHistory(): void {
  cache = [];
  save();
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

export function getUsageData(): UsageData {
  const history = getHistory();
  const assistantMsgs = history.filter((m) => m.role === "assistant" && m.stats);
  const userMsgs = history.filter((m) => m.role === "user");

  let totalCost = 0, totalInputTokens = 0, totalOutputTokens = 0;
  let totalDuration = 0, totalTurns = 0, webMsgs = 0, waMsgs = 0;

  for (const msg of assistantMsgs) {
    const s = msg.stats!;
    totalCost += s.totalCostUsd;
    totalInputTokens += s.inputTokens;
    totalOutputTokens += s.outputTokens;
    totalDuration += s.durationMs;
    totalTurns += s.numTurns;
    if (msg.source === "web") webMsgs++;
    else if (msg.source === "whatsapp") waMsgs++;
  }

  const first = history[0]?.timestamp;
  const last = history[history.length - 1]?.timestamp;
  const days = first && last ? Math.max(1, Math.ceil((last - first) / 86400000)) : 1;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMsgs = assistantMsgs.filter((m) => m.timestamp >= todayStart.getTime());
  let todayCost = 0, todayTokens = 0;
  for (const msg of todayMsgs) {
    todayCost += msg.stats!.totalCostUsd;
    todayTokens += msg.stats!.inputTokens + msg.stats!.outputTokens;
  }

  return {
    totalMessages: userMsgs.length,
    totalResponses: assistantMsgs.length,
    webMessages: webMsgs,
    whatsappMessages: waMsgs,
    totalTokens: totalInputTokens + totalOutputTokens,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    totalCostUsd: totalCost,
    avgDurationMs: assistantMsgs.length > 0 ? totalDuration / assistantMsgs.length : 0,
    avgCostUsd: assistantMsgs.length > 0 ? totalCost / assistantMsgs.length : 0,
    avgTurns: assistantMsgs.length > 0 ? totalTurns / assistantMsgs.length : 0,
    historyDays: days,
    todayResponses: todayMsgs.length,
    todayTokens,
    todayCostUsd: todayCost,
  };
}

export function getUsageStats(): string {
  const history = getHistory();
  const assistantMsgs = history.filter((m) => m.role === "assistant" && m.stats);
  const userMsgs = history.filter((m) => m.role === "user");

  if (assistantMsgs.length === 0) {
    return "No usage data yet.";
  }

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalDuration = 0;
  let totalTurns = 0;
  let webMsgs = 0;
  let waMsgs = 0;

  for (const msg of assistantMsgs) {
    const s = msg.stats!;
    totalCost += s.totalCostUsd;
    totalInputTokens += s.inputTokens;
    totalOutputTokens += s.outputTokens;
    totalDuration += s.durationMs;
    totalTurns += s.numTurns;
    if (msg.source === "web") webMsgs++;
    else if (msg.source === "whatsapp") waMsgs++;
  }

  const totalTokens = totalInputTokens + totalOutputTokens;
  const avgDuration = totalDuration / assistantMsgs.length;
  const avgCost = totalCost / assistantMsgs.length;

  // Find date range
  const first = history[0]?.timestamp;
  const last = history[history.length - 1]?.timestamp;
  const days = first && last ? Math.max(1, Math.ceil((last - first) / 86400000)) : 1;

  // Today's stats
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMsgs = assistantMsgs.filter((m) => m.timestamp >= todayStart.getTime());
  let todayCost = 0;
  let todayTokens = 0;
  for (const msg of todayMsgs) {
    todayCost += msg.stats!.totalCostUsd;
    todayTokens += msg.stats!.inputTokens + msg.stats!.outputTokens;
  }

  const lines = [
    `**Usage Statistics**`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Messages | ${userMsgs.length} sent, ${assistantMsgs.length} responses |`,
    `| Source | ${webMsgs} web, ${waMsgs} WhatsApp |`,
    `| Total tokens | ${totalTokens.toLocaleString()} (${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out) |`,
    `| Total cost | $${totalCost.toFixed(4)} |`,
    `| Avg response | ${(avgDuration / 1000).toFixed(1)}s, $${avgCost.toFixed(4)} |`,
    `| Avg turns | ${(totalTurns / assistantMsgs.length).toFixed(1)} per response |`,
    `| History span | ${days} day${days > 1 ? "s" : ""} |`,
    ``,
    `**Today**: ${todayMsgs.length} responses, ${todayTokens.toLocaleString()} tokens, $${todayCost.toFixed(4)}`,
  ];

  return lines.join("\n");
}
