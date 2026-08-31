import type { MemoryGraph } from "./memory/graph.js";
import type { WorkingMemory, BrainState } from "./memory/types.js";
import { GoalTracker } from "./goals.js";
import { getBrainConfig, getOwnerLocalDate, getOwnerLocalDay } from "./brain-config.js";
import { createLogger } from "./logger.js";
import { detectAnomalies, lastMessageAtForName } from "./frequency-tracker.js";
import {
  downtimeOverlapMs,
  DOWNTIME_SUPPRESS_FRACTION,
  DOWNTIME_LOW_CONFIDENCE_FRACTION,
} from "./downtime-tracker.js";

const log = createLogger("initiative");

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
    if (!node.pinned || node.accessCount <= 5) continue;
    // Absence is measured against observed reality: the person's last actual
    // message (frequency baselines). node.lastAccessedAt only tracks graph
    // access during think ticks, which goes stale whenever the brain is
    // degraded even though observation keeps running — and such windows can
    // predate the downtime tracker, so overlap suppression can't catch them.
    // Fall back to lastAccessedAt only when no baseline entry matches.
    const lastSeenAt = lastMessageAtForName(node.content) ?? node.lastAccessedAt;
    if ((now - lastSeenAt) > ABSENCE_THRESHOLD) {
      // Measure absence net of system downtime — time ARIA was deaf says
      // nothing about the person. Mostly-downtime windows are outage
      // artifacts and are suppressed entirely; partial overlap is surfaced
      // but annotated and capped at LOW priority.
      const absenceMs = now - lastSeenAt;
      const downMs = downtimeOverlapMs(lastSeenAt, now);
      const downFraction = downMs / absenceMs;
      const effectiveAbsenceMs = absenceMs - downMs;
      if (downFraction >= DOWNTIME_SUPPRESS_FRACTION || effectiveAbsenceMs <= ABSENCE_THRESHOLD) {
        continue;
      }
      const lowConfidence = downFraction >= DOWNTIME_LOW_CONFIDENCE_FRACTION;
      const downDays = Math.round(downMs / (24 * 60 * 60 * 1000));
      signals.push({
        type: "person_absent",
        priority: lowConfidence ? 0.2 : 0.4,
        description: `Haven't heard from/about "${node.content.slice(0, 40)}" in ${Math.floor(absenceMs / (24 * 60 * 60 * 1000))} days${downDays >= 1 ? ` (window overlaps ${downDays}d system downtime${lowConfidence ? " — low confidence" : ""})` : ""}`,
        relatedNodeIds: [node.id],
        suggestedAction: lowConfidence
          ? `Silence overlaps system downtime — verify before checking in about ${node.content.slice(0, 30)}`
          : `Check in about ${node.content.slice(0, 30)}`,
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
  try {
    const anomalies = detectAnomalies();
    for (const anomaly of anomalies) {
      // Mostly-downtime silence windows never leave detectAnomalies; what
      // arrives here with likelyArtifact set is partial overlap (≥25%) —
      // low confidence, capped at LOW priority so it can't trigger check-ins.
      signals.push({
        type: "frequency_anomaly",
        priority: anomaly.likelyArtifact ? 0.2 : anomaly.type === "silence" ? 0.5 : 0.4,
        description: anomaly.description,
        relatedNodeIds: [],
        suggestedAction: anomaly.likelyArtifact
          ? `Silence overlaps system downtime — verify before checking in with ${anomaly.contactName}`
          : anomaly.type === "silence"
            ? anomaly.isGroup
              ? `The "${anomaly.contactName}" group is unusually quiet — verify recent group activity before any check-in`
              : `Check in with ${anomaly.contactName} — unusually quiet`
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
