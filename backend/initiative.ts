import type { MemoryGraph } from "./memory/graph.js";
import type { WorkingMemory, BrainState } from "./memory/types.js";
import { GoalTracker } from "./goals.js";
import { getBrainConfig, getOwnerLocalDate } from "./brain-config.js";
import { createLogger } from "./logger.js";

const log = createLogger("initiative");

// ── Types ──

export interface InitiativeSignal {
  type: "follow_up_due" | "person_absent" | "goal_deadline" | "conversation_stale";
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

  // 1. Follow-up due
  for (const followUp of wm.pendingFollowUps) {
    if (followUp.dueAt && followUp.dueAt <= now) {
      signals.push({
        type: "follow_up_due",
        priority: 0.7,
        description: `Follow-up due: "${followUp.question}"${followUp.targetPerson ? ` (for ${followUp.targetPerson})` : ""}`,
        relatedNodeIds: [],
        suggestedAction: `Ask about: ${followUp.question}`,
      });
    }
  }

  // 2. Person absent — pinned person nodes with high access count, not seen in 7+ days
  const ABSENCE_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7 days
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
  const STALE_THRESHOLD = 48 * 60 * 60 * 1000;
  for (const thread of wm.conversationThreads) {
    if (
      thread.status === "active" &&
      thread.messageCount >= 3 &&
      (now - thread.lastMessageAt) > STALE_THRESHOLD
    ) {
      signals.push({
        type: "conversation_stale",
        priority: 0.3,
        description: `Conversation with ${(thread.participants || []).join(", ") || "unknown"} about "${thread.topic}" went quiet (${thread.messageCount} messages)`,
        relatedNodeIds: [],
        suggestedAction: `Follow up on "${thread.topic}" conversation`,
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
