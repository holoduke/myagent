/**
 * Think tick — the brain's main LLM cycle over the pending observation batch.
 *
 * Failure model:
 *  - API failure (LLM call rejected / timed out): the claude_api circuit
 *    breaker is charged, the cursor does NOT move, the batch is retried.
 *  - Unparseable response: no breaker charge, cursor stays, batch retried.
 *  - Post-processing failure (memory ops, enrichment, delivery): the LLM
 *    already spent the money and the batch is considered consumed — the
 *    cursor advances and the think counts as done, so the loop cannot spin
 *    on a deterministic post-processing bug.
 *
 * All state changes are persisted here via patchState at the moment of
 * change; the orchestrator's snapshot is read-only input.
 */

import { existsSync, unlinkSync } from "fs";
import { createLogger } from "./logger.js";
import type { Observation } from "./observer.js";
import { buildThinkPrompt } from "./brain-prompt.js";
import type { DigestCarryover } from "./brain-prompt.js";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import type { MessageQueue } from "./queue.js";
import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode, WorkingMemory, BrainResponse, BrainState, GoalOperation, BrainMessageDelivery } from "./memory/types.js";
import type { InitiativeSignal } from "./initiative.js";
import { createFlaggedRequest } from "./actionable-tracker.js";
import { getRecentDeliveries, getRecentDeliveryLog, getScheduledMessages, scheduleMessage, cancelScheduledMessages, DEDUP_WINDOW_MS } from "./scheduler.js";
import { getNextDigestSlot } from "./recurring.js";
import { loadWorkingMemory, saveWorkingMemory, updateWorkingMemory, populateTemporalContext, updateDailySummary } from "./memory/working-memory.js";
import { selectContextForThink } from "./memory/activation.js";
import { GoalTracker } from "./goals.js";
import { scanAndProcessCommitments } from "./accountability.js";
import { wrapError } from "./brain-errors.js";
import { getBrainConfig, getActivePreset, getOwnerLocalDate } from "./brain-config.js";
import type { BrainConfig } from "./brain-config.js";
import { loadQueue, loadHistory, getWeeklyCompletedCount } from "./self-improve-queue.js";
import { trySendMessage } from "./brain-delivery.js";
import { quietEndDeliverAt, ownerLocalClock } from "./brain-quiet-hours.js";
import { OWNER_NAME, GITHUB_REPO, BRAIN_DIR } from "./config.js";
import { critiqueResponse } from "./response-critique.js";
import { extractPreferenceSignals, updatePreferences } from "./preference-learner.js";
import { extractEmotionSignals, recordEmotionSignals } from "./emotion-tracker.js";
import { trackSentMessage, resolveReflections, createReflectionNodes } from "./reflection-tracker.js";
import { detectCausalLinks, recordCausalLinks } from "./causal-tracker.js";
import { isActionPermitted, recordSuccess, recordFailure, recordShadowSuccess, recordGateSuppression } from "./autonomy.js";
import { validateUrgentReason, canUseUrgentOverride, recordUrgentOverride, getUrgentOverridesToday, MAX_URGENT_OVERRIDES_PER_DAY } from "./urgency.js";
import { circuitSuccess, circuitFailure, isCircuitClosed } from "./health-monitor.js";
import { recordTemporalEvent } from "./temporal-patterns.js";
import { predictNextScene, applyScenePrediction } from "./scene-predictor.js";
import { saveConsciousness } from "./consciousness.js";
import { loadState, patchState } from "./brain-state.js";
import { consumedCursor } from "./brain-observations.js";
import { enqueueImprovementProposals } from "./brain-ticks.js";
import {
  parseBrainResponse,
  callBrainLlm,
  applyVerifiedMemoryOps,
  brainDeliveryRecord,
  persistSignalState,
  costOf,
  DELIVERY_SECTION_WINDOW_MS,
} from "./brain-tick-shared.js";

const log = createLogger("brain-think");

type SendFn = (jid: string, text: string, source?: string) => Promise<void>;

// ── Digest carryover (stale-drop backstop) ──
//
// When the stale-digest guard drops a rerouted digest, the owner never sees
// that content — the guard's premise is "the next digest covers the same
// ground", but nothing enforced that. The carryover file persists the dropped
// message so the next [DIGEST REQUEST:] prompt can fold it in, turning that
// premise into a code-level guarantee instead of relying on working-memory
// discipline.

const DIGEST_CARRYOVER_FILE = `${BRAIN_DIR}/digest-carryover.json`;
const DIGEST_CARRYOVER_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function saveDigestCarryover(carryover: DigestCarryover): void {
  try {
    ensureDir(BRAIN_DIR);
    atomicWriteJSON(DIGEST_CARRYOVER_FILE, carryover);
    log(`Digest carryover persisted for next digest tick (target ${carryover.targetJid}, ${carryover.text.length} chars)`);
  } catch (err) {
    log(`Failed to persist digest carryover (non-fatal): ${err}`);
  }
}

export function clearDigestCarryover(): void {
  try {
    if (existsSync(DIGEST_CARRYOVER_FILE)) unlinkSync(DIGEST_CARRYOVER_FILE);
  } catch (err) {
    log(`Failed to clear digest carryover (non-fatal): ${err}`);
  }
}

/**
 * Load the pending digest carryover, or null if none. Entries older than 48h
 * are deleted and not returned — stale zombie content must never resurface in
 * a briefing two days later.
 */
function loadDigestCarryover(now: number): DigestCarryover | null {
  try {
    if (!existsSync(DIGEST_CARRYOVER_FILE)) return null;
    const raw = safeReadJSON<Partial<DigestCarryover> | null>(DIGEST_CARRYOVER_FILE, null);
    if (!raw || typeof raw.text !== "string" || typeof raw.droppedAt !== "number"
      || typeof raw.targetJid !== "string" || typeof raw.reason !== "string") {
      log("Digest carryover file invalid — discarding");
      clearDigestCarryover();
      return null;
    }
    if (now - raw.droppedAt > DIGEST_CARRYOVER_MAX_AGE_MS) {
      log(`Digest carryover expired (dropped ${new Date(raw.droppedAt).toISOString()}, >48h old) — discarding`);
      clearDigestCarryover();
      return null;
    }
    return raw as DigestCarryover;
  } catch (err) {
    log(`Failed to load digest carryover (non-fatal): ${err}`);
    return null;
  }
}

/**
 * Delivery time for a digest rerouted onto the scheduled-messages channel:
 * immediately, unless we're inside quiet hours — then at quietEnd
 * (owner-local), so the fallback never wakes the owner.
 */
function digestRerouteDeliverAt(now: number, cfg: BrainConfig): number {
  return quietEndDeliverAt(now, ownerLocalClock(cfg.ownerTimezone, now), cfg.quietStart, cfg.quietEnd);
}

/**
 * Proposals created today (owner-local day), any status. Completed/failed/rejected
 * items are moved from the queue to history, so both must be counted — the queue
 * alone would under-report and re-trigger the daily nudge after items finish.
 */
export function countProposedToday(timezone: string): number {
  const today = getOwnerLocalDate(timezone);
  const ids = new Set<string>();
  for (const item of [...loadQueue().items, ...loadHistory().entries]) {
    if (getOwnerLocalDate(timezone, new Date(item.createdAt)) === today) ids.add(item.id);
  }
  return ids.size;
}

// ── Prompt preparation ──

interface ThinkPrep {
  wm: WorkingMemory;
  contextNodes: MemoryNode[];
  goalTracker: GoalTracker;
  prompt: string;
  digestCarryover: DigestCarryover | null;
  isDigestTick: boolean;
}

/** Newest inbound owner message in the batch, or the previously recorded one. */
function latestOwnerMessageTime(batch: Observation[], previous: number | undefined): number {
  return batch.reduce(
    (max, o) => (!o.isFromMe && o.trustLevel === "owner" && o.timestamp > max ? o.timestamp : max),
    previous ?? 0,
  );
}

async function prepareThink(
  state: BrainState,
  allObs: Observation[],
  graph: MemoryGraph,
  initiativeSignals: InitiativeSignal[],
  cfg: BrainConfig,
  now: number,
): Promise<ThinkPrep> {
  const wm = loadWorkingMemory();
  populateTemporalContext(wm);

  const signalNodeIds = initiativeSignals.flatMap(s => s.relatedNodeIds);
  const contextNodes = await selectContextForThink(graph, wm, allObs, signalNodeIds, initiativeSignals.length);

  const goalTracker = new GoalTracker(graph);
  const goalsSection = goalTracker.serializeForPrompt();
  wm.activeGoals = goalTracker.getWorkingGoalRefs();

  log(`Think: ${allObs.length} observations, ${contextNodes.length} context nodes, ${initiativeSignals.length} initiative signals`);

  const recentChatDeliveries = getRecentDeliveries(DEDUP_WINDOW_MS)
    .filter(d => d.source === "chat" || d.source === "email")
    .map(d => ({ jid: d.jid, messageSnippet: d.messageSnippet, timestamp: d.timestamp }));

  const improveQueue = loadQueue();
  const selfImproveStats = cfg.selfImproveEnabled ? {
    enabled: true,
    maxPerWeek: cfg.selfImproveMaxPerWeek,
    completedThisWeek: getWeeklyCompletedCount(),
    pendingInQueue: improveQueue.items.filter(i => i.status === "pending" || i.status === "approved").length,
    proposedToday: countProposedToday(cfg.ownerTimezone),
    autoApprove: cfg.selfImproveAutoApprove,
  } : undefined;

  // Digest-carryover backstop: if a previous digest was dropped by the
  // stale-digest guard, inject its content into this digest prompt so it
  // survives the drop. Consumed (cleared) once the brain has processed it.
  const isDigestTick = allObs.some(o => o.text.startsWith("[DIGEST REQUEST:"));
  const digestCarryover = isDigestTick ? loadDigestCarryover(now) : null;

  const prompt = buildThinkPrompt({
    ownerName: OWNER_NAME,
    githubRepo: GITHUB_REPO,
    observations: allObs,
    contextNodes,
    graph,
    wm,
    lastThinkTime: state.lastThinkTick,
    lastMessageTime: state.lastMessageTime,
    messagesToday: state.messagesToday,
    maxMessagesPerDay: cfg.maxMessagesPerDay,
    quietStart: cfg.quietStart,
    quietEnd: cfg.quietEnd,
    ownerTimezone: cfg.ownerTimezone,
    goalsSection,
    initiativeSignals,
    responsivenessPreset: getActivePreset(cfg),
    recentChatDeliveries,
    lastBrainMessage: state.lastBrainMessage,
    queuedMessages: getScheduledMessages(),
    recentDeliveryLog: getRecentDeliveryLog(DELIVERY_SECTION_WINDOW_MS),
    selfImproveStats,
    digestCarryover: digestCarryover ?? undefined,
  });

  log(`Think prompt: ${prompt.length} chars (~${Math.ceil(prompt.length / 3.5)} tokens), ${allObs.length} obs, ${contextNodes.length} context nodes`);
  return { wm, contextNodes, goalTracker, prompt, digestCarryover, isDigestTick };
}

// ── Response post-processing ──

/**
 * Retrieval utility tracking: differential reinforcement based on whether
 * Claude actually referenced each context node in its response.
 */
function reinforceContextNodes(graph: MemoryGraph, contextNodes: MemoryNode[], responseText: string, now: number): void {
  let reinforced = 0;
  let referenced = 0;
  let uselessTracked = 0;
  for (const node of contextNodes) {
    if (node.pinned) continue;
    const current = graph.getNode(node.id);
    if (!current) continue;
    current.lastAccessedAt = now;
    current.accessCount++;

    if (responseText.includes(node.id)) {
      referenced++;
      // Referenced by Claude — stronger reinforcement; successful retrieval reduces the useless counter
      current.strength = Math.min(1, current.strength + 0.05);
      if (current.uselessRetrievalCount && current.uselessRetrievalCount > 0) {
        current.uselessRetrievalCount = Math.max(0, current.uselessRetrievalCount - 1);
      }
      // Importance boosting: consistently-referenced nodes earn durable importance
      // (the signal that resists decay, unlike ephemeral strength)
      if (current.accessCount >= 5 && (current.importance ?? 0) < 0.9) {
        current.importance = Math.min(0.9, (current.importance ?? 0.3) + 0.02);
      }
    } else {
      // In context but not referenced — minimal reinforcement + track
      current.strength = Math.min(1, current.strength + 0.01);
      current.uselessRetrievalCount = (current.uselessRetrievalCount ?? 0) + 1;
      uselessTracked++;
    }
    reinforced++;
  }
  if (reinforced > 0) {
    log(`Think: reinforced ${reinforced} context nodes (${referenced} referenced, ${uselessTracked} unreferenced)`);
  }
}

function runGuarded(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log(`${label} error (non-fatal): ${err}`);
  }
}

/** Cheap structural passes over the batch: preferences, emotions, reflections, causal links, temporal events, scene prediction. */
function runEnrichmentPasses(graph: MemoryGraph, wm: WorkingMemory, allObs: Observation[]): void {
  if (allObs.length > 0) {
    runGuarded("Preference extraction", () => {
      const prefSignals = extractPreferenceSignals(allObs);
      if (prefSignals.length > 0) updatePreferences(graph, prefSignals);
    });
    runGuarded("Emotion extraction", () => {
      const emotionSignals = extractEmotionSignals(allObs);
      if (emotionSignals.length > 0) recordEmotionSignals(graph, emotionSignals);
    });
  }
  runGuarded("Reflection tracking", () => {
    const resolved = resolveReflections(allObs);
    if (resolved.length > 0) createReflectionNodes(graph, resolved);
  });
  runGuarded("Causal detection", () => {
    const causalLinks = detectCausalLinks(graph);
    if (causalLinks.length > 0) recordCausalLinks(graph, causalLinks);
  });
  runGuarded("Temporal pattern recording", () => {
    for (const obs of allObs.slice(0, 5)) {
      if (obs.text && obs.text.length > 5 && !obs.isFromMe) {
        recordTemporalEvent(obs.text.slice(0, 50).toLowerCase(), obs.senderJid);
      }
    }
  });
  runGuarded("Scene prediction", () => {
    const prediction = predictNextScene(graph, wm);
    if (prediction.stagedNodeIds.length > 0) {
      applyScenePrediction(wm, prediction);
      saveWorkingMemory(wm);
    }
  });
}

function applyThinkResponse(
  response: BrainResponse,
  responseText: string,
  prep: ThinkPrep,
  graph: MemoryGraph,
  initiativeSignals: InitiativeSignal[],
  cfg: BrainConfig,
  now: number,
): void {
  const { wm, contextNodes, goalTracker } = prep;

  if (prep.digestCarryover) {
    // The carryover was injected into this prompt and the brain processed
    // it — discard so it can't resurface in a later briefing. (Kept on
    // parse failure: the retried tick re-injects it.)
    clearDigestCarryover();
    log("Digest carryover injected into this digest tick and cleared");
  }

  log(`Think reasoning: ${response.reasoning?.slice(0, 200) || "(none)"}`);
  applyVerifiedMemoryOps(graph, response.operations, "think");

  if (response.goalOps && response.goalOps.length > 0) {
    const goalResult = goalTracker.applyGoalOps(response.goalOps as GoalOperation[]);
    log(`Goal ops: ${goalResult.applied} applied, ${goalResult.failed} failed${goalResult.errors.length > 0 ? ` — errors: ${goalResult.errors.join("; ")}` : ""}`);
    wm.activeGoals = goalTracker.getWorkingGoalRefs();
  }

  persistSignalState(loadState(), initiativeSignals, response.signalOps, "Think");
  reinforceContextNodes(graph, contextNodes, responseText, now);

  if (response.workingMemory) {
    updateWorkingMemory(wm, response.workingMemory);
    wm.activatedNodeIds = contextNodes.slice(0, 10).map(n => n.id);
    updateDailySummary(wm);
    saveWorkingMemory(wm);
  }

  if (response.consciousnessUpdate) {
    runGuarded("Consciousness save", () => {
      saveConsciousness(response.consciousnessUpdate!);
      log(`Consciousness updated (${response.consciousnessUpdate!.length} chars)`);
    });
  }

  if (response.improvementProposals?.length) {
    enqueueImprovementProposals(response.improvementProposals, "think", cfg);
  }
}

// ── Message handling ──

interface MessageContext {
  message: string;
  messageTarget: string;
  isDigestTriggered: boolean;
  isDirectReply: boolean;
  isDirectReplyExemption: boolean;
}

const DIRECT_REPLY_MAX_AGE_MS = 12 * 60 * 60 * 1000; // stays within the delivery log's 25h retention

function classifyMessage(
  response: BrainResponse & { message: string },
  allObs: Observation[],
  ownerJid: string,
  ownerMsgAt: number,
  now: number,
): MessageContext {
  const isDigestTriggered = allObs.some(o => o.text.startsWith("[DIGEST REQUEST:"));
  const isBatchDirectReply = allObs.some(o => !o.isFromMe && o.trustLevel === "owner");
  const messageTarget = response.messageTargetJid || ownerJid;

  // Direct-reply exemption: if the owner messaged us after the last message
  // we actually delivered to them, this response is an answer in an
  // owner-initiated conversation — a reply, not a proactive send — even when
  // the owner's message was consumed by an earlier tick and is no longer in
  // this batch. A suppressed reply to a direct question actively damages
  // trust, the opposite of what the autonomy gate is for.
  const lastDeliveryToOwner = getRecentDeliveries()
    .filter(d => d.jid === ownerJid)
    .reduce((max, d) => Math.max(max, d.timestamp), 0);
  const isDirectReplyExemption = !isBatchDirectReply
    && messageTarget === ownerJid
    && ownerMsgAt > lastDeliveryToOwner
    && (now - ownerMsgAt) < DIRECT_REPLY_MAX_AGE_MS;
  if (isDirectReplyExemption) {
    log(`Autonomy gate exemption (reason=direct-reply): owner message at ${new Date(ownerMsgAt).toISOString()} is newer than last delivery to owner — treating brain message as a reply, skipping suppress-check`);
  }
  return {
    message: response.message,
    messageTarget,
    isDigestTriggered,
    isDirectReply: isBatchDirectReply || isDirectReplyExemption,
    isDirectReplyExemption,
  };
}

function recordDelivery(ctx: MessageContext, status: BrainMessageDelivery["status"], detail?: string): void {
  patchState({ lastBrainMessage: brainDeliveryRecord(ctx.message, ctx.messageTarget, status, detail) });
}

/**
 * Urgency override: the brain may mark a message as genuinely urgent
 * (mandatory motivation) so it passes the autonomy gate, daily quota and
 * min-interval via the scheduled channel (10s delivery loop, retries,
 * delivery-log verified). The contact whitelist and action verifier still
 * gate the actual send; every override is audit-logged (urgency.ts) and
 * daily-capped so quota discipline stays intact. Direct replies are
 * already exempt from throttles and never need this path.
 */
function tryUrgentOverride(response: BrainResponse, ctx: MessageContext, goalTracker: GoalTracker, now: number): boolean {
  if (ctx.isDirectReply || response.urgent !== true) return false;
  const urgentReason = validateUrgentReason(response.urgentReason);
  if (!urgentReason) {
    log("Urgent flag ignored: missing or too-short urgentReason — message follows the normal gate path");
    return false;
  }
  if (!canUseUrgentOverride()) {
    log(`Urgent override DENIED: daily cap reached (${getUrgentOverridesToday()}/${MAX_URGENT_OVERRIDES_PER_DAY}) — message follows the normal gate path`);
    return false;
  }
  const schedId = scheduleMessage(ctx.messageTarget, ctx.message, now, "urgent");
  recordUrgentOverride(ctx.messageTarget, urgentReason, ctx.message);
  log(`URGENCY OVERRIDE: message rerouted via scheduled channel (${schedId}) — ${urgentReason}`);
  recordDelivery(ctx, "queued", `urgency override (${schedId}): ${urgentReason}`);
  scanAndProcessCommitments(ctx.message, "brain", OWNER_NAME, goalTracker);
  return true;
}

/**
 * Owner-contracted digest blocked by the autonomy gate: the gate exists to
 * hold back unsolicited proactive sends, not briefings the owner explicitly
 * scheduled. Reroute onto the scheduled-messages channel instead of
 * suppressing; delivery defers past quiet hours when we're inside them.
 */
function rerouteBlockedDigest(ctx: MessageContext, goalTracker: GoalTracker, cfg: BrainConfig, now: number): void {
  const deliverAt = digestRerouteDeliverAt(now, cfg);
  // Stale-digest guard: if the deferred delivery would land after the next
  // scheduled digest is generated, the owner would get two briefings
  // back-to-back with this one already outdated. Drop it — the next digest
  // covers the same ground with fresher content (carryover file guarantees it).
  const nextDigestSlot = getNextDigestSlot(now);
  if (nextDigestSlot !== null && deliverAt >= nextDigestSlot) {
    const dropReason = `stale digest — rerouted delivery at ${new Date(deliverAt).toISOString()} would land after next digest slot ${new Date(nextDigestSlot).toISOString()}`;
    log(`Digest blocked by autonomy level — dropped as stale: ${dropReason}`);
    recordDelivery(ctx, "suppressed", dropReason);
    saveDigestCarryover({ targetJid: ctx.messageTarget, text: ctx.message, droppedAt: now, reason: dropReason });
    return;
  }
  // A newer digest supersedes any still-queued older one for the same
  // target — never deliver two briefings back-to-back.
  const superseded = cancelScheduledMessages(ctx.messageTarget, "digest");
  if (superseded > 0) log(`Superseded ${superseded} previously queued digest(s) for ${ctx.messageTarget}`);
  const schedId = scheduleMessage(ctx.messageTarget, ctx.message, deliverAt, "digest");
  log(`Digest blocked by autonomy level — rerouted via scheduled channel (${schedId}, deliverAt ${new Date(deliverAt).toISOString()})`);
  recordDelivery(ctx, "queued", `autonomy gate active — digest rerouted to scheduled channel (${schedId}), delivery at ${new Date(deliverAt).toISOString()}`);
  scanAndProcessCommitments(ctx.message, "brain", OWNER_NAME, goalTracker);
}

function critiqueInputs(ctx: MessageContext, obsCount: number, cfg: BrainConfig, now: number) {
  const state = loadState();
  return {
    isDirectReply: ctx.isDirectReply,
    isDigest: ctx.isDigestTriggered,
    recentObservationCount: obsCount,
    hoursSinceLastMessage: state.lastMessageTime > 0 ? (now - state.lastMessageTime) / 3600000 : Infinity,
    messagesToday: state.messagesToday,
    maxMessagesPerDay: cfg.maxMessagesPerDay,
  };
}

/**
 * Autonomy gate block for a non-digest proactive message. A policy-level block
 * is not a judgment failure, so it must not decrement trust. Shadow trust: run
 * the same self-critique the send path would have run; if the message would
 * have passed, award capped shadow trust so the trust ladder stays climbable
 * even while every proactive send is gated.
 */
async function suppressGateBlocked(ctx: MessageContext, obsCount: number, cfg: BrainConfig, now: number): Promise<void> {
  log(`Proactive message blocked by autonomy level (${ctx.message.slice(0, 60)}...)`);
  recordGateSuppression();
  recordDelivery(ctx, "suppressed", "blocked by autonomy level");
  const shadowCritique = await critiqueResponse(ctx.message, critiqueInputs(ctx, obsCount, cfg, now));
  if (shadowCritique.shouldSend) recordShadowSuccess("send_proactive");
}

/**
 * Send through the throttled channel and record the REAL outcome. Sent-message
 * bookkeeping (reflection tracking, commitment scan, trust) only runs for a
 * message that actually went out; a queued reroute still counts its
 * commitments because the scheduled channel will deliver it.
 */
async function deliverBrainMessage(
  ctx: MessageContext,
  sendMessage: SendFn,
  ownerJid: string,
  goalTracker: GoalTracker,
  wasInitiative: boolean,
  critiqueScore?: number,
): Promise<void> {
  const delivery = await trySendMessage(sendMessage, ownerJid, ctx.message, {
    bypassLimits: ctx.isDigestTriggered,
    targetJid: ctx.messageTarget === ownerJid ? undefined : ctx.messageTarget,
    isDirectReply: ctx.isDirectReply,
  });
  recordDelivery(ctx, delivery.status, delivery.detail ?? (ctx.isDirectReplyExemption ? "direct-reply" : undefined));
  if (delivery.status === "sent") {
    trackSentMessage(ctx.message, ctx.messageTarget, wasInitiative, critiqueScore);
    scanAndProcessCommitments(ctx.message, "brain", OWNER_NAME, goalTracker);
    recordSuccess("send_message");
  } else if (delivery.status === "queued") {
    scanAndProcessCommitments(ctx.message, "brain", OWNER_NAME, goalTracker);
  } else {
    log(`Brain message not delivered (${delivery.status}${delivery.detail ? `: ${delivery.detail}` : ""}) — no sent-message bookkeeping`);
  }
}

async function handleThinkMessage(
  response: BrainResponse & { message: string },
  allObs: Observation[],
  prep: ThinkPrep,
  sendMessage: SendFn,
  ownerJid: string,
  initiativeSignals: InitiativeSignal[],
  ownerMsgAt: number,
  cfg: BrainConfig,
  now: number,
): Promise<void> {
  const ctx = classifyMessage(response, allObs, ownerJid, ownerMsgAt, now);
  const { goalTracker } = prep;
  if (tryUrgentOverride(response, ctx, goalTracker, now)) return;

  const hasSignals = initiativeSignals.length > 0;
  if (!ctx.isDirectReply && hasSignals && !isActionPermitted("send_proactive")) {
    if (ctx.isDigestTriggered) rerouteBlockedDigest(ctx, goalTracker, cfg, now);
    else await suppressGateBlocked(ctx, allObs.length, cfg, now);
    return;
  }

  // Self-critique for proactive/initiative messages
  if (hasSignals || !ctx.isDirectReply) {
    const critique = await critiqueResponse(ctx.message, critiqueInputs(ctx, allObs.length, cfg, now));
    if (!critique.shouldSend) {
      log(`Message suppressed by self-critique (score ${critique.score}): ${critique.reason}`);
      recordFailure("send_message", `self-critique suppressed (score ${critique.score})`);
      recordDelivery(ctx, "suppressed", `self-critique (score ${critique.score}): ${critique.reason}`);
      return;
    }
    await deliverBrainMessage(ctx, sendMessage, ownerJid, goalTracker, hasSignals, critique.score);
    return;
  }

  await deliverBrainMessage(ctx, sendMessage, ownerJid, goalTracker, false);
}

// ── Finalisation ──

/** Mark the think done and advance the consumed-cursor to the newest observation in the batch. */
function finalizeThink(now: number, batch: Observation[], cost: number, graph: MemoryGraph): BrainState {
  const next = patchState(s => ({
    lastThinkTick: now,
    lastObservationTime: consumedCursor(batch, s.lastObservationTime),
    totalThinks: s.totalThinks + 1,
    totalCost: s.totalCost + cost,
  }));
  graph.clearPendingObservations();
  return next;
}

// ── Think Tick ──

export async function thinkTick(
  state: BrainState,
  newObs: Observation[],
  queue: MessageQueue,
  sendMessage: SendFn,
  ownerJid: string,
  graph: MemoryGraph,
  initiativeSignals: InitiativeSignal[] = [],
  signal?: AbortSignal,
): Promise<boolean> {
  const now = Date.now();
  const cfg = getBrainConfig();

  const pending = graph.getPendingObservations();
  const allObs = pending.length > 0 ? pending : newObs;

  // Track when the owner last messaged us — feeds the direct-reply gate
  // exemption, which must survive across ticks (the owner's question is
  // often consumed by an earlier tick than the one that produces the answer).
  const ownerMsgAt = latestOwnerMessageTime(allObs, state.lastOwnerMessageTime);
  if (ownerMsgAt !== (state.lastOwnerMessageTime ?? 0)) patchState({ lastOwnerMessageTime: ownerMsgAt });

  const prep = await prepareThink(state, allObs, graph, initiativeSignals, cfg, now);

  // Circuit breaker: skip API call if Claude is in open state
  if (!isCircuitClosed("claude_api")) {
    log("Think skipped: Claude API circuit breaker is OPEN");
    patchState({ lastThinkTick: now });
    return false;
  }

  // ── API phase: breaker-charged, cursor untouched ──
  let llm: Awaited<ReturnType<typeof callBrainLlm>>;
  try {
    llm = await callBrainLlm("think", prep.prompt, queue, cfg.models?.think, signal);
    circuitSuccess("claude_api");
  } catch (err) {
    circuitFailure("claude_api");
    patchState({ lastThinkTick: now });
    throw wrapError(err, "think", `Think failed: ${err}`, {
      elapsedMs: Date.now() - now,
      metadata: { obsCount: allObs.length, contextNodes: prep.contextNodes.length },
    });
  }

  const response = parseBrainResponse(llm.responseText);
  if (!response) {
    log(`Could not parse think response (raw length: ${llm.responseText.length}), skipping — observations preserved for retry`);
    patchState(s => ({ lastThinkTick: now, totalCost: s.totalCost + costOf(llm.result) }));
    return false;
  }

  // ── Post-processing phase: the batch is consumed whatever happens below ──
  try {
    applyThinkResponse(response, llm.responseText, prep, graph, initiativeSignals, cfg, now);
    runEnrichmentPasses(graph, prep.wm, allObs);

    if (response.message) {
      await handleThinkMessage(response as BrainResponse & { message: string }, allObs, prep, sendMessage, ownerJid, initiativeSignals, ownerMsgAt, cfg, now);
    }

    for (const obs of allObs) {
      if (obs.isFromMe && obs.text) {
        scanAndProcessCommitments(obs.text, obs.source || "whatsapp", obs.chatName || obs.groupName || "unknown", prep.goalTracker);
      }
    }

    if (response.requestFlags && response.requestFlags.length > 0) {
      for (const flag of response.requestFlags) createFlaggedRequest(flag);
      log(`Brain flagged ${response.requestFlags.length} request(s) for owner confirmation`);
    }

    const next = finalizeThink(now, allObs, costOf(llm.result), graph);
    log(`Think #${next.totalThinks} complete (${graph.nodeCount} nodes, ${graph.edgeCount} edges, lifetime cost: $${next.totalCost.toFixed(4)})`);
    return true;
  } catch (err) {
    // Not an API failure: the response was received and paid for. Advance the
    // cursor so a deterministic post-processing bug cannot replay the same
    // batch forever, and leave the claude_api breaker alone.
    const next = finalizeThink(now, allObs, costOf(llm.result), graph);
    log(`Think #${next.totalThinks} post-processing FAILED (batch consumed, cursor advanced): ${err}`);
    return false;
  }
}
