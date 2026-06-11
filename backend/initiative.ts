import { existsSync, openSync, fstatSync, readSync, closeSync } from "fs";
import type { MemoryGraph } from "./memory/graph.js";
import type { WorkingMemory, BrainState } from "./memory/types.js";
import { GoalTracker } from "./goals.js";
import { getBrainConfig, getOwnerLocalDate, getOwnerLocalDay } from "./brain-config.js";
import { createLogger } from "./logger.js";
import { detectAnomalies, type FrequencyAnomaly } from "./frequency-tracker.js";
import { BRAIN_DIR } from "./config.js";

const log = createLogger("initiative");

const OBSERVATIONS_FILE = `${BRAIN_DIR}/observations.jsonl`;

// Owner-quiet anomalies are incoherent (the owner is the observer; activity
// is by definition observed every tick). Strip them out wherever they appear.
function stripLidPrefix(jid: string): string {
  const match = jid.match(/^\d+:(\d+@s\.whatsapp\.net)$/);
  return match ? match[1] : jid;
}

function isOwnerJid(jid: string): boolean {
  const ownerPhone = process.env.OWNER_PHONE;
  if (!ownerPhone) return false;
  const ownerJid = `${ownerPhone}@s.whatsapp.net`;
  if (jid === ownerJid) return true;
  if (stripLidPrefix(jid) === ownerJid) return true;
  // Also catch bare phone-only or @lid forms that carry the owner phone digits.
  return jid.startsWith(`${ownerPhone}@`) || jid.startsWith(`${ownerPhone}:`);
}

/**
 * Read the last chunk of the observations log (up to ~1MB) and return parsed
 * recent entries newer than `cutoffMs`. Used to validate frequency-silence
 * anomalies against group-chat activity that the per-JID baseline may miss
 * (e.g. when a contact's group participant JID differs from their DM JID).
 */
function readRecentObservationSenders(cutoffMs: number): Array<{ senderJid: string; sender: string; timestamp: number }> {
  if (!existsSync(OBSERVATIONS_FILE)) return [];
  let fd: number;
  try {
    fd = openSync(OBSERVATIONS_FILE, "r");
  } catch {
    return [];
  }
  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize === 0) return [];
    const chunkSize = Math.min(fileSize, 1024 * 1024);
    const buffer = Buffer.alloc(chunkSize);
    readSync(fd, buffer, 0, chunkSize, fileSize - chunkSize);
    const text = buffer.toString("utf-8");
    const lines = text.split("\n").filter(Boolean);
    if (chunkSize < fileSize && lines.length > 0) lines.shift();
    const result: Array<{ senderJid: string; sender: string; timestamp: number }> = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { timestamp?: number; sender?: string; senderJid?: string; isFromMe?: boolean };
        if (!entry.timestamp || entry.timestamp < cutoffMs) continue;
        if (entry.isFromMe) continue;
        if (!entry.senderJid) continue;
        result.push({ senderJid: entry.senderJid, sender: entry.sender || "", timestamp: entry.timestamp });
      } catch { /* skip malformed */ }
    }
    return result;
  } finally {
    closeSync(fd);
  }
}

/**
 * Check whether a contact has been active anywhere (group or DM) within
 * `windowDays`. Match on senderJid (with LID normalization) AND display name
 * to cover cases where group participant JIDs differ from DM JIDs.
 */
function contactActiveAcrossAllChats(anomaly: FrequencyAnomaly, windowDays: number): boolean {
  const cutoff = Date.now() - windowDays * 86400000;
  const recent = readRecentObservationSenders(cutoff);
  if (recent.length === 0) return false;
  const targetJid = anomaly.contactJid;
  const targetJidNormalized = stripLidPrefix(targetJid);
  const targetName = (anomaly.contactName || "").toLowerCase().trim();
  for (const r of recent) {
    if (r.senderJid === targetJid) return true;
    if (stripLidPrefix(r.senderJid) === targetJidNormalized) return true;
    if (targetName && r.sender && r.sender.toLowerCase().trim() === targetName) return true;
  }
  return false;
}

// ── Types ──

export interface InitiativeSignal {
  type: "follow_up_due" | "person_absent" | "goal_deadline" | "conversation_stale" | "frequency_anomaly" | "meeting_approaching";
  priority: number;
  description: string;
  relatedNodeIds: string[];
  suggestedAction?: string;
}

// ── Detection (zero Claude cost) ──

export function detectInitiativeSignals(
  graph: MemoryGraph,
  wm: WorkingMemory,
): InitiativeSignal[] {
  const now = Date.now();
  const signals: InitiativeSignal[] = [];

  // Weekend detection for heuristic signals (person_absent, conversation_stale).
  // follow_up_due and goal_deadline are NOT weekend-adjusted — they have explicit
  // timestamps/deadlines, so if they're due, they're due regardless of day.
  const ownerDay = getOwnerLocalDay(getBrainConfig().ownerTimezone);
  const isWeekend = ownerDay === 0 || ownerDay === 6; // Sunday or Saturday

  // 1. Follow-up due — no weekend suppression (explicit dueAt timestamp).
  // Priority scales inversely with how overdue it is.
  // Fresh overdue: 0.7, after 7 days: ~0.35, after 30 days: ~0.1
  const FOLLOW_UP_DECAY_DAYS = 7; // half-life in days
  for (const followUp of wm.pendingFollowUps) {
    if (followUp.dueAt && followUp.dueAt <= now) {
      const overdueDays = (now - followUp.dueAt) / (24 * 60 * 60 * 1000);
      const decayFactor = Math.pow(0.5, overdueDays / FOLLOW_UP_DECAY_DAYS);
      const priority = Math.max(0.1, 0.7 * decayFactor); // floor at 0.1 so it never fully disappears
      signals.push({
        type: "follow_up_due",
        priority,
        description: `Follow-up due${overdueDays >= 1 ? ` (${Math.floor(overdueDays)}d overdue)` : ""}: "${followUp.question}"${followUp.targetPerson ? ` (for ${followUp.targetPerson})` : ""}`,
        relatedNodeIds: [],
        suggestedAction: `Ask about: ${followUp.question}`,
      });
    }
  }

  // 2. Person absent — pinned person nodes with high access count, not seen in 7+ days
  // Weekend multiplier: raise threshold to avoid false positives from normal weekend quiet
  const absenceMultiplier = isWeekend ? 1.5 : 1;
  const ABSENCE_THRESHOLD = 7 * 24 * 60 * 60 * 1000 * absenceMultiplier; // 7d, 10.5d on weekends
  const personNodes = graph.findByType("person");
  for (const node of personNodes) {
    if (node.pinned && node.accessCount > 5 && (now - node.lastAccessedAt) > ABSENCE_THRESHOLD) {
      signals.push({
        type: "person_absent",
        priority: 0.4,
        description: `Haven't heard from/about "${node.content.slice(0, 40)}" in ${Math.floor((now - node.lastAccessedAt) / (24 * 60 * 60 * 1000))} days`,
        relatedNodeIds: [node.id],
        suggestedAction: `Check in about ${node.content.slice(0, 30)}`,
      });
    }
  }

  // 3. Goal deadline approaching or overdue
  const goalTracker = new GoalTracker(graph);
  const deadlineGoals = goalTracker.checkDeadlines();
  for (const { nodeId, data, status } of deadlineGoals) {
    signals.push({
      type: "goal_deadline",
      priority: status === "overdue" ? 0.8 : 0.6,
      description: `Goal "${data.title}" is ${status} (${data.progress}% complete)`,
      relatedNodeIds: [nodeId],
      suggestedAction: status === "overdue"
        ? `Review overdue goal: ${data.title}`
        : `Goal deadline approaching: ${data.title}`,
    });
  }

  // 4. Conversation stale — active threads with 3+ messages, quiet >48h
  // Weekend multiplier: conversations naturally go quiet on weekends
  const staleMultiplier = isWeekend ? 2 : 1;
  const STALE_THRESHOLD = 48 * 60 * 60 * 1000 * staleMultiplier; // 48h, 96h on weekends
  for (const thread of wm.conversationThreads) {
    if (
      thread.status === "active" &&
      thread.messageCount >= 3 &&
      (now - thread.lastMessageAt) > STALE_THRESHOLD
    ) {
      signals.push({
        type: "conversation_stale",
        priority: 0.3,
        description: `Conversation with ${Array.isArray(thread.participants) ? thread.participants.join(", ") : (thread.participants || "unknown")} about "${thread.topic}" went quiet (${thread.messageCount} messages)`,
        relatedNodeIds: [],
        suggestedAction: `Follow up on "${thread.topic}" conversation`,
      });
    }
  }

  // 5. Frequency anomaly — unusual silence or spikes from known contacts (Phase 5b)
  // Owner-quiet signals are incoherent (we observe ourselves every tick) and are
  // dropped here. For non-owner silence we require ≥3× normal gap (tighter than
  // the baseline 2× check) and verify the contact has no recent activity in any
  // group chat — group participant JIDs can differ from DM JIDs, so per-JID
  // baselines can flag people who are actually highly active in shared groups.
  const SILENCE_GAP_MULTIPLIER = 3;
  try {
    const anomalies = detectAnomalies();
    for (const anomaly of anomalies) {
      if (isOwnerJid(anomaly.contactJid)) {
        log(`Suppressed owner-quiet anomaly for ${anomaly.contactName} (jid=${anomaly.contactJid})`);
        continue;
      }
      if (anomaly.type === "silence") {
        const normalGapDays = anomaly.baselineMean > 0 ? 1 / anomaly.baselineMean : Infinity;
        if (anomaly.daysSinceLastMessage < normalGapDays * SILENCE_GAP_MULTIPLIER) {
          continue; // too close to baseline gap to be a reliable signal
        }
        if (contactActiveAcrossAllChats(anomaly, anomaly.daysSinceLastMessage)) {
          log(`Suppressed silence anomaly for ${anomaly.contactName} — found recent activity in another chat`);
          continue;
        }
      }
      signals.push({
        type: "frequency_anomaly",
        priority: anomaly.type === "silence" ? 0.5 : 0.4,
        description: anomaly.description,
        relatedNodeIds: [],
        suggestedAction: anomaly.type === "silence"
          ? `Check in with ${anomaly.contactName} — unusually quiet`
          : `Note: ${anomaly.contactName} is unusually active today`,
      });
    }
  } catch (err) {
    log(`Frequency anomaly detection error (non-fatal): ${err}`);
  }

  // 6. Meeting approaching — pre-meeting briefing signal (Phase 6a)
  if (wm.temporal.upcomingEvents.length > 0) {
    for (const eventStr of wm.temporal.upcomingEvents) {
      // Parse event time from the string (format varies but often includes time)
      // upcomingEvents are populated by populateTemporalContext, which includes events within the next few hours
      signals.push({
        type: "meeting_approaching",
        priority: 0.6,
        description: `Upcoming event: ${eventStr}`,
        relatedNodeIds: [],
        suggestedAction: `Compile relevant context about attendees/topics for: ${eventStr}`,
      });
    }
  }

  // Sort by priority descending
  signals.sort((a, b) => b.priority - a.priority);

  if (signals.length > 0) {
    log(`Detected ${signals.length} initiative signals (max priority: ${signals[0].priority.toFixed(2)})`);
  }

  return signals;
}

// ── Daily Budget Tracking ──

const MAX_INITIATIVE_THINKS_PER_DAY = 3;

export function canTriggerInitiativeThink(state: BrainState): boolean {
  const today = getOwnerLocalDate(getBrainConfig().ownerTimezone);

  if (state.initiativeBudgetDate !== today) {
    state.initiativeBudgetDate = today;
    state.initiativeThinksToday = 0;
  }
  return state.initiativeThinksToday < MAX_INITIATIVE_THINKS_PER_DAY;
}

export function recordInitiativeThink(state: BrainState): void {
  state.initiativeThinksToday++;
  log(`Initiative think #${state.initiativeThinksToday}/${MAX_INITIATIVE_THINKS_PER_DAY} today`);
}

// ── Format for Prompt ──

export function formatInitiativeSignals(signals: InitiativeSignal[]): string {
  if (signals.length === 0) return "";

  return `═══ INITIATIVE SIGNALS ═══

These signals suggest proactive actions you might take. Act when it feels natural, not obligatory.

${signals.map(s => {
    const priority = s.priority >= 0.7 ? "HIGH" : s.priority >= 0.4 ? "MEDIUM" : "LOW";
    return `[${priority}] ${s.description}${s.suggestedAction ? `\n  → Suggested: ${s.suggestedAction}` : ""}`;
  }).join("\n\n")}
`;
}
