import { readFileSync, writeFileSync, existsSync } from "fs";

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
  try {
    if (existsSync(HISTORY_FILE)) {
      cache = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
      return cache!;
    }
  } catch {
    // Corrupted file, start fresh
  }
  cache = [];
  return cache;
}

function save(): void {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(cache, null, 0));
  } catch (err) {
    console.error("[history] Failed to save:", err);
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
