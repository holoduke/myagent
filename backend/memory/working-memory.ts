import { safeReadJSON, atomicWriteJSON, ensureDir } from "../utils/file-store.js";
import type { WorkingMemory, PendingFollowUp, ConversationThread, TemporalContext, TemporalSummaries } from "./types.js";
import type { Observation } from "../observer.js";
import { getBrainConfig, getOwnerLocalTime, getOwnerLocalDate } from "../brain-config.js";
import { extractKeywordsFromText } from "./activation.js";
import { createLogger } from "../logger.js";
import { BRAIN_DIR } from "../config.js";

const log = createLogger("working-memory");


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
  return { ...defaultWorkingMemory(), ...safeReadJSON<Partial<WorkingMemory>>(WM_FILE, {}) };
}

export function saveWorkingMemory(wm: WorkingMemory): void {
  try {
    ensureDir(BRAIN_DIR);
    atomicWriteJSON(WM_FILE, wm);
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

// ── Follow-Up Auto-Resolution Detection ──

/**
 * Scan outgoing observations for keyword overlap with pending follow-ups.
 * If a follow-up mentions a person name or topic keyword that appears in
 * a new outgoing message from the owner, mark it as potentially resolved.
 */
export function scanFollowUpsForResolution(wm: WorkingMemory, observations: Observation[]): number {
  if (!wm.pendingFollowUps || wm.pendingFollowUps.length === 0) return 0;

  // Only consider outgoing messages (isFromMe) — these indicate the owner acted
  const outgoing = observations.filter(obs => obs.isFromMe && obs.text.length > 0);
  if (outgoing.length === 0) return 0;

  const now = Date.now();
  let marked = 0;

  for (const fu of wm.pendingFollowUps) {
    if (fu.potentiallyResolved) continue;

    // Build keyword set from the follow-up question + context + targetPerson
    // Filter out short keywords (< 4 chars) to avoid noise words that slip through stop-word filtering
    const keywords = extractKeywords(fu.question + " " + fu.context + " " + (fu.targetPerson || ""))
      .filter(kw => kw.length >= 4);
    if (keywords.length === 0) continue;

    // Check if any outgoing message has keyword overlap
    for (const obs of outgoing) {
      const obsText = obs.text.toLowerCase();
      const senderMatch = fu.targetPerson && obs.chatName
        ? obs.chatName.toLowerCase().includes(fu.targetPerson.toLowerCase()) ||
          (obs.sender && obs.sender.toLowerCase().includes(fu.targetPerson.toLowerCase()))
        : false;

      const keywordHits = keywords.filter(kw => obsText.includes(kw));
      const overlapRatio = keywordHits.length / keywords.length;
      // Require minimum 30% keyword overlap AND either:
      // - sender match + 2 keyword hits, or
      // - 3+ keyword hits without sender match
      if (overlapRatio >= 0.3 && ((senderMatch && keywordHits.length >= 2) || keywordHits.length >= 3)) {
        fu.potentiallyResolved = true;
        fu.potentiallyResolvedAt = now;
        marked++;
        break;
      }
    }
  }

  return marked;
}

/** Extract meaningful lowercase keywords from text — delegates to activation.ts for consistent stop word filtering */
function extractKeywords(text: string): string[] {
  return extractKeywordsFromText(text);
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
    date: getOwnerLocalDate(getBrainConfig().ownerTimezone, now),
    isWeekend: day === 0 || day === 6,
    upcomingEvents: wm.temporal?.upcomingEvents || [],
  };
}

// ── Conversation Thread Tracking ──

// Newsletter / automation sender patterns. If a participant string matches one
// of these, the thread is treated as one-way noise — never promoted to "active"
// in the prompt, and never written as a fresh thread. Defense in depth: applied
// at both write time (here) and render time (brain-prompt.ts).
const NEWSLETTER_SUBSTRINGS = [
  "noreply",
  "no-reply",
  "notifications.",
  "newsletter",
  "savedsearches",
  "mailings.",
  "updates@",
  "bounce",
  // Promotional/automation mailbox prefixes. Participant strings look like
  // "Display Name <prefix@domain>", so substring match on "prefix@" is enough.
  "promotion@",
  "promotions@",
  "marketing@",
  "news@",
  "newsletter@",
  "deals@",
  "offers@",
  "info@",
  "mailing@",
];

const NEWSLETTER_DOMAINS = [
  "autoscout24",
  "schoolkassa",
  "rdw",
  "anwb.nl/notifications",
  // Mass-promotional retail domains — sender from these is always marketing.
  "aliexpress.com",
  "temu.com",
  "shein.com",
  "wish.com",
  "banggood.com",
];

// Clickbait subject/topic patterns. Email observations are stored as
// "[EMAIL] Subject: <subject>\n\n<body>" so the thread topic (first 60 chars)
// captures the subject. If the topic matches one of these marketing tropes,
// the thread is treated as noise even when the sender slips past the address
// filter (e.g. a mixed-use domain that also sends real mail).
const CLICKBAIT_TOPIC_PATTERNS: RegExp[] = [
  /wacht\s+op\s+u\b/i,
  /\bklik\s+hier\b/i,
  /\b\d{1,3}\s*%\s*(korting|off|discount)\b/i,
  /\blaatste\s+kans\b/i,
  /\blast\s+chance\b/i,
  /\blimited\s+time\b/i,
  /\bbeperkte?\s+aanbieding\b/i,
  /\bspecial\s+offer\b/i,
  /\bact\s+now\b/i,
  /\bonly\s+today\b/i,
  /\balleen\s+vandaag\b/i,
];

export function isNewsletterParticipant(participant: string | undefined | null): boolean {
  if (!participant) return false;
  const p = participant.toLowerCase();
  for (const sub of NEWSLETTER_SUBSTRINGS) {
    if (p.includes(sub)) return true;
  }
  for (const dom of NEWSLETTER_DOMAINS) {
    if (p.includes(dom)) return true;
  }
  return false;
}

export function isClickbaitTopic(topic: string | undefined | null): boolean {
  if (!topic) return false;
  return CLICKBAIT_TOPIC_PATTERNS.some(re => re.test(topic));
}

function threadHasNewsletterParticipant(participants: string[] | string | undefined): boolean {
  if (!participants) return false;
  const list = Array.isArray(participants) ? participants : [participants];
  return list.some(isNewsletterParticipant);
}

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
      // Reject newsletter/automation senders at write time — they're never real conversations.
      if (isNewsletterParticipant(obs.sender) || isNewsletterParticipant(obs.chatName) || isNewsletterParticipant(obs.chatJid)) {
        continue;
      }
      // Also reject if the topic (first 60 chars of text) looks like marketing clickbait.
      if (isClickbaitTopic(obs.text.slice(0, 60))) {
        continue;
      }
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

  // Sweep any pre-existing newsletter / clickbait threads that slipped in
  // during prior ticks (before these guards were added, or via an alternative
  // write path). Fixes already-stuck entries like the AliExpress
  // "Uw voertuig wacht op u" promo blast.
  wm.conversationThreads = wm.conversationThreads.filter(
    t => !threadHasNewsletterParticipant(t.participants) && !isClickbaitTopic(t.topic),
  );

  // Thread lifecycle: active → stale (48h) → closed (7d) → removed (14d)
  const CLOSED_THRESHOLD = 7 * 24 * 60 * 60 * 1000;  // 7 days since last message
  const REMOVE_THRESHOLD = 14 * 24 * 60 * 60 * 1000;  // 14 days since last message

  // Remove closed threads older than 14 days
  wm.conversationThreads = wm.conversationThreads.filter(thread => {
    if (thread.status === "closed" && (now - thread.lastMessageAt) > REMOVE_THRESHOLD) return false;
    return true;
  });

  for (const thread of wm.conversationThreads) {
    const age = now - thread.lastMessageAt;
    if (thread.status === "active" && age > STALE_THRESHOLD) {
      thread.status = "stale";
    }
    if (thread.status === "stale" && age > CLOSED_THRESHOLD) {
      thread.status = "closed";
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

// ── Hierarchical Temporal Summaries ──

const MAX_DAILY_SUMMARIES = 14;   // Keep 2 weeks of daily summaries
const MAX_WEEKLY_SUMMARIES = 12;  // Keep 3 months of weekly summaries

/** Get the Monday of the week containing the given date (ISO week) */
function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Update the daily summary for today. Called at the end of each think tick.
 * The summary is a one-line compressed version of currentContext.
 */
export function updateDailySummary(wm: WorkingMemory): void {
  if (!wm.temporalSummaries) {
    wm.temporalSummaries = { daily: {}, weekly: {} };
  }

  const today = wm.temporal?.date || new Date().toISOString().slice(0, 10);
  // Compress currentContext to a one-liner (first 200 chars)
  if (wm.currentContext) {
    wm.temporalSummaries.daily[today] = wm.currentContext.slice(0, 200);
  }

  // Prune old daily summaries beyond retention window
  const dailyKeys = Object.keys(wm.temporalSummaries.daily).sort();
  if (dailyKeys.length > MAX_DAILY_SUMMARIES) {
    for (const key of dailyKeys.slice(0, dailyKeys.length - MAX_DAILY_SUMMARIES)) {
      delete wm.temporalSummaries.daily[key];
    }
  }
}

/**
 * Compile a weekly summary from daily summaries. Called during consolidation.
 * Takes the daily summaries for the completed week and compresses them into one entry.
 */
export function compileWeeklySummary(wm: WorkingMemory): void {
  if (!wm.temporalSummaries) {
    wm.temporalSummaries = { daily: {}, weekly: {} };
  }

  const today = new Date();
  const thisWeekStart = getWeekStart(today);
  const dailyKeys = Object.keys(wm.temporalSummaries.daily).sort();

  // Find daily entries from completed weeks (before this week)
  const pastWeekDays = new Map<string, string[]>();
  for (const key of dailyKeys) {
    const weekStart = getWeekStart(new Date(key));
    if (weekStart >= thisWeekStart) continue; // skip current week
    if (!pastWeekDays.has(weekStart)) pastWeekDays.set(weekStart, []);
    pastWeekDays.get(weekStart)!.push(wm.temporalSummaries.daily[key]);
  }

  // Create weekly summaries for completed weeks
  for (const [weekStart, dailies] of pastWeekDays) {
    if (wm.temporalSummaries.weekly[weekStart]) continue; // already compiled
    // Combine daily summaries, truncate to 300 chars
    wm.temporalSummaries.weekly[weekStart] = dailies.join(" | ").slice(0, 300);
  }

  // Prune old weekly summaries
  const weeklyKeys = Object.keys(wm.temporalSummaries.weekly).sort();
  if (weeklyKeys.length > MAX_WEEKLY_SUMMARIES) {
    for (const key of weeklyKeys.slice(0, weeklyKeys.length - MAX_WEEKLY_SUMMARIES)) {
      delete wm.temporalSummaries.weekly[key];
    }
  }
}
