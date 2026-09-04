import type { MemoryGraph } from "./memory/graph.js";
import type { WorkingMemory, BrainState, SignalOperation } from "./memory/types.js";
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
  /** Stable identity "<type>:<subject>" — the handle for snoozes (signalOps) and surfaced-count tracking */
  key: string;
  priority: number;
  description: string;
  relatedNodeIds: string[];
  suggestedAction?: string;
}

// ── Snooze / auto-downgrade tuning ──

const SNOOZE_MAX_DAYS = 90;
// After this many consecutive surfaced-without-clearing prompt appearances,
// a signal is capped at LOW priority — a repeated nag the brain never acted
// on shouldn't keep claiming MEDIUM/HIGH prompt attention.
const AUTO_DOWNGRADE_AFTER_SURFACES = 5;
const AUTO_DOWNGRADE_PRIORITY = 0.2; // LOW band (< 0.4)

function signalKey(type: InitiativeSignal["type"], subject: string): string {
  return `${type}:${subject.trim().slice(0, 60)}`;
}

// ── Detection (zero Claude cost) ──

export function detectInitiativeSignals(
  graph: MemoryGraph,
  wm: WorkingMemory,
  state?: BrainState,
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
        key: signalKey("follow_up_due", followUp.question),
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
        key: signalKey("person_absent", node.content),
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
      key: signalKey("goal_deadline", data.title),
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
        key: signalKey("conversation_stale", thread.topic || "unknown"),
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
        key: signalKey("frequency_anomaly", anomaly.contactName),
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
        key: signalKey("meeting_approaching", eventStr),
        priority: 0.6,
        description: `Upcoming event: ${eventStr}`,
        relatedNodeIds: [],
        suggestedAction: `Compile relevant context about attendees/topics for: ${eventStr}`,
      });
    }
  }

  // ── Snooze / auto-downgrade (only when brain state is available) ──
  let result = signals;
  if (state) {
    // Purge expired snoozes
    if (state.signalSnoozes) {
      for (const [key, snooze] of Object.entries(state.signalSnoozes)) {
        if (snooze.until <= now) delete state.signalSnoozes[key];
      }
    }
    // Reset surfaced counts for signals whose condition has cleared —
    // measured against the raw signal set so snoozed-but-still-firing
    // conditions keep their history.
    if (state.signalSurfacedCounts) {
      const activeKeys = new Set(signals.map(s => s.key));
      for (const key of Object.keys(state.signalSurfacedCounts)) {
        if (!activeKeys.has(key)) delete state.signalSurfacedCounts[key];
      }
    }
    // Skip snoozed signals entirely — the brain already made this decision
    if (state.signalSnoozes) {
      result = result.filter(s => {
        const snooze = state.signalSnoozes![s.key];
        if (snooze && snooze.until > now) {
          log(`Signal snoozed, skipping: "${s.key}" (until ${new Date(snooze.until).toISOString()} — ${snooze.reason})`);
          return false;
        }
        return true;
      });
    }
    // Auto-downgrade signals surfaced many consecutive ticks without action
    if (state.signalSurfacedCounts) {
      for (const s of result) {
        const surfaced = state.signalSurfacedCounts[s.key] ?? 0;
        if (surfaced >= AUTO_DOWNGRADE_AFTER_SURFACES && s.priority > AUTO_DOWNGRADE_PRIORITY) {
          s.priority = AUTO_DOWNGRADE_PRIORITY;
          s.description += ` (surfaced ${surfaced}× without action — auto-downgraded; snooze via signalOps if observe-only)`;
        }
      }
    }
  }

  // Sort by priority descending
  result.sort((a, b) => b.priority - a.priority);

  if (result.length > 0) {
    log(`Detected ${result.length} initiative signals (max priority: ${result[0].priority.toFixed(2)})`);
  }

  return result;
}

// ── Snooze / Surfaced Tracking (brain-controlled, mirrors reject_edge) ──

/** Record that these signals were actually surfaced in a think/reflect prompt.
 *  Counts drive auto-downgrade; entries reset when the condition clears
 *  (handled in detectInitiativeSignals) or the key is snoozed. */
export function recordSignalsSurfaced(state: BrainState, signals: InitiativeSignal[]): void {
  if (signals.length === 0) return;
  if (!state.signalSurfacedCounts) state.signalSurfacedCounts = {};
  for (const s of signals) {
    state.signalSurfacedCounts[s.key] = (state.signalSurfacedCounts[s.key] ?? 0) + 1;
  }
}

/** Apply brain-issued signalOps: snooze a signal key so it stops re-firing.
 *  Turns a repeated nag into a one-time decision. */
export function applySignalOps(state: BrainState, ops: SignalOperation[]): { applied: number; skipped: number } {
  const now = Date.now();
  let applied = 0;
  let skipped = 0;
  for (const op of ops) {
    if (!op || typeof op.key !== "string" || op.key.trim().length === 0
      || typeof op.snoozeDays !== "number" || !Number.isFinite(op.snoozeDays) || op.snoozeDays <= 0) {
      skipped++;
      continue;
    }
    const days = Math.min(op.snoozeDays, SNOOZE_MAX_DAYS);
    const reason = typeof op.reason === "string" ? op.reason.slice(0, 200) : "";
    if (!state.signalSnoozes) state.signalSnoozes = {};
    state.signalSnoozes[op.key.trim()] = { until: now + days * 24 * 60 * 60 * 1000, reason };
    if (state.signalSurfacedCounts) delete state.signalSurfacedCounts[op.key.trim()];
    log(`Signal snoozed by brain: "${op.key.trim()}" for ${days}d — ${reason || "(no reason given)"}`);
    applied++;
  }
  return { applied, skipped };
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
