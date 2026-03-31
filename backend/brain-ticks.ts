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
import type { MessageQueue } from "./queue.js";
import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryOperation, BrainResponse, BrainState, GoalOperation, ImprovementProposal } from "./memory/types.js";
import { createFlaggedRequest } from "./actionable-tracker.js";
import { getRecentDeliveries, DEDUP_WINDOW_MS } from "./scheduler.js";
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
import { getBrainConfig, getActivePreset } from "./brain-config.js";
import type { BrainConfig } from "./brain-config.js";
import {
  loadQueue,
  enqueueApproved,
  getWeeklyCompletedCount,
} from "./self-improve-queue.js";
import { loadSubAgents, loadSubAgentHistory } from "./sub-agents.js";
import { trySendMessage } from "./brain-delivery.js";
import { OWNER_NAME, GITHUB_REPO } from "./config.js";
import { critiqueResponse } from "./response-critique.js";
import { extractPreferenceSignals, updatePreferences } from "./preference-learner.js";

const log = createLogger("brain-ticks");

// ── Config ──

const BRAIN_TOOLS = process.env.BRAIN_TOOLS ?? "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch";

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

  const wm = loadWorkingMemory();
  populateTemporalContext(wm);

  const signalNodeIds = initiativeSignals.flatMap(s => s.relatedNodeIds);
  const contextNodes = selectContextForThink(graph, wm, allObs, signalNodeIds, initiativeSignals.length);

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
    goalsSection,
    initiativeSignals,
    responsivenessPreset: getActivePreset(cfg),
    recentChatDeliveries,
    selfImproveStats: selfImproveStatsThink,
  });

  try {
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
      });
    });

    log(`Think streaming complete: ${deltaChars} chars total`);
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
      goalTracker.applyGoalOps(response.goalOps as GoalOperation[]);
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
      saveWorkingMemory(wm);
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

    if (response.message) {
      const isDigestTriggered = allObs.some(o => o.text.startsWith("[DIGEST REQUEST:"));
      const isDirectReply = allObs.some(o => !o.isFromMe && o.trustLevel === "owner");

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
          // Skip sending but continue with other processing
        } else {
          await trySendMessage(state, sendMessage, ownerJid, response.message, {
            bypassLimits: isDigestTriggered,
            targetJid: response.messageTargetJid,
          });
          scanAndProcessCommitments(response.message, "brain", OWNER_NAME, goalTracker);
        }
      } else {
        await trySendMessage(state, sendMessage, ownerJid, response.message, {
          bypassLimits: isDigestTriggered,
          targetJid: response.messageTargetJid,
        });
        scanAndProcessCommitments(response.message, "brain", OWNER_NAME, goalTracker);
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
  if (decayResult.uncapturedSignals.length > 0) {
    log(`Consolidate audit: ${decayResult.uncapturedSignals.length} uncaptured signals found in observation logs`);
  }
  if (decayResult.deltaReport) {
    log(`Consolidate delta: ${decayResult.deltaReport.summary}`);
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

  log(`Consolidate: ${weakNodes.length} weak, ${orphanNodes.length} orphans, ${duplicateCandidates.length} duplicates, ${gistClusters.length} gist clusters → calling Claude`);

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
  });

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
      });
    });

    log(`Consolidate streaming complete: ${deltaChars} chars total`);
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
  const recentOutgoingActivity = recentOutgoing
    .filter(o => o.text && o.text.length >= 10)
    .map(o => ({
      source: o.source || "whatsapp",
      audience: o.chatName || o.groupName || "unknown",
      text: o.text,
    }));

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

  log(`Reflect: ${strongestNodes.length} context nodes, ${stats.nodeCount} total nodes, ${initiativeSignals.length} initiative signals, ${recentMoltbookActivity.length} moltbook items, ${recentOutgoingActivity.length} outgoing msgs`);

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
    goalsSection,
    initiativeSignals,
    responsivenessPreset: getActivePreset(cfg),
    selfImproveStats,
    recentMoltbookActivity,
    recentOutgoingActivity,
    driftSummary,
  });

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
      });
    });

    log(`Reflect streaming complete: ${deltaChars} chars total`);
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
      goalTracker.applyGoalOps(response.goalOps as GoalOperation[]);
      wm.activeGoals = goalTracker.getWorkingGoalRefs();
    }

    if (response.improvementProposals?.length) {
      enqueueImprovementProposals(response.improvementProposals, "reflect", cfg);
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
      } else {
        await trySendMessage(state, sendMessage, ownerJid, response.message, {
          targetJid: response.messageTargetJid,
        });
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
