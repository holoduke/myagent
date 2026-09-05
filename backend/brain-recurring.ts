/**
 * Recurring-task handling for the brain tick: owner-scheduled messages, and
 * think/digest triggers that are persisted into the durable observation
 * queue (observations.jsonl) so a restart cannot lose them.
 */

import { createLogger } from "./logger.js";
import type { Observation } from "./observer.js";
import type { BrainState } from "./memory/types.js";
import { getDueRecurringTasks, markExecuted } from "./recurring.js";
import type { RecurringTask } from "./recurring.js";
import { verify } from "./action-verifier.js";
import { getOwnerLocalTime } from "./brain-config.js";
import type { BrainConfig } from "./brain-config.js";
import { cancelScheduledMessages } from "./scheduler.js";
import { patchState } from "./brain-state.js";
import { buildSyntheticObservation, persistSyntheticObservation } from "./brain-observations.js";
import type { SyntheticKind } from "./brain-observations.js";

const log = createLogger("brain-recurring");

export const MAX_RECURRING_THINKS_PER_DAY = 3;

type SendFn = (jid: string, text: string, source?: string) => Promise<void>;

export interface RecurringContext {
  sendMessage: SendFn;
  ownerJid: string;
  cfg: BrainConfig;
}

export interface RecurringResult {
  state: BrainState;
  /** Synthetic trigger observations persisted this tick. */
  injected: Observation[];
}

interface Injected {
  state: BrainState;
  obs: Observation;
}

async function sendRecurringMessage(task: RecurringTask, state: BrainState, sendMessage: SendFn): Promise<BrainState> {
  const action = task.action as { type: "message"; targetJid: string; template: string };
  const verifyResult = verify({
    type: "send_recurring",
    source: "recurring",
    targetJid: action.targetJid,
    messageText: action.template,
    metadata: { taskId: task.id, taskLabel: task.label },
  });
  if (verifyResult.verdict === "blocked") {
    log(`[recurring] Verifier blocked message for "${task.label}": ${verifyResult.reasons.join("; ")}`);
    // Mark as executed even when blocked to prevent retry loop every tick
    markExecuted(task.id);
    return state;
  }
  await sendMessage(action.targetJid, action.template, "recurring");
  const next = patchState(s => ({ lastMessageTime: Date.now(), messagesToday: s.messagesToday + 1 }));
  markExecuted(task.id);
  log(`[recurring] Sent message for task "${task.label}" to ${action.targetJid}`);
  return next;
}

export function digestPromptFor(label: string, hour: number): string {
  return hour >= 17
    ? `[DIGEST REQUEST: ${label}] Create a structured evening briefing using these sections:

📅 TODAY'S HIGHLIGHTS — Key events, conversations, and notable happenings today
📋 FOLLOW-UPS — Open items, pending decisions, things still needing attention
👥 PEOPLE — Notable interactions, who reached out, any relationship updates
💡 INSIGHTS — Patterns you noticed, things worth reflecting on

Keep each section to 2-4 bullet points max. Skip empty sections. Be concise and personal.`
    : `[DIGEST REQUEST: ${label}] Create a structured morning briefing using these sections:

📅 CALENDAR — What's scheduled today, upcoming meetings or events
📋 FOLLOW-UPS — Pending items from yesterday, things needing attention today
👥 PEOPLE — Who reached out overnight, messages requiring response
💡 INSIGHTS — Patterns you noticed, initiative signals, anything proactive

Keep each section to 2-4 bullet points max. Skip empty sections. Be concise and personal.`;
}

/**
 * Persist a think trigger to the durable queue and consume one unit of the
 * daily recurring-think budget. Returns null when the budget is exhausted.
 * The task is only marked executed once the trigger is safely on disk.
 */
function injectTrigger(task: RecurringTask, kind: SyntheticKind, text: string, state: BrainState): Injected | null {
  if (state.recurringThinksToday >= MAX_RECURRING_THINKS_PER_DAY) {
    log(`[recurring] Skipping ${kind} trigger "${task.label}": daily budget exhausted (${state.recurringThinksToday}/${MAX_RECURRING_THINKS_PER_DAY})`);
    return null;
  }
  const sender = kind === "digest" ? "ARIA (digest)" : "ARIA (recurring task)";
  const obs = buildSyntheticObservation(kind, sender, text, Date.now());
  persistSyntheticObservation(obs);
  const next = patchState(s => ({ recurringThinksToday: s.recurringThinksToday + 1 }));
  markExecuted(task.id);
  log(`[recurring] Injected ${kind} trigger for "${task.label}" (${next.recurringThinksToday}/${MAX_RECURRING_THINKS_PER_DAY} today)`);
  return { state: next, obs };
}

function injectDigestTrigger(task: RecurringTask, state: BrainState, cfg: BrainConfig): Injected | null {
  // A fresh digest supersedes any older one still queued on the scheduled
  // channel (e.g. rerouted by the autonomy gate and pushed past this slot by
  // retry backoff) — cancel it so the owner never gets a stale briefing right
  // after a fresh one.
  const digestAction = task.action as { type: "digest"; targetJid: string };
  const staleCount = cancelScheduledMessages(digestAction.targetJid, "digest");
  if (staleCount > 0) {
    log(`[recurring] Cancelled ${staleCount} stale queued digest(s) for ${digestAction.targetJid} — superseded by fresh "${task.label}"`);
  }
  const { hour } = getOwnerLocalTime(cfg.ownerTimezone);
  return injectTrigger(task, "digest", digestPromptFor(task.label, hour), state);
}

export async function handleRecurringTasks(state: BrainState, ctx: RecurringContext): Promise<RecurringResult> {
  const dueTasks = getDueRecurringTasks(ctx.ownerJid);
  let st = state;
  const injected: Observation[] = [];
  for (const task of dueTasks) {
    try {
      switch (task.action.type) {
        case "message":
          st = await sendRecurringMessage(task, st, ctx.sendMessage);
          break;
        case "think_trigger": {
          const action = task.action as { type: "think_trigger"; topic: string; context?: string };
          const text = `[RECURRING TASK: ${task.label}] ${action.topic}${action.context ? `\n${action.context}` : ""}`;
          const result = injectTrigger(task, "recurring", text, st);
          if (result) { st = result.state; injected.push(result.obs); }
          break;
        }
        case "digest": {
          const result = injectDigestTrigger(task, st, ctx.cfg);
          if (result) { st = result.state; injected.push(result.obs); }
          break;
        }
      }
    } catch (err) {
      log(`[recurring] Error handling task "${task.label}": ${err} — will retry on next matching tick`);
    }
  }
  return { state: st, injected };
}
