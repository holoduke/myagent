/**
 * Pure tick-scheduling policy for the brain loop: which tick (if any) runs,
 * how long it may take, and how the circuit breaker backs off. No I/O — the
 * orchestrator in brain.ts gathers the inputs and acts on the decision.
 */

export type LlmTickKind = "think" | "consolidate" | "reflect";

/** Inactivity timeouts passed to askClaudeStreaming per tick kind. */
export const LLM_TIMEOUT_MS: Record<LlmTickKind, number> = {
  think: 300_000,
  consolidate: 300_000,
  reflect: 600_000,
};

/** Margin on top of the LLM timeout for context selection, prompt building and post-processing. */
export const TICK_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Wall-clock budget for a tick. Must exceed the LLM timeout, otherwise the tick
 * is reported as failed while the LLM call is still running (orphaned work).
 * BRAIN_TICK_TIMEOUT can only raise the budget, never lower it below the LLM timeout.
 */
export function tickTimeoutFor(kind: LlmTickKind, envOverrideMs?: number): number {
  const floor = LLM_TIMEOUT_MS[kind] + TICK_TIMEOUT_MARGIN_MS;
  return Math.max(floor, envOverrideMs ?? 0);
}

export function computeBackoffMs(consecutiveFailures: number, tickInterval: number, maxBackoff: number): number {
  const clampedExp = Math.min(consecutiveFailures, 30);
  return Math.min(Math.pow(2, clampedExp) * tickInterval, maxBackoff);
}

export interface TickDecisionInput {
  now: number;
  lastThinkTick: number;
  lastConsolidateTick: number;
  lastReflectTick: number;
  thinkCooldown: number;
  consolidateInterval: number;
  reflectInterval: number;
  /** Idle think interval — think even without observations after this long. */
  timeAwarenessInterval: number;
  nodeCount: number;
  /** Unconsumed observations exist (file cursor behind). */
  hasPending: boolean;
  /** A recurring/digest trigger is among the pending observations. */
  hasTriggerPending: boolean;
  pendingUrgency: number;
  urgencyBypassThreshold: number;
  /** Minimum spacing between urgency-bypass thinks. */
  urgencyMinCooldown: number;
  /** An urgency interrupt fired while a tick was running and was not served yet. */
  pendingInterrupt: boolean;
  initiativeTriggered: boolean;
}

export interface TickDecision {
  kind: LlmTickKind | null;
  reason: string;
  urgentBypass: boolean;
}

function decideThink(input: TickDecisionInput): TickDecision {
  const timeSinceThink = input.now - input.lastThinkTick;
  const urgencyWindowOpen = timeSinceThink >= input.urgencyMinCooldown;
  const urgentBypass = input.hasPending && urgencyWindowOpen
    && (input.pendingUrgency >= input.urgencyBypassThreshold || input.pendingInterrupt);

  if (input.hasTriggerPending) return { kind: "think", reason: "recurring/digest trigger pending", urgentBypass: false };
  if (urgentBypass) {
    const why = input.pendingInterrupt ? "deferred urgency interrupt" : `urgency ${input.pendingUrgency.toFixed(2)}`;
    return { kind: "think", reason: `urgency bypass (${why})`, urgentBypass: true };
  }
  if (input.hasPending && timeSinceThink >= input.thinkCooldown) return { kind: "think", reason: "pending observations, cooldown elapsed", urgentBypass: false };
  if (timeSinceThink >= input.timeAwarenessInterval) return { kind: "think", reason: "idle time-awareness interval", urgentBypass: false };
  if (input.initiativeTriggered) return { kind: "think", reason: "initiative signals", urgentBypass: false };
  return { kind: null, reason: "nothing due", urgentBypass: false };
}

/** Priority: reflect > consolidate > think — same precedence the loop always had. */
export function decideTickKind(input: TickDecisionInput): TickDecision {
  if (input.nodeCount > 0 && input.now - input.lastReflectTick >= input.reflectInterval) {
    return { kind: "reflect", reason: "reflect interval elapsed", urgentBypass: false };
  }
  if (input.nodeCount > 0 && input.now - input.lastConsolidateTick >= input.consolidateInterval) {
    return { kind: "consolidate", reason: "consolidate interval elapsed", urgentBypass: false };
  }
  return decideThink(input);
}
