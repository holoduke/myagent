/**
 * Helpers shared by the think / consolidate / reflect ticks: the streaming
 * LLM call, verified memory-op application, delivery bookkeeping and the
 * signal-state patch.
 *
 * Tick functions persist their own results via patchState. The orchestrator
 * (brain.ts) races each tick against a wall-clock budget; a tick that outlives
 * the budget keeps running and still lands its results — nothing is written
 * from a snapshot the orchestrator holds.
 */

import { createLogger } from "./logger.js";
import { askClaudeStreaming } from "./claude.js";
import type { ClaudeResult } from "./claude.js";
import type { MessageQueue } from "./queue.js";
import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryOperation, BrainState, BrainMessageDelivery, SignalOperation, BrainResponse } from "./memory/types.js";
import type { InitiativeSignal } from "./initiative.js";
import { applySignalOps, recordSignalsSurfaced } from "./initiative.js";
import { verify } from "./action-verifier.js";
import { patchState } from "./brain-state.js";
import { LLM_TIMEOUT_MS } from "./brain-policy.js";
import type { LlmTickKind } from "./brain-policy.js";

const log = createLogger("brain-ticks");

export const BRAIN_TOOLS = process.env.BRAIN_TOOLS ?? "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch";

// Window for the IN-FLIGHT & RECENT DELIVERIES prompt section — must stay
// within the delivery log's retention (25h in scheduler.ts)
export const DELIVERY_SECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

const STREAM_PROGRESS_LOG_MS = 30_000;

// ── Response Parsing ──

export function parseBrainResponse(raw: string): BrainResponse | null {
  try {
    let jsonStr = raw.trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    const parsed = JSON.parse(jsonStr);
    return {
      operations: Array.isArray(parsed.operations) ? parsed.operations : [],
      message: parsed.message ?? null,
      messageTargetJid: typeof parsed.messageTargetJid === "string" ? parsed.messageTargetJid : undefined,
      urgent: parsed.urgent === true,
      urgentReason: typeof parsed.urgentReason === "string" ? parsed.urgentReason : undefined,
      reasoning: parsed.reasoning ?? "",
      workingMemory: parsed.workingMemory ?? undefined,
      goalOps: Array.isArray(parsed.goalOps) ? parsed.goalOps : undefined,
      signalOps: Array.isArray(parsed.signalOps) ? parsed.signalOps : undefined,
      improvementProposals: Array.isArray(parsed.improvementProposals) ? parsed.improvementProposals : undefined,
      consciousnessUpdate: typeof parsed.consciousnessUpdate === "string" ? parsed.consciousnessUpdate : undefined,
    };
  } catch (err) {
    log(`Failed to parse brain response: ${raw.slice(0, 200)} — ${err}`);
    return null;
  }
}

/**
 * Run the tick's LLM call through the message queue (serialised with owner
 * chat) with periodic streaming progress logs. The provider has no abort
 * hook, so `signal` is only consulted afterwards to flag a late result.
 */
export async function callBrainLlm(
  kind: LlmTickKind,
  prompt: string,
  queue: MessageQueue,
  model: string | undefined,
  signal?: AbortSignal,
): Promise<{ result: ClaudeResult; responseText: string }> {
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  let lastLogTime = Date.now();
  let deltaChars = 0;
  const result = await queue.add(async () => {
    return await askClaudeStreaming(prompt, (delta) => {
      deltaChars += delta.length;
      if (Date.now() - lastLogTime > STREAM_PROGRESS_LOG_MS) {
        log(`${label} streaming: ${deltaChars} chars received so far...`);
        lastLogTime = Date.now();
      }
    }, {
      timeout: LLM_TIMEOUT_MS[kind],
      allowedTools: BRAIN_TOOLS,
      noSession: true,
      model,
    });
  });
  const stats = result.stats;
  log(`${label} streaming complete: ${deltaChars} chars, ${stats?.inputTokens ?? "?"} input tokens, ${stats?.outputTokens ?? "?"} output tokens, $${(stats?.totalCostUsd ?? 0).toFixed(4)}`);
  if (signal?.aborted) {
    log(`${label} LLM result arrived after the tick budget expired — applying it anyway`);
  }
  return { result, responseText: result.messages.join("\n") };
}

/** Apply brain-returned memory operations after the verifier gate. */
export function applyVerifiedMemoryOps(
  graph: MemoryGraph,
  operations: unknown[],
  source: LlmTickKind,
): void {
  if (operations.length === 0) return;
  const ops = operations as MemoryOperation[];
  const opsVerify = verify({
    type: "memory_ops",
    source,
    operationCount: ops.length,
    operationTypes: ops.map(o => o.op),
  });
  if (opsVerify.verdict === "blocked") {
    log(`${source} ops BLOCKED by verifier: ${opsVerify.reasons.join("; ")}`);
    return;
  }
  const { applied, skipped } = graph.applyOperations(ops);
  log(`${source} ops: ${applied} applied, ${skipped} skipped`);
}

/**
 * Build the delivery-feedback record for a brain-returned message so the
 * next tick can (a) inject it into the prompt and (b) cross-check "sent"
 * claims against delivery-log.json. Prevents the brain from building false
 * memories of contact that never happened.
 */
export function brainDeliveryRecord(
  message: string,
  targetJid: string,
  status: BrainMessageDelivery["status"],
  detail?: string,
): BrainMessageDelivery {
  return {
    at: Date.now(),
    targetJid,
    snippet: message.slice(0, 120),
    status,
    detail,
    // "sent" awaits delivery-log verification on the next tick; the others are
    // final ("queued" is verified by the scheduled channel's own retry loop)
    verified: status !== "sent",
  };
}

/** The two signal bookkeeping records, deep-copied so in-place helpers can't touch the caller's state. */
export function cloneSignalState(state: BrainState): Pick<BrainState, "signalSnoozes" | "signalSurfacedCounts"> {
  return {
    signalSnoozes: state.signalSnoozes ? { ...state.signalSnoozes } : undefined,
    signalSurfacedCounts: state.signalSurfacedCounts ? { ...state.signalSurfacedCounts } : undefined,
  };
}

/**
 * Count this surfacing, apply snoozes from the response and persist both
 * records. initiative.ts mutates the state object it is handed, so it works
 * on a fresh copy and the result is patched — never a snapshot save.
 */
export function persistSignalState(
  state: BrainState,
  signals: InitiativeSignal[],
  signalOps: unknown[] | undefined,
  label: string,
): void {
  const scratch = { ...state, ...cloneSignalState(state) };
  recordSignalsSurfaced(scratch, signals);
  if (signalOps && signalOps.length > 0) {
    const sigResult = applySignalOps(scratch, signalOps as SignalOperation[]);
    log(`${label} signal ops: ${sigResult.applied} snoozed, ${sigResult.skipped} skipped`);
  }
  patchState({ signalSnoozes: scratch.signalSnoozes, signalSurfacedCounts: scratch.signalSurfacedCounts });
}

export function costOf(result: ClaudeResult): number {
  return result.stats?.totalCostUsd || 0;
}
