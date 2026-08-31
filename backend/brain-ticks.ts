/**
 * Brain tick implementations: think, consolidate, and reflect.
 * Each tick makes a Claude API call and processes the response.
 * Extracted from brain.ts for maintainability.
 */

import { createLogger } from "./logger.js";
import { askClaudeStreaming } from "./claude.js";
import { getObservationsSince } from "./observer.js";
import type { Observation } from "./observer.js";
import { buildThinkPrompt, buildConsolidatePrompt, buildReflectPrompt } from "./brain-prompt.js";
import type { OutgoingActivityGroup } from "./brain-prompt.js";
import type { MessageQueue } from "./queue.js";
import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryOperation, BrainResponse, BrainState, GoalOperation, ImprovementProposal } from "./memory/types.js";
import { createFlaggedRequest } from "./actionable-tracker.js";
import { getRecentDeliveries, scheduleMessage, DEDUP_WINDOW_MS } from "./scheduler.js";
import { runConsolidation, detectGistClusters } from "./memory/decay.js";
import { loadWorkingMemory, saveWorkingMemory, updateWorkingMemory, populateTemporalContext } from "./memory/working-memory.js";
import {
  selectContextForThink,
  selectContextForConsolidate,
  selectContextForReflect,
} from "./memory/activation.js";
import { GoalTracker } from "./goals.js";
import { scanAndProcessCommitments } from "./accountability.js";
import { verify, rotateAuditLog } from "./action-verifier.js";
import { runDriftAudit, getLatestDriftReport, pruneBaselines } from "./drift-audit.js";
import { BrainError, wrapError } from "./brain-errors.js";
import { getBrainConfig, getActivePreset, getOwnerLocalTime } from "./brain-config.js";
import type { BrainConfig } from "./brain-config.js";
import {
  loadQueue,
  enqueueApproved,
  getWeeklyCompletedCount,
} from "./self-improve-queue.js";
import { loadSubAgents, loadSubAgentHistory } from "./sub-agents.js";
import { trySendMessage, isQuietHour } from "./brain-delivery.js";
import { OWNER_NAME, GITHUB_REPO } from "./config.js";
import { critiqueResponse } from "./response-critique.js";
import { extractPreferenceSignals, updatePreferences } from "./preference-learner.js";
import { extractEmotionSignals, recordEmotionSignals } from "./emotion-tracker.js";
import { trackSentMessage, resolveReflections, createReflectionNodes } from "./reflection-tracker.js";
import { detectCausalLinks, recordCausalLinks } from "./causal-tracker.js";
import { isActionPermitted, recordSuccess, recordFailure, recordShadowSuccess, recordGateSuppression } from "./autonomy.js";
import { probeMemoryHealth, circuitSuccess, circuitFailure, isCircuitClosed } from "./health-monitor.js";
import { runSleepConsolidation } from "./sleep-consolidation.js";
import { detectStaleBeliefs } from "./belief-tracker.js";
import { recordTemporalEvent, analyzePatterns } from "./temporal-patterns.js";
import { predictNextScene, applyScenePrediction } from "./scene-predictor.js";
import { runReflectiveConsolidation } from "./reflective-consolidation.js";
import { runKnowledgeCompilation } from "./knowledge-compiler.js";

const log = createLogger("brain-ticks");

// ── Config ──

const BRAIN_TOOLS = process.env.BRAIN_TOOLS ?? "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch";

// Sleep consolidation runs at most once per 6 hours (expensive O(n²) pass)
let lastSleepConsolidationAt = 0;
const SLEEP_CONSOLIDATION_INTERVAL = 12 * 3600_000;

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
      reasoning: parsed.reasoning ?? "",
      workingMemory: parsed.workingMemory ?? undefined,
      goalOps: Array.isArray(parsed.goalOps) ? parsed.goalOps : undefined,
      improvementProposals: Array.isArray(parsed.improvementProposals) ? parsed.improvementProposals : undefined,
      consciousnessUpdate: typeof parsed.consciousnessUpdate === "string" ? parsed.consciousnessUpdate : undefined,
    };
  } catch (err) {
    log(`Failed to parse brain response: ${raw.slice(0, 200)} — ${err}`);
    return null;
  }
}

// ── Shared: enqueue improvement proposals ──

export function enqueueImprovementProposals(
  proposals: ImprovementProposal[],
  source: string,
  cfg: BrainConfig,
): number {
  if (!proposals.length || !cfg.selfImproveEnabled) return 0;

  const weeklyRemaining = cfg.selfImproveMaxPerWeek - getWeeklyCompletedCount();
  const currentPending = loadQueue().items.filter(
    i => i.status === "pending" || i.status === "approved" || i.status === "running",
  ).length;
  const canEnqueue = Math.max(0, weeklyRemaining - currentPending);
  let enqueued = 0;

  for (const proposal of proposals.slice(0, canEnqueue)) {
    if (!proposal.description || !proposal.rationale) {
      log(`Skipping invalid ${source} improvement proposal: missing description or rationale`);
      continue;
    }
    const improveVerify = verify({
      type: "self_improve",
      source,
      proposalDescription: proposal.description,
      metadata: { files: proposal.files },
    });
    if (improveVerify.verdict === "blocked") {
      log(`${source} self-improve proposal BLOCKED by verifier: ${improveVerify.reasons.join("; ")}`);
      continue;
    }
    const task = {
      type: "improvement" as const,
      description: proposal.description,
      rationale: proposal.rationale,
      files: Array.isArray(proposal.files) ? proposal.files : [],
      memoryContext: Array.isArray(proposal.memoryContext) ? proposal.memoryContext : [],
      planNodeId: proposal.planNodeId || "",
      createdAt: Date.now(),
    };
    enqueueApproved(task);
    log(`${source}: enqueued improvement proposal (pre-approved): ${proposal.description.slice(0, 80)}`);
    enqueued++;
  }

  if (proposals.length > canEnqueue) {
    log(`Dropped ${proposals.length - canEnqueue} ${source} proposals (weekly budget/queue limit)`);
  }

  return enqueued;
}

// ── Delivery Feedback ──

/**
 * Record the real outcome of a brain-returned message in state so the next
 * tick can (a) inject it into the prompt and (b) cross-check "sent" claims
 * against delivery-log.json. Prevents the brain from building false memories
 * of contact that never happened.
 */
function recordBrainDelivery(
  state: BrainState,
  message: string,
  targetJid: string,
  status: "sent" | "queued" | "suppressed" | "failed",
  detail?: string,
): void {
  state.lastBrainMessage = {
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

/**
 * Delivery time for a digest rerouted onto the scheduled-messages channel:
 * immediately, unless we're inside quiet hours — then shortly after quietEnd
 * (owner-local), so the fallback never wakes the owner.
 */
function digestRerouteDeliverAt(now: number, cfg: BrainConfig): number {
  const { hour } = getOwnerLocalTime(cfg.ownerTimezone);
  if (!isQuietHour(hour, cfg.quietStart, cfg.quietEnd)) return now;
  const hoursUntilEnd = (cfg.quietEnd - hour + 24) % 24;
  return now + hoursUntilEnd * 3600_000;
}

// ── Think Tick (Claude call) ──

export async function thinkTick(
  state: BrainState,
  newObs: Observation[],
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
  graph: MemoryGraph,
  initiativeSignals: import("./initiative.js").InitiativeSignal[] = [],
): Promise<boolean> {
  const now = Date.now();

  const pending = graph.getPendingObservations();
  const allObs = pending.length > 0 ? pending : newObs;

  // Track when the owner last messaged us — feeds the direct-reply gate
  // exemption below, which must survive across ticks (the owner's question is
  // often consumed by an earlier tick than the one that produces the answer).
  for (const o of allObs) {
    if (!o.isFromMe && o.trustLevel === "owner" && o.timestamp > (state.lastOwnerMessageTime ?? 0)) {
      state.lastOwnerMessageTime = o.timestamp;
    }
  }

  const wm = loadWorkingMemory();
  populateTemporalContext(wm);

  const signalNodeIds = initiativeSignals.flatMap(s => s.relatedNodeIds);
  const contextNodes = await selectContextForThink(graph, wm, allObs, signalNodeIds, initiativeSignals.length);

  const goalTracker = new GoalTracker(graph);
  const goalsSection = goalTracker.serializeForPrompt();
  wm.activeGoals = goalTracker.getWorkingGoalRefs();

  log(`Think: ${allObs.length} observations, ${contextNodes.length} context nodes, ${initiativeSignals.length} initiative signals`);

  const cfg = getBrainConfig();

  const recentChatDeliveries = getRecentDeliveries(DEDUP_WINDOW_MS)
    .filter(d => d.source === "chat" || d.source === "email")
    .map(d => ({ jid: d.jid, messageSnippet: d.messageSnippet, timestamp: d.timestamp }));

  const improveQueueThink = loadQueue();
  const selfImproveStatsThink = cfg.selfImproveEnabled ? {
    enabled: true,
    maxPerWeek: cfg.selfImproveMaxPerWeek,
    completedThisWeek: getWeeklyCompletedCount(),
    pendingInQueue: improveQueueThink.items.filter(i => i.status === "pending" || i.status === "approved").length,
    autoApprove: cfg.selfImproveAutoApprove,
  } : undefined;

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
    selfImproveStats: selfImproveStatsThink,
  });

  // Log prompt size for cost monitoring
  const promptChars = prompt.length;
  const estimatedTokens = Math.ceil(promptChars / 3.5); // rough char→token estimate
  log(`Think prompt: ${promptChars} chars (~${estimatedTokens} tokens), ${allObs.length} obs, ${contextNodes.length} context nodes`);

  try {
    // Circuit breaker: skip API call if Claude is in open state
    if (!isCircuitClosed("claude_api")) {
      log("Think skipped: Claude API circuit breaker is OPEN");
      state.lastThinkTick = now;
      return false;
    }

    let lastLogTime = Date.now();
    let deltaChars = 0;
    const result = await queue.add(async () => {
      return await askClaudeStreaming(prompt, (delta) => {
        deltaChars += delta.length;
        const elapsed = Date.now() - lastLogTime;
        if (elapsed > 30_000) {
          log(`Think streaming: ${deltaChars} chars received so far...`);
          lastLogTime = Date.now();
        }
      }, {
        timeout: 300_000,
        allowedTools: BRAIN_TOOLS,
        noSession: true,
        model: cfg.models?.think,
      });
    });

    circuitSuccess("claude_api");
    const thinkStats = result.stats;
    log(`Think streaming complete: ${deltaChars} chars, ${thinkStats?.inputTokens ?? "?"} input tokens, ${thinkStats?.outputTokens ?? "?"} output tokens, $${(thinkStats?.totalCostUsd ?? 0).toFixed(4)}`);
    const responseText = result.messages.join("\n");
    const response = parseBrainResponse(responseText);

    if (!response) {
      log(`Could not parse think response (raw length: ${responseText.length}), skipping — observations preserved for retry`);
      state.lastThinkTick = now;
      return false;
    }

    log(`Think reasoning: ${response.reasoning?.slice(0, 200) || "(none)"}`);

    if (response.operations.length > 0) {
      const opsVerify = verify({
        type: "memory_ops",
        source: "think",
        operationCount: response.operations.length,
        operationTypes: response.operations.map(o => o.op),
      });
      if (opsVerify.verdict === "blocked") {
        log(`Think ops BLOCKED by verifier: ${opsVerify.reasons.join("; ")}`);
      } else {
        const { applied, skipped } = graph.applyOperations(response.operations as MemoryOperation[]);
        log(`Think ops: ${applied} applied, ${skipped} skipped`);
      }
    }

    if (response.goalOps && response.goalOps.length > 0) {
      const goalResult = goalTracker.applyGoalOps(response.goalOps as GoalOperation[]);
      log(`Goal ops: ${goalResult.applied} applied, ${goalResult.failed} failed${goalResult.errors.length > 0 ? ` — errors: ${goalResult.errors.join("; ")}` : ""}`);
      wm.activeGoals = goalTracker.getWorkingGoalRefs();
    }

    // Retrieval utility tracking: differential reinforcement based on whether
    // Claude actually referenced each context node in its response
    const referencedNodeIds = new Set<string>();
    for (const node of contextNodes) {
      if (responseText.includes(node.id)) {
        referencedNodeIds.add(node.id);
      }
    }

    let reinforced = 0;
    let uselessTracked = 0;
    for (const node of contextNodes) {
      if (node.pinned) continue;
      const current = graph.getNode(node.id);
      if (!current) continue;
      current.lastAccessedAt = now;
      current.accessCount++;

      if (referencedNodeIds.has(node.id)) {
        // Referenced by Claude — stronger reinforcement
        current.strength = Math.min(1, current.strength + 0.05);
        // Successful retrieval reduces useless counter
        if (current.uselessRetrievalCount && current.uselessRetrievalCount > 0) {
          current.uselessRetrievalCount = Math.max(0, current.uselessRetrievalCount - 1);
        }
        // Importance boosting: consistently-referenced nodes earn durable importance
        // accessCount tracks total retrievals; if referenced often enough, bump importance
        // This is the durable signal that resists decay (unlike strength which is ephemeral)
        if (current.accessCount >= 5 && (current.importance ?? 0) < 0.9) {
          const importanceBoost = 0.02; // small per-reference, compounds over time
          current.importance = Math.min(0.9, (current.importance ?? 0.3) + importanceBoost);
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
      log(`Think: reinforced ${reinforced} context nodes (${referencedNodeIds.size} referenced, ${uselessTracked} unreferenced)`);
    }

    if (response.workingMemory) {
      updateWorkingMemory(wm, response.workingMemory);
      wm.activatedNodeIds = contextNodes.slice(0, 10).map(n => n.id);
      // Update daily temporal summary with latest context
      const { updateDailySummary } = await import("./memory/working-memory.js");
      updateDailySummary(wm);
      saveWorkingMemory(wm);
    }

    // Persist consciousness state update
    if (response.consciousnessUpdate) {
      try {
        const { saveConsciousness } = await import("./consciousness.js");
        saveConsciousness(response.consciousnessUpdate);
        log(`Consciousness updated (${response.consciousnessUpdate.length} chars)`);
      } catch (err) {
        log(`Consciousness save error (non-fatal): ${err}`);
      }
    }

    if (response.improvementProposals?.length) {
      enqueueImprovementProposals(response.improvementProposals, "think", cfg);
    }

    // Phase 4: Extract preference signals from owner behavior
    if (allObs.length > 0) {
      try {
        const prefSignals = extractPreferenceSignals(allObs);
        if (prefSignals.length > 0) {
          updatePreferences(graph, prefSignals);
        }
      } catch (err) {
        log(`Preference extraction error (non-fatal): ${err}`);
      }
    }

    // Emotion detection: extract emotional signals from observations
    if (allObs.length > 0) {
      try {
        const emotionSignals = extractEmotionSignals(allObs);
        if (emotionSignals.length > 0) {
          recordEmotionSignals(graph, emotionSignals);
        }
      } catch (err) {
        log(`Emotion extraction error (non-fatal): ${err}`);
      }
    }

    // Reflection tracking: resolve pending reflections against new observations
    try {
      const resolved = resolveReflections(allObs);
      if (resolved.length > 0) {
        createReflectionNodes(graph, resolved);
      }
    } catch (err) {
      log(`Reflection tracking error (non-fatal): ${err}`);
    }

    // Causal link detection: find cause-effect patterns in recent nodes
    try {
      const causalLinks = detectCausalLinks(graph);
      if (causalLinks.length > 0) {
        recordCausalLinks(graph, causalLinks);
      }
    } catch (err) {
      log(`Causal detection error (non-fatal): ${err}`);
    }

    // Temporal pattern recording: log topics from current observations
    try {
      for (const obs of allObs.slice(0, 5)) {
        if (obs.text && obs.text.length > 5 && !obs.isFromMe) {
          const topic = obs.text.slice(0, 50).toLowerCase();
          recordTemporalEvent(topic, obs.senderJid);
        }
      }
    } catch (err) {
      log(`Temporal pattern recording error (non-fatal): ${err}`);
    }

    // Scene prediction: pre-stage memory nodes for next think tick
    try {
      const prediction = predictNextScene(graph, wm);
      if (prediction.stagedNodeIds.length > 0) {
        applyScenePrediction(wm, prediction);
        saveWorkingMemory(wm);
      }
    } catch (err) {
      log(`Scene prediction error (non-fatal): ${err}`);
    }

    if (response.message) {
      const isDigestTriggered = allObs.some(o => o.text.startsWith("[DIGEST REQUEST:"));
      const isBatchDirectReply = allObs.some(o => !o.isFromMe && o.trustLevel === "owner");
      const messageTarget = response.messageTargetJid || ownerJid;

      // Direct-reply exemption: if the owner messaged us after the last message
      // we actually delivered to them, this response is an answer in an
      // owner-initiated conversation — a reply, not a proactive send — even when
      // the owner's message was consumed by an earlier tick and is no longer in
      // this batch. A suppressed reply to a direct question actively damages
      // trust, the opposite of what the autonomy gate is for.
      const DIRECT_REPLY_MAX_AGE_MS = 12 * 60 * 60 * 1000; // stays within the delivery log's 13h retention
      const ownerMsgAt = state.lastOwnerMessageTime ?? 0;
      const lastDeliveryToOwner = getRecentDeliveries()
        .filter(d => d.jid === ownerJid)
        .reduce((max, d) => Math.max(max, d.timestamp), 0);
      const isDirectReplyExemption = !isBatchDirectReply
        && messageTarget === ownerJid
        && ownerMsgAt > lastDeliveryToOwner
        && (now - ownerMsgAt) < DIRECT_REPLY_MAX_AGE_MS;
      const isDirectReply = isBatchDirectReply || isDirectReplyExemption;
      if (isDirectReplyExemption) {
        log(`Autonomy gate exemption (reason=direct-reply): owner message at ${new Date(ownerMsgAt).toISOString()} is newer than last delivery to owner — treating brain message as a reply, skipping suppress-check`);
      }

      // Autonomy gating: check if proactive messaging is permitted at current level.
      // A policy-level block is not a judgment failure, so it must not decrement trust —
      // otherwise the demote-spiral drags the agent down from its own gating.
      if (!isDirectReply && initiativeSignals.length > 0 && !isActionPermitted("send_proactive")) {
        if (isDigestTriggered) {
          // Owner-contracted digest: the gate exists to hold back unsolicited
          // proactive sends, not briefings the owner explicitly scheduled.
          // Reroute onto the scheduled-messages channel (10s delivery loop,
          // retries, delivery-log verified) instead of suppressing; delivery
          // defers past quiet hours when we're inside them. No gate bypass for
          // any other message type — only [DIGEST REQUEST:]-triggered output.
          const deliverAt = digestRerouteDeliverAt(now, cfg);
          const schedId = scheduleMessage(messageTarget, response.message, deliverAt, "digest");
          log(`Digest blocked by autonomy level — rerouted via scheduled channel (${schedId}, deliverAt ${new Date(deliverAt).toISOString()})`);
          recordBrainDelivery(state, response.message, messageTarget, "queued",
            `autonomy gate active — digest rerouted to scheduled channel (${schedId}), delivery at ${new Date(deliverAt).toISOString()}`);
          scanAndProcessCommitments(response.message, "brain", OWNER_NAME, goalTracker);
        } else {
          log(`Proactive message blocked by autonomy level (${response.message.slice(0, 60)}...)`);
          recordGateSuppression();
          recordBrainDelivery(state, response.message, messageTarget, "suppressed", "blocked by autonomy level");
          // Shadow trust: the gate is a policy block, not a judgment failure. Run the
          // same self-critique the send path would have run; if the message would have
          // passed, award capped shadow trust so the trust ladder stays climbable even
          // while every proactive send is gated (otherwise trustScore stays 0 forever).
          const hoursSinceLastMessage = state.lastMessageTime > 0
            ? (now - state.lastMessageTime) / 3600000
            : Infinity;
          const shadowCritique = await critiqueResponse(response.message, {
            isDirectReply,
            isDigest: isDigestTriggered,
            recentObservationCount: allObs.length,
            hoursSinceLastMessage,
            messagesToday: state.messagesToday,
            maxMessagesPerDay: cfg.maxMessagesPerDay,
          });
          if (shadowCritique.shouldSend) {
            recordShadowSuccess("send_proactive");
          }
        }
      } else
      // Phase 3: Self-critique for proactive/initiative messages
      if (initiativeSignals.length > 0 || !isDirectReply) {
        const hoursSinceLastMessage = state.lastMessageTime > 0
          ? (now - state.lastMessageTime) / 3600000
          : Infinity;
        const critique = await critiqueResponse(response.message, {
          isDirectReply,
          isDigest: isDigestTriggered,
          recentObservationCount: allObs.length,
          hoursSinceLastMessage,
          messagesToday: state.messagesToday,
          maxMessagesPerDay: cfg.maxMessagesPerDay,
        });
        if (!critique.shouldSend) {
          log(`Message suppressed by self-critique (score ${critique.score}): ${critique.reason}`);
          recordFailure("send_message", `self-critique suppressed (score ${critique.score})`);
          recordBrainDelivery(state, response.message, messageTarget, "suppressed", `self-critique (score ${critique.score}): ${critique.reason}`);
        } else {
          const delivery = await trySendMessage(state, sendMessage, ownerJid, response.message, {
            bypassLimits: isDigestTriggered,
            targetJid: response.messageTargetJid,
            isDirectReply,
          });
          recordBrainDelivery(state, response.message, messageTarget, delivery.status,
            delivery.detail ?? (isDirectReplyExemption ? "direct-reply" : undefined));
          trackSentMessage(response.message, messageTarget, initiativeSignals.length > 0, critique.score);
          scanAndProcessCommitments(response.message, "brain", OWNER_NAME, goalTracker);
          recordSuccess("send_message");
        }
      } else {
        const delivery = await trySendMessage(state, sendMessage, ownerJid, response.message, {
          bypassLimits: isDigestTriggered,
          targetJid: response.messageTargetJid,
          isDirectReply,
        });
        recordBrainDelivery(state, response.message, messageTarget, delivery.status,
          delivery.detail ?? (isDirectReplyExemption ? "direct-reply" : undefined));
        trackSentMessage(response.message, messageTarget, false);
        scanAndProcessCommitments(response.message, "brain", OWNER_NAME, goalTracker);
        recordSuccess("send_message");
      }
    }

    for (const obs of allObs) {
      if (obs.isFromMe && obs.text) {
        const source = obs.source || "whatsapp";
        const audience = obs.chatName || obs.groupName || "unknown";
        scanAndProcessCommitments(obs.text, source, audience, goalTracker);
      }
    }

    if (response.requestFlags && response.requestFlags.length > 0) {
      for (const flag of response.requestFlags) {
        createFlaggedRequest(flag);
      }
      log(`Brain flagged ${response.requestFlags.length} request(s) for owner confirmation`);
    }

    state.lastThinkTick = now;
    state.lastObservationTime = now;
    state.totalThinks++;
    if (result.stats) {
      state.totalCost += result.stats.totalCostUsd || 0;
    }
    graph.clearPendingObservations();

    log(`Think #${state.totalThinks} complete (${graph.nodeCount} nodes, ${graph.edgeCount} edges, lifetime cost: $${state.totalCost.toFixed(4)})`);
    return true;
  } catch (err) {
    circuitFailure("claude_api");
    state.lastThinkTick = now;
    state.lastObservationTime = now;
    throw wrapError(err, "think", `Think failed: ${err}`, {
      elapsedMs: Date.now() - now,
      metadata: { obsCount: newObs.length, contextNodes: contextNodes?.length },
    });
  }
}

// ── Consolidate Tick (Claude call) ──

export async function consolidateTick(
  state: BrainState,
  queue: MessageQueue,
  graph: MemoryGraph,
): Promise<boolean> {
  const now = Date.now();

  const wm = loadWorkingMemory();

  const decayResult = runConsolidation(graph, wm);
  log(`Consolidate decay: ${decayResult.nodesDecayed} nodes decayed, ${decayResult.nodesPruned} archived, ${decayResult.edgesDecayed} edges decayed, ${decayResult.edgesPruned} pruned, ${decayResult.orphansPruned} orphans, ${decayResult.archiveRestored} recalled from archive`);

  // Sleep consolidation: conflict detection, dedup, episodic→semantic promotion
  // Time-gated to avoid running expensive O(n²) passes every consolidate tick
  if (now - lastSleepConsolidationAt > SLEEP_CONSOLIDATION_INTERVAL) {
    try {
      const sleepResult = runSleepConsolidation(graph);
      lastSleepConsolidationAt = now;
      log(`Sleep consolidation: ${sleepResult.conflictsDetected} conflicts, ${sleepResult.conflictsResolved} resolved, ${sleepResult.promotedToSemantic} promoted`);
    } catch (err) {
      log(`Sleep consolidation error (non-fatal): ${err}`);
    }
  }

  // Health monitoring: probe memory graph health
  try {
    const nodes = graph.allNodes();
    const avgStrength = nodes.length > 0
      ? nodes.reduce((s, n) => s + n.strength, 0) / nodes.length
      : 0;
    probeMemoryHealth(graph.nodeCount, graph.edgeCount, graph.archiveSize, avgStrength);
  } catch (err) {
    log(`Health probe error (non-fatal): ${err}`);
  }
  // Stale belief detection: flag beliefs needing review
  try {
    const staleBeliefs = detectStaleBeliefs(graph);
    if (staleBeliefs.length > 0) {
      log(`Stale beliefs: ${staleBeliefs.length} beliefs need review (old + medium confidence or contradicted)`);
    }
  } catch (err) {
    log(`Stale belief detection error (non-fatal): ${err}`);
  }

  // Reflective consolidation: summarize weak clusters before they decay away
  try {
    const gistResults = runReflectiveConsolidation(graph);
    if (gistResults.length > 0) {
      log(`Reflective consolidation: ${gistResults.length} gist nodes created from ${gistResults.reduce((s, r) => s + r.nodesConsolidated, 0)} weak nodes`);
    }
  } catch (err) {
    log(`Reflective consolidation error (non-fatal): ${err}`);
  }

  // Knowledge compilation: compile repeated reasoning patterns into procedure nodes
  try {
    const compiled = runKnowledgeCompilation(graph);
    if (compiled > 0) {
      log(`Knowledge compilation: ${compiled} patterns compiled`);
    }
  } catch (err) {
    log(`Knowledge compilation error (non-fatal): ${err}`);
  }

  // Temporal pattern analysis: detect recurring behavior patterns (daily analysis)
  try {
    const patterns = analyzePatterns();
    if (patterns.length > 0) {
      log(`Temporal patterns: ${patterns.length} recurring patterns detected`);
    }
  } catch (err) {
    log(`Temporal pattern analysis error (non-fatal): ${err}`);
  }

  // Compile weekly temporal summaries from daily entries
  try {
    const { compileWeeklySummary } = await import("./memory/working-memory.js");
    compileWeeklySummary(wm);
    saveWorkingMemory(wm);
  } catch (err) {
    log(`Weekly summary compilation error (non-fatal): ${err}`);
  }

  // Rebuild structured person profiles from graph state
  try {
    const { rebuildPersonProfiles } = await import("./memory/person-profiles.js");
    const profiles = rebuildPersonProfiles(graph);
    log(`Person profiles: rebuilt ${profiles.length} profiles`);
  } catch (err) {
    log(`Person profile rebuild error (non-fatal): ${err}`);
  }

  if (decayResult.uncapturedSignals.length > 0) {
    log(`Consolidate audit: ${decayResult.uncapturedSignals.length} uncaptured signals found in observation logs`);
  }
  if (decayResult.deltaReport) {
    log(`Consolidate delta: ${decayResult.deltaReport.summary}`);
  }
  if (decayResult.driftReport) {
    const dr = decayResult.driftReport;
    log(`Consolidate drift: ${dr.driftedNodes.length} pinned nodes drifted (max ${dr.maxDriftScore.toFixed(3)}), ${dr.edgesLostTotal} edges lost, ${dr.missingNodes.length} missing`);
  }
  if (decayResult.driftAlert) {
    log(`⚠ DRIFT ALERT: ${decayResult.driftAlert}`);
  }

  populateTemporalContext(wm);

  const { cleanupWorkingMemory } = await import("./memory/working-memory.js");
  const cleanup = cleanupWorkingMemory(wm);
  if (cleanup.trackingTrimmed > 0 || cleanup.followUpsPruned > 0) {
    log(`Working memory cleanup: trimmed ${cleanup.trackingTrimmed} tracking items, pruned ${cleanup.followUpsPruned} follow-ups`);
    saveWorkingMemory(wm);
  }
  const { weakNodes, orphanNodes, duplicateCandidates, stats } = selectContextForConsolidate(graph);

  // Detect gist extraction candidates — clusters of similar old nodes
  const gistClusters = detectGistClusters(graph);

  const hasUncaptured = decayResult.uncapturedSignals.length > 0;
  const hasLowFidelity = decayResult.fidelityResults.some(r => r.lowFidelity);
  const hasGistClusters = gistClusters.length > 0;
  if (weakNodes.length === 0 && orphanNodes.length === 0 && duplicateCandidates.length === 0 && !hasUncaptured && !hasLowFidelity && !hasGistClusters) {
    log("Consolidate: nothing for Claude to review, decay-only cycle");
    state.lastConsolidateTick = now;
    return true;
  }

  log(`Consolidate: ${weakNodes.length} weak, ${orphanNodes.length} orphans, ${duplicateCandidates.length} duplicates, ${gistClusters.length} gist clusters`);

  const prompt = buildConsolidatePrompt({
    ownerName: OWNER_NAME,
    githubRepo: GITHUB_REPO,
    weakNodes,
    orphanNodes,
    duplicateCandidates,
    graph,
    wm,
    stats,
    uncapturedSignals: decayResult.uncapturedSignals,
    deltaReport: decayResult.deltaReport,
    lowFidelityReconstructions: decayResult.fidelityResults.filter(r => r.lowFidelity),
    gistClusters,
    rejectedEdgeCount: graph.rejectedEdgeCount,
  });

  const consolidatePromptChars = prompt.length;
  log(`Consolidate prompt: ${consolidatePromptChars} chars (~${Math.ceil(consolidatePromptChars / 3.5)} tokens) → calling Claude`);

  try {
    let lastLogTime = Date.now();
    let deltaChars = 0;
    const result = await queue.add(async () => {
      return await askClaudeStreaming(prompt, (delta) => {
        deltaChars += delta.length;
        const elapsed = Date.now() - lastLogTime;
        if (elapsed > 30_000) {
          log(`Consolidate streaming: ${deltaChars} chars received so far...`);
          lastLogTime = Date.now();
        }
      }, {
        timeout: 300_000,
        allowedTools: BRAIN_TOOLS,
        noSession: true,
        model: getBrainConfig().models?.consolidate,
      });
    });

    const consolidateStats = result.stats;
    log(`Consolidate streaming complete: ${deltaChars} chars, ${consolidateStats?.inputTokens ?? "?"} input tokens, ${consolidateStats?.outputTokens ?? "?"} output tokens, $${(consolidateStats?.totalCostUsd ?? 0).toFixed(4)}`);
    const responseText = result.messages.join("\n");
    const response = parseBrainResponse(responseText);

    if (!response) {
      log("Could not parse consolidate response");
      state.lastConsolidateTick = now;
      return false;
    }

    log(`Consolidate reasoning: ${response.reasoning?.slice(0, 200) || "(none)"}`);

    if (response.operations.length > 0) {
      const opsVerify = verify({
        type: "memory_ops",
        source: "consolidate",
        operationCount: response.operations.length,
        operationTypes: response.operations.map(o => o.op),
      });
      if (opsVerify.verdict === "blocked") {
        log(`Consolidate ops BLOCKED by verifier: ${opsVerify.reasons.join("; ")}`);
      } else {
        const { applied, skipped } = graph.applyOperations(response.operations as MemoryOperation[]);
        log(`Consolidate ops: ${applied} applied, ${skipped} skipped`);
      }
    }

    rotateAuditLog();

    if (response.workingMemory) {
      updateWorkingMemory(wm, response.workingMemory);
      saveWorkingMemory(wm);
    }

    state.lastConsolidateTick = now;
    if (result.stats) {
      state.totalCost += result.stats.totalCostUsd || 0;
    }

    log(`Consolidate complete (${graph.nodeCount} nodes, ${graph.edgeCount} edges)`);
    return true;
  } catch (err) {
    state.lastConsolidateTick = now;
    throw wrapError(err, "consolidate", `Consolidate failed: ${err}`, {
      elapsedMs: Date.now() - now,
      metadata: { weakNodes: weakNodes?.length, orphanNodes: orphanNodes?.length },
    });
  }
}

// ── Moltbook Activity for Commitment Tracking ──

function getRecentMoltbookActivity(): string[] {
  const agents = loadSubAgents();
  const moltbookAgent = agents.find(a => a.name.toLowerCase().includes("moltbook") || a.id.includes("moltbook"));
  if (!moltbookAgent) return [];

  const history = loadSubAgentHistory(moltbookAgent.id);
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;

  const activity: string[] = [];
  for (const run of history) {
    if (run.completedAt < cutoff) break;
    if (!run.success) continue;
    const text = run.details || run.summary;
    if (text) activity.push(text);
  }

  return activity;
}

// ── Reflect Tick (Claude call) ──

export async function reflectTick(
  state: BrainState,
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
  graph: MemoryGraph,
  initiativeSignals: import("./initiative.js").InitiativeSignal[] = [],
): Promise<boolean> {
  const now = Date.now();
  const wm = loadWorkingMemory();
  populateTemporalContext(wm);
  const strongestNodes = selectContextForReflect(graph);
  const stats = graph.getStats();

  const goalTracker = new GoalTracker(graph);
  const goalsSection = goalTracker.serializeForPrompt();
  wm.activeGoals = goalTracker.getWorkingGoalRefs();

  const cfg = getBrainConfig();

  const improveQueue = loadQueue();
  const selfImproveStats = {
    enabled: cfg.selfImproveEnabled,
    maxPerWeek: cfg.selfImproveMaxPerWeek,
    completedThisWeek: getWeeklyCompletedCount(),
    pendingInQueue: improveQueue.items.filter(i => i.status === "pending" || i.status === "approved").length,
    autoApprove: cfg.selfImproveAutoApprove,
  };

  const recentMoltbookActivity = getRecentMoltbookActivity();

  const COMMITMENT_LOOKBACK = 12 * 60 * 60 * 1000;
  const recentOutgoing = getObservationsSince(Date.now() - COMMITMENT_LOOKBACK, { isFromMe: true }, 50);

  // isFromMe=true covers BOTH ARIA's own sends and the owner's outgoing messages
  // (ARIA sends through the owner's Baileys session, so messages the owner types
  // on his phone are also observed with fromMe=true). Only messages ARIA actually
  // sent are ARIA's commitments — cross-check against delivery-log.json, plus
  // synthetic ARIA observations (twilio calls, recurring/digest triggers).
  const ariaDeliveries = getRecentDeliveries(COMMITMENT_LOOKBACK);
  const DELIVERY_MATCH_TOLERANCE_MS = 15 * 60 * 1000;
  const isAriaSent = (o: Observation): boolean => {
    if (o.senderJid === "system" || (o.sender || "").startsWith("ARIA")) return true;
    const textKey = o.text.slice(0, 120);
    return ariaDeliveries.some(d =>
      d.messageSnippet === textKey &&
      Math.abs(d.timestamp - o.timestamp) <= DELIVERY_MATCH_TOLERANCE_MS,
    );
  };

  const outgoingFlat = recentOutgoing
    .filter(o => o.text && o.text.length >= 10)
    .map(o => ({
      source: o.source || "whatsapp",
      audience: o.chatName || o.groupName || "unknown",
      text: o.text,
      ariaSent: isAriaSent(o),
    }));

  // Group outgoing activity by conversation (source + audience) for a concise reflect prompt
  const groupByConversation = (items: { source: string; audience: string; text: string }[]): OutgoingActivityGroup[] => {
    const map = new Map<string, OutgoingActivityGroup>();
    for (const a of items) {
      const key = `${a.source}::${a.audience}`;
      const existing = map.get(key);
      if (existing) {
        existing.messageCount++;
        existing.latestSnippet = a.text.slice(0, 200);
        existing.texts.push(a.text);
      } else {
        map.set(key, { source: a.source, audience: a.audience, messageCount: 1, latestSnippet: a.text.slice(0, 200), texts: [a.text] });
      }
    }
    return Array.from(map.values());
  };
  const ariaOutgoingFlat = outgoingFlat.filter(a => a.ariaSent);
  const ownerOutgoingFlat = outgoingFlat.filter(a => !a.ariaSent);
  const recentOutgoingActivity = groupByConversation(ariaOutgoingFlat);
  const ownerOutgoingActivity = groupByConversation(ownerOutgoingFlat);

  let driftSummary: string | undefined;
  try {
    const driftReport = await runDriftAudit();
    if (driftReport) {
      driftSummary = `[DRIFT AUDIT] Direction: ${driftReport.directionSummary} | Surprise: ${driftReport.surpriseLevel} | ${driftReport.filesChanged.length} files changed | ${driftReport.recommendation}`;
      log(`Drift audit completed: surprise=${driftReport.surpriseLevel}`);
      if ((driftReport.surpriseLevel === "medium" || driftReport.surpriseLevel === "high") && ownerJid) {
        const alertMsg = `🔍 Weekly drift audit (surprise: ${driftReport.surpriseLevel})\n\n${driftReport.directionSummary}\n\n${driftReport.driftCharacterization}\n\nRecommendation: ${driftReport.recommendation}`;
        try { await sendMessage(ownerJid, alertMsg); } catch (err) { log(`Failed to send drift alert: ${err}`); }
      }
      pruneBaselines();
    } else {
      const latest = getLatestDriftReport();
      if (latest) {
        driftSummary = `[LAST DRIFT AUDIT ${new Date(latest.generatedAt).toISOString().split("T")[0]}] Direction: ${latest.directionSummary} | Surprise: ${latest.surpriseLevel}`;
      }
    }
  } catch (err) {
    log(`Drift audit error (non-fatal): ${err}`);
  }

  // Load person profiles for reflect context
  let personProfilesSection: string | undefined;
  try {
    const { loadPersonProfiles, serializeProfilesForPrompt } = await import("./memory/person-profiles.js");
    const profiles = loadPersonProfiles();
    if (profiles.length > 0) {
      personProfilesSection = serializeProfilesForPrompt(profiles);
    }
  } catch (err) {
    log(`Person profile loading error (non-fatal): ${err}`);
  }

  log(`Reflect: ${strongestNodes.length} context nodes, ${stats.nodeCount} total nodes, ${initiativeSignals.length} initiative signals, ${recentMoltbookActivity.length} moltbook items, ${recentOutgoingActivity.length} ARIA outgoing conversations (${ariaOutgoingFlat.length} msgs), ${ownerOutgoingActivity.length} owner conversations (${ownerOutgoingFlat.length} msgs, observe-only)`);

  const prompt = buildReflectPrompt({
    ownerName: OWNER_NAME,
    githubRepo: GITHUB_REPO,
    strongestNodes,
    graph,
    wm,
    stats,
    lastMessageTime: state.lastMessageTime,
    messagesToday: state.messagesToday,
    maxMessagesPerDay: cfg.maxMessagesPerDay,
    quietStart: cfg.quietStart,
    quietEnd: cfg.quietEnd,
    ownerTimezone: cfg.ownerTimezone,
    goalsSection,
    initiativeSignals,
    responsivenessPreset: getActivePreset(cfg),
    selfImproveStats,
    recentMoltbookActivity,
    recentOutgoingActivity,
    ownerOutgoingActivity,
    driftSummary,
    personProfilesSection,
    lastBrainMessage: state.lastBrainMessage,
  });

  const reflectPromptChars = prompt.length;
  log(`Reflect prompt: ${reflectPromptChars} chars (~${Math.ceil(reflectPromptChars / 3.5)} tokens)`);

  try {
    let lastLogTime = Date.now();
    let deltaChars = 0;
    const result = await queue.add(async () => {
      return await askClaudeStreaming(prompt, (delta) => {
        deltaChars += delta.length;
        const elapsed = Date.now() - lastLogTime;
        if (elapsed > 30_000) {
          log(`Reflect streaming: ${deltaChars} chars received so far...`);
          lastLogTime = Date.now();
        }
      }, {
        timeout: 600_000,
        allowedTools: BRAIN_TOOLS,
        noSession: true,
        model: getBrainConfig().models?.reflect,
      });
    });

    const reflectStats = result.stats;
    log(`Reflect streaming complete: ${deltaChars} chars, ${reflectStats?.inputTokens ?? "?"} input tokens, ${reflectStats?.outputTokens ?? "?"} output tokens, $${(reflectStats?.totalCostUsd ?? 0).toFixed(4)}`);
    const responseText = result.messages.join("\n");
    const response = parseBrainResponse(responseText);

    if (!response) {
      log("Could not parse reflect response");
      state.lastReflectTick = now;
      return false;
    }

    log(`Reflect reasoning: ${response.reasoning?.slice(0, 300) || "(none)"}`);

    if (response.operations.length > 0) {
      const opsVerify = verify({
        type: "memory_ops",
        source: "reflect",
        operationCount: response.operations.length,
        operationTypes: response.operations.map(o => o.op),
      });
      if (opsVerify.verdict === "blocked") {
        log(`Reflect ops BLOCKED by verifier: ${opsVerify.reasons.join("; ")}`);
      } else {
        const { applied, skipped } = graph.applyOperations(response.operations as MemoryOperation[]);
        log(`Reflect ops: ${applied} applied, ${skipped} skipped`);
      }
    }

    if (response.goalOps && response.goalOps.length > 0) {
      const goalResult = goalTracker.applyGoalOps(response.goalOps as GoalOperation[]);
      log(`Reflect goal ops: ${goalResult.applied} applied, ${goalResult.failed} failed${goalResult.errors.length > 0 ? ` — errors: ${goalResult.errors.join("; ")}` : ""}`);
      wm.activeGoals = goalTracker.getWorkingGoalRefs();
    }

    if (response.improvementProposals?.length) {
      enqueueImprovementProposals(response.improvementProposals, "reflect", cfg);
    }

    // Persist consciousness state update (reflect is deep self-reflection — ideal for evolution)
    if (response.consciousnessUpdate) {
      try {
        const { saveConsciousness } = await import("./consciousness.js");
        saveConsciousness(response.consciousnessUpdate);
        log(`Reflect consciousness updated (${response.consciousnessUpdate.length} chars)`);
      } catch (err) {
        log(`Reflect consciousness save error (non-fatal): ${err}`);
      }
    }

    if (response.workingMemory) {
      updateWorkingMemory(wm, response.workingMemory);
      saveWorkingMemory(wm);
    }

    if (response.message) {
      // Phase 3: Self-critique for reflect messages (always proactive)
      const hoursSinceLastMsg = state.lastMessageTime > 0
        ? (now - state.lastMessageTime) / 3600000
        : Infinity;
      const reflectCritique = await critiqueResponse(response.message, {
        isDirectReply: false,
        recentObservationCount: 0,
        hoursSinceLastMessage: hoursSinceLastMsg,
        messagesToday: state.messagesToday,
        maxMessagesPerDay: cfg.maxMessagesPerDay,
      });
      if (!reflectCritique.shouldSend) {
        log(`Reflect message suppressed by self-critique (score ${reflectCritique.score}): ${reflectCritique.reason}`);
        recordFailure("send_message", `reflect self-critique suppressed (score ${reflectCritique.score})`);
        recordBrainDelivery(state, response.message, response.messageTargetJid || ownerJid, "suppressed", `reflect self-critique (score ${reflectCritique.score}): ${reflectCritique.reason}`);
      } else {
        const delivery = await trySendMessage(state, sendMessage, ownerJid, response.message, {
          targetJid: response.messageTargetJid,
        });
        recordBrainDelivery(state, response.message, response.messageTargetJid || ownerJid, delivery.status, delivery.detail);
        scanAndProcessCommitments(response.message, "brain", OWNER_NAME, goalTracker);
      }
    }

    state.lastReflectTick = now;
    if (result.stats) {
      state.totalCost += result.stats.totalCostUsd || 0;
    }

    log(`Reflect complete (${graph.nodeCount} nodes, ${graph.edgeCount} edges)`);
    return true;
  } catch (err) {
    state.lastReflectTick = now;
    throw wrapError(err, "reflect", `Reflect failed: ${err}`, {
      elapsedMs: Date.now() - now,
      metadata: { contextNodes: strongestNodes?.length, signalCount: initiativeSignals?.length },
    });
  }
}
