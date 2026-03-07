import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFileSync } from "fs";
import type { WorkingMemory, PendingFollowUp, ConversationThread, TemporalContext } from "./types.js";
import type { Observation } from "../observer.js";
import { getBrainConfig, getOwnerLocalTime } from "../brain-config.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [working-memory] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const WM_FILE = `${BRAIN_DIR}/working-memory.json`;

function defaultTemporalContext(): TemporalContext {
  return {
    dayOfWeek: "Monday",
    timeOfDay: "morning",
    hour: 8,
    date: new Date().toISOString().slice(0, 10),
    isWeekend: false,
    upcomingEvents: [],
  };
}

function defaultWorkingMemory(): WorkingMemory {
  return {
    currentContext: "",
    mood: "neutral",
    shortTermTracking: [],
    activatedNodeIds: [],
    lastUpdated: 0,
    activeGoals: [],
    pendingFollowUps: [],
    conversationThreads: [],
    temporal: defaultTemporalContext(),
  };
}

export function loadWorkingMemory(): WorkingMemory {
  try {
    if (existsSync(WM_FILE)) {
      return { ...defaultWorkingMemory(), ...JSON.parse(readFileSync(WM_FILE, "utf-8")) };
    }
  } catch {
    log("Failed to read working memory, using defaults");
  }
  return defaultWorkingMemory();
}

export function saveWorkingMemory(wm: WorkingMemory): void {
  try {
    if (!existsSync(BRAIN_DIR)) {
      mkdirSync(BRAIN_DIR, { recursive: true });
    }
    const tmp = WM_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(wm, null, 2));
    renameSync(tmp, WM_FILE);
  } catch (err) {
    log(`Failed to save working memory: ${err}`);
  }
}

export function updateWorkingMemory(
  wm: WorkingMemory,
  updates: {
    currentContext?: string;
    mood?: string;
    shortTermTracking?: string[];
    activatedNodeIds?: string[];
    pendingFollowUps?: PendingFollowUp[];
    conversationThreads?: ConversationThread[];
  },
): WorkingMemory {
  if (updates.currentContext !== undefined) wm.currentContext = updates.currentContext;
  if (updates.mood !== undefined) wm.mood = updates.mood;
  if (updates.shortTermTracking !== undefined) wm.shortTermTracking = updates.shortTermTracking;
  if (updates.activatedNodeIds !== undefined) wm.activatedNodeIds = updates.activatedNodeIds;
  if (updates.pendingFollowUps !== undefined) wm.pendingFollowUps = updates.pendingFollowUps;
  if (updates.conversationThreads !== undefined) wm.conversationThreads = updates.conversationThreads;
  wm.lastUpdated = Date.now();
  return wm;
}

// ── Auto-Cleanup ──

const MAX_TRACKING_ITEMS = 25;
const MAX_FOLLOWUP_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function cleanupWorkingMemory(wm: WorkingMemory): { trackingTrimmed: number; followUpsPruned: number } {
  let trackingTrimmed = 0;
  let followUpsPruned = 0;
  const now = Date.now();

  // Cap shortTermTracking to most recent items
  if (wm.shortTermTracking.length > MAX_TRACKING_ITEMS) {
    trackingTrimmed = wm.shortTermTracking.length - MAX_TRACKING_ITEMS;
    wm.shortTermTracking = wm.shortTermTracking.slice(-MAX_TRACKING_ITEMS);
  }

  // Remove expired follow-ups (older than 30 days with no dueAt, or past dueAt by 7 days)
  if (wm.pendingFollowUps && wm.pendingFollowUps.length > 0) {
    const before = wm.pendingFollowUps.length;
    wm.pendingFollowUps = wm.pendingFollowUps.filter(fu => {
      if (fu.dueAt && now > fu.dueAt + 7 * 24 * 60 * 60 * 1000) return false; // 7 days past due
      if (!fu.dueAt && now - fu.createdAt > MAX_FOLLOWUP_AGE_MS) return false; // 30 days old, no deadline
      return true;
    });
    followUpsPruned = before - wm.pendingFollowUps.length;
  }

  return { trackingTrimmed, followUpsPruned };
}

// ── Temporal Context ──

export function populateTemporalContext(wm: WorkingMemory): void {
  const now = new Date();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const { hour, dayOfWeek: day } = getOwnerLocalTime(getBrainConfig().ownerTimezone, now);

  let timeOfDay: TemporalContext["timeOfDay"];
  if (hour >= 5 && hour < 12) timeOfDay = "morning";
  else if (hour >= 12 && hour < 17) timeOfDay = "afternoon";
  else if (hour >= 17 && hour < 21) timeOfDay = "evening";
  else timeOfDay = "night";

  wm.temporal = {
    dayOfWeek: dayNames[day],
    timeOfDay,
    hour,
    date: now.toISOString().slice(0, 10),
    isWeekend: day === 0 || day === 6,
    upcomingEvents: wm.temporal?.upcomingEvents || [],
  };
}

// ── Conversation Thread Tracking ──

export function updateConversationThreads(wm: WorkingMemory, observations: Observation[]): void {
  const now = Date.now();
  const STALE_THRESHOLD = 48 * 60 * 60 * 1000; // 48 hours

  for (const obs of observations) {
    if (!obs.sender) continue;

    // For DMs, key by the chat counterpart (chatJid), not the sender — so both
    // incoming and outgoing messages map to the same thread.
    const key = obs.isGroup ? `group:${obs.groupName || obs.senderJid}` : `dm:${obs.chatJid || obs.senderJid}`;
    let thread = wm.conversationThreads.find(t => t.id === key);

    if (!thread) {
      thread = {
        id: key,
        participants: [obs.sender],
        topic: obs.text.slice(0, 60),
        lastMessageAt: obs.timestamp,
        messageCount: 0,
        status: "active",
      };
      wm.conversationThreads.push(thread);
    }

    thread.lastMessageAt = obs.timestamp;
    thread.messageCount++;
    thread.status = "active";

    if (!thread.participants.includes(obs.sender)) {
      thread.participants.push(obs.sender);
    }
  }

  // Mark stale threads
  for (const thread of wm.conversationThreads) {
    if (thread.status === "active" && (now - thread.lastMessageAt) > STALE_THRESHOLD) {
      thread.status = "stale";
    }
  }

  // Keep max 20 threads, dropping oldest closed ones first
  if (wm.conversationThreads.length > 20) {
    wm.conversationThreads.sort((a, b) => {
      if (a.status === "closed" && b.status !== "closed") return 1;
      return b.lastMessageAt - a.lastMessageAt;
    });
    wm.conversationThreads = wm.conversationThreads.slice(0, 20);
  }
}
