/**
 * Brain tick implementations: consolidate and reflect (think lives in
 * brain-think.ts, shared helpers in brain-tick-shared.ts).
 *
 * Each LLM tick persists its own results via patchState; the orchestrator's
 * state argument is read-only input. See brain-tick-shared.ts for the
 * orphaned-tick rationale.
 */

import { createLogger } from "./logger.js";
import { getObservationsSince } from "./observer.js";
import type { Observation } from "./observer.js";
import { buildConsolidatePrompt, buildReflectPrompt } from "./brain-prompt.js";
import type { OutgoingActivityGroup } from "./brain-prompt.js";
import type { MessageQueue } from "./queue.js";
import type { MemoryGraph } from "./memory/graph.js";
import type { WorkingMemory, BrainState, GoalOperation, ImprovementProposal } from "./memory/types.js";
import type { InitiativeSignal } from "./initiative.js";
import { getRecentDeliveries, getRecentDeliveryLog, getScheduledMessages } from "./scheduler.js";
import { runConsolidation, detectGistClusters } from "./memory/consolidation.js";
import { loadWorkingMemory, saveWorkingMemory, updateWorkingMemory, populateTemporalContext, compileWeeklySummary, cleanupWorkingMemory } from "./memory/working-memory.js";
import { selectContextForConsolidate, selectContextForReflect } from "./memory/activation.js";
import { GoalTracker } from "./goals.js";
import { scanAndProcessCommitments } from "./accountability.js";
import { verify, rotateAuditLog } from "./action-verifier.js";
import { runDriftAudit, getLatestDriftReport, pruneBaselines } from "./drift-audit.js";
import { wrapError } from "./brain-errors.js";
import { getBrainConfig, getActivePreset } from "./brain-config.js";
import type { BrainConfig } from "./brain-config.js";
import { loadQueue, enqueue, enqueueApproved, getWeeklyCompletedCount } from "./self-improve-queue.js";
import { loadSubAgents, loadSubAgentHistory } from "./sub-agents.js";
import { trySendMessage } from "./brain-delivery.js";
import { OWNER_NAME, GITHUB_REPO } from "./config.js";
import { critiqueResponse } from "./response-critique.js";
import { recordFailure } from "./autonomy.js";
import { probeMemoryHealth } from "./health-monitor.js";
import { runSleepConsolidation } from "./sleep-consolidation.js";
import { detectStaleBeliefs } from "./belief-tracker.js";
import { analyzePatterns } from "./temporal-patterns.js";
import { runReflectiveConsolidation } from "./reflective-consolidation.js";
import { runKnowledgeCompilation } from "./knowledge-compiler.js";
import { rebuildPersonProfiles, loadPersonProfiles, serializeProfilesForPrompt } from "./memory/person-profiles.js";
import { saveConsciousness } from "./consciousness.js";
import { loadState, patchState } from "./brain-state.js";
import {
  parseBrainResponse,
  callBrainLlm,
  applyVerifiedMemoryOps,
  brainDeliveryRecord,
  persistSignalState,
  costOf,
  DELIVERY_SECTION_WINDOW_MS,
} from "./brain-tick-shared.js";

import { countProposedToday } from "./brain-think.js";

export { thinkTick, clearDigestCarryover, countProposedToday } from "./brain-think.js";
export { parseBrainResponse } from "./brain-tick-shared.js";

const log = createLogger("brain-ticks");

// Sleep consolidation runs at most once per 12 hours (expensive O(n²) pass)
let lastSleepConsolidationAt = 0;
const SLEEP_CONSOLIDATION_INTERVAL = 12 * 3600_000;

// ── Shared: enqueue improvement proposals ──

export function enqueueImprovementProposals(
  proposals: ImprovementProposal[],
  source: string,
  cfg: BrainConfig,
): number {
  if (!proposals.length || !cfg.selfImproveEnabled) return 0;

  const weeklyRemaining = cfg.selfImproveMaxPerWeek - getWeeklyCompletedCount();
  const currentPending = loadQueue().items.filter(
    i => i.status === "pending" || i.status === "approved" || i.status === "running"
      || i.status === "merge-pending" || i.status === "merge-failed",
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
    // Brain-originated proposals wait for review unless the owner opted into auto-approval.
    if (cfg.selfImproveAutoApprove) {
      enqueueApproved(task);
      log(`${source}: enqueued improvement proposal (auto-approved): ${proposal.description.slice(0, 80)}`);
    } else {
      enqueue(task);
      log(`${source}: enqueued improvement proposal (pending review): ${proposal.description.slice(0, 80)}`);
    }
    enqueued++;
  }

  if (proposals.length > canEnqueue) {
    log(`Dropped ${proposals.length - canEnqueue} ${source} proposals (weekly budget/queue limit)`);
  }

  return enqueued;
}

// ── Consolidate Tick (Claude call) ──

function runGuarded(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log(`${label} error (non-fatal): ${err}`);
  }
}

/** Structural maintenance passes that run every consolidate tick before any LLM call. */
function runConsolidateMaintenance(graph: MemoryGraph, wm: WorkingMemory, now: number): void {
  // Sleep consolidation: conflict detection, dedup, episodic→semantic promotion
  // Time-gated to avoid running expensive O(n²) passes every consolidate tick
  if (now - lastSleepConsolidationAt > SLEEP_CONSOLIDATION_INTERVAL) {
    runGuarded("Sleep consolidation", () => {
      const sleepResult = runSleepConsolidation(graph);
      lastSleepConsolidationAt = now;
      log(`Sleep consolidation: ${sleepResult.conflictsDetected} conflicts, ${sleepResult.conflictsResolved} resolved, ${sleepResult.promotedToSemantic} promoted`);
    });
  }
  runGuarded("Health probe", () => {
    const nodes = graph.allNodes();
    const avgStrength = nodes.length > 0 ? nodes.reduce((s, n) => s + n.strength, 0) / nodes.length : 0;
    probeMemoryHealth(graph.nodeCount, graph.edgeCount, graph.archiveSize, avgStrength);
  });
  runGuarded("Stale belief detection", () => {
    const staleBeliefs = detectStaleBeliefs(graph);
    if (staleBeliefs.length > 0) {
      log(`Stale beliefs: ${staleBeliefs.length} beliefs need review (old + medium confidence or contradicted)`);
    }
  });
  runGuarded("Reflective consolidation", () => {
    const gistResults = runReflectiveConsolidation(graph);
    if (gistResults.length > 0) {
      log(`Reflective consolidation: ${gistResults.length} gist nodes created from ${gistResults.reduce((s, r) => s + r.nodesConsolidated, 0)} weak nodes`);
    }
  });
  runGuarded("Knowledge compilation", () => {
    const compiled = runKnowledgeCompilation(graph);
    if (compiled > 0) log(`Knowledge compilation: ${compiled} patterns compiled`);
  });
  runGuarded("Temporal pattern analysis", () => {
    const patterns = analyzePatterns();
    if (patterns.length > 0) log(`Temporal patterns: ${patterns.length} recurring patterns detected`);
  });
  runGuarded("Weekly summary compilation", () => {
    compileWeeklySummary(wm);
    saveWorkingMemory(wm);
  });
  runGuarded("Person profile rebuild", () => {
    const profiles = rebuildPersonProfiles(graph);
    log(`Person profiles: rebuilt ${profiles.length} profiles`);
  });
}

function logDecayReports(decayResult: ReturnType<typeof runConsolidation>): void {
  if (decayResult.uncapturedSignals.length > 0) {
    log(`Consolidate audit: ${decayResult.uncapturedSignals.length} uncaptured signals found in observation logs`);
  }
  if (decayResult.deltaReport) log(`Consolidate delta: ${decayResult.deltaReport.summary}`);
  if (decayResult.driftReport) {
    const dr = decayResult.driftReport;
    log(`Consolidate drift: ${dr.driftedNodes.length} pinned nodes drifted (max ${dr.maxDriftScore.toFixed(3)}), ${dr.edgesLostTotal} edges lost, ${dr.missingNodes.length} missing`);
  }
  if (decayResult.driftAlert) log(`⚠ DRIFT ALERT: ${decayResult.driftAlert}`);
}

export async function consolidateTick(
  _state: BrainState,
  queue: MessageQueue,
  graph: MemoryGraph,
  signal?: AbortSignal,
): Promise<boolean> {
  const now = Date.now();
  const wm = loadWorkingMemory();

  const decayResult = runConsolidation(graph, wm);
  log(`Consolidate decay: ${decayResult.nodesDecayed} nodes decayed, ${decayResult.nodesPruned} archived, ${decayResult.edgesDecayed} edges decayed, ${decayResult.edgesPruned} pruned, ${decayResult.orphansPruned} orphans, ${decayResult.archiveRestored} recalled from archive`);
  runConsolidateMaintenance(graph, wm, now);
  logDecayReports(decayResult);

  populateTemporalContext(wm);
  const cleanup = cleanupWorkingMemory(wm);
  if (cleanup.trackingTrimmed > 0 || cleanup.followUpsPruned > 0 || cleanup.followUpsMerged > 0) {
    log(`Working memory cleanup: trimmed ${cleanup.trackingTrimmed} tracking items, pruned ${cleanup.followUpsPruned} follow-ups, merged ${cleanup.followUpsMerged} near-duplicates`);
    saveWorkingMemory(wm);
  }
  const { weakNodes, orphanNodes, duplicateCandidates, stats } = selectContextForConsolidate(graph);

  // Detect gist extraction candidates — clusters of similar old nodes
  const gistClusters = detectGistClusters(graph);

  const hasUncaptured = decayResult.uncapturedSignals.length > 0;
  const hasLowFidelity = decayResult.fidelityResults.some(r => r.lowFidelity);
  if (weakNodes.length === 0 && orphanNodes.length === 0 && duplicateCandidates.length === 0 && !hasUncaptured && !hasLowFidelity && gistClusters.length === 0) {
    log("Consolidate: nothing for Claude to review, decay-only cycle");
    patchState({ lastConsolidateTick: now });
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
  log(`Consolidate prompt: ${prompt.length} chars (~${Math.ceil(prompt.length / 3.5)} tokens) → calling Claude`);

  try {
    const { result, responseText } = await callBrainLlm("consolidate", prompt, queue, getBrainConfig().models?.consolidate, signal);
    const response = parseBrainResponse(responseText);
    if (!response) {
      log("Could not parse consolidate response");
      patchState(s => ({ lastConsolidateTick: now, totalCost: s.totalCost + costOf(result) }));
      return false;
    }

    log(`Consolidate reasoning: ${response.reasoning?.slice(0, 200) || "(none)"}`);
    applyVerifiedMemoryOps(graph, response.operations, "consolidate");
    rotateAuditLog();

    if (response.workingMemory) {
      updateWorkingMemory(wm, response.workingMemory);
      saveWorkingMemory(wm);
    }

    patchState(s => ({ lastConsolidateTick: now, totalCost: s.totalCost + costOf(result) }));
    log(`Consolidate complete (${graph.nodeCount} nodes, ${graph.edgeCount} edges)`);
    return true;
  } catch (err) {
    patchState({ lastConsolidateTick: now });
    throw wrapError(err, "consolidate", `Consolidate failed: ${err}`, {
      elapsedMs: Date.now() - now,
      metadata: { weakNodes: weakNodes.length, orphanNodes: orphanNodes.length },
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

interface OutgoingActivity {
  aria: OutgoingActivityGroup[];
  owner: OutgoingActivityGroup[];
  ariaCount: number;
  ownerCount: number;
}

/**
 * Recent outgoing messages grouped by conversation, split into what ARIA
 * actually sent vs what the owner typed. isFromMe=true covers BOTH (ARIA sends
 * through the owner's Baileys session), so ARIA-origin is cross-checked
 * against delivery-log.json plus synthetic ARIA observations.
 */
function collectOutgoingActivity(now: number): OutgoingActivity {
  const COMMITMENT_LOOKBACK = 12 * 60 * 60 * 1000;
  const DELIVERY_MATCH_TOLERANCE_MS = 15 * 60 * 1000;
  const recentOutgoing = getObservationsSince(now - COMMITMENT_LOOKBACK, { isFromMe: true }, 50);
  const ariaDeliveries = getRecentDeliveries(COMMITMENT_LOOKBACK);
  const isAriaSent = (o: Observation): boolean => {
    if (o.senderJid === "system" || (o.sender || "").startsWith("ARIA")) return true;
    const textKey = o.text.slice(0, 120);
    return ariaDeliveries.some(d =>
      d.messageSnippet === textKey && Math.abs(d.timestamp - o.timestamp) <= DELIVERY_MATCH_TOLERANCE_MS,
    );
  };

  const flat = recentOutgoing
    .filter(o => o.text && o.text.length >= 10)
    .map(o => ({
      source: o.source || "whatsapp",
      audience: o.chatName || o.groupName || "unknown",
      text: o.text,
      ariaSent: isAriaSent(o),
    }));

  const groupByConversation = (items: { source: string; audience: string; text: string }[]): OutgoingActivityGroup[] => {
    const map = new Map<string, OutgoingActivityGroup>();
    for (const a of items) {
      const key = `${a.source}::${a.audience}`;
      const existing = map.get(key);
      map.set(key, existing
        ? { ...existing, messageCount: existing.messageCount + 1, latestSnippet: a.text.slice(0, 200), texts: [...existing.texts, a.text] }
        : { source: a.source, audience: a.audience, messageCount: 1, latestSnippet: a.text.slice(0, 200), texts: [a.text] });
    }
    return Array.from(map.values());
  };
  const ariaFlat = flat.filter(a => a.ariaSent);
  const ownerFlat = flat.filter(a => !a.ariaSent);
  return { aria: groupByConversation(ariaFlat), owner: groupByConversation(ownerFlat), ariaCount: ariaFlat.length, ownerCount: ownerFlat.length };
}

/**
 * Weekly drift audit. A medium/high surprise alert goes to the owner through
 * the throttled brain channel (quiet hours, daily budget, verifier) — never a
 * raw send.
 */
async function runDriftAuditForReflect(sendMessage: SendFn, ownerJid: string): Promise<string | undefined> {
  try {
    const driftReport = await runDriftAudit();
    if (driftReport) {
      log(`Drift audit completed: surprise=${driftReport.surpriseLevel}`);
      if ((driftReport.surpriseLevel === "medium" || driftReport.surpriseLevel === "high") && ownerJid) {
        const alertMsg = `🔍 Weekly drift audit (surprise: ${driftReport.surpriseLevel})\n\n${driftReport.directionSummary}\n\n${driftReport.driftCharacterization}\n\nRecommendation: ${driftReport.recommendation}`;
        const delivery = await trySendMessage(sendMessage, ownerJid, alertMsg);
        if (delivery.status !== "sent") log(`Drift alert not delivered (${delivery.status}${delivery.detail ? `: ${delivery.detail}` : ""})`);
      }
      pruneBaselines();
      return `[DRIFT AUDIT] Direction: ${driftReport.directionSummary} | Surprise: ${driftReport.surpriseLevel} | ${driftReport.filesChanged.length} files changed | ${driftReport.recommendation}`;
    }
    const latest = getLatestDriftReport();
    if (latest) {
      return `[LAST DRIFT AUDIT ${new Date(latest.generatedAt).toISOString().split("T")[0]}] Direction: ${latest.directionSummary} | Surprise: ${latest.surpriseLevel}`;
    }
  } catch (err) {
    log(`Drift audit error (non-fatal): ${err}`);
  }
  return undefined;
}

function loadPersonProfilesSection(): string | undefined {
  try {
    const profiles = loadPersonProfiles();
    return profiles.length > 0 ? serializeProfilesForPrompt(profiles) : undefined;
  } catch (err) {
    log(`Person profile loading error (non-fatal): ${err}`);
    return undefined;
  }
}

type SendFn = (jid: string, text: string, source?: string) => Promise<void>;

async function handleReflectMessage(
  message: string,
  targetJid: string | undefined,
  sendMessage: SendFn,
  ownerJid: string,
  goalTracker: GoalTracker,
  cfg: BrainConfig,
  now: number,
): Promise<void> {
  const target = targetJid || ownerJid;
  const state = loadState();
  // Self-critique for reflect messages (always proactive)
  const critique = await critiqueResponse(message, {
    isDirectReply: false,
    recentObservationCount: 0,
    hoursSinceLastMessage: state.lastMessageTime > 0 ? (now - state.lastMessageTime) / 3600000 : Infinity,
    messagesToday: state.messagesToday,
    maxMessagesPerDay: cfg.maxMessagesPerDay,
  });
  if (!critique.shouldSend) {
    log(`Reflect message suppressed by self-critique (score ${critique.score}): ${critique.reason}`);
    recordFailure("send_message", `reflect self-critique suppressed (score ${critique.score})`);
    patchState({ lastBrainMessage: brainDeliveryRecord(message, target, "suppressed", `reflect self-critique (score ${critique.score}): ${critique.reason}`) });
    return;
  }
  const delivery = await trySendMessage(sendMessage, ownerJid, message, { targetJid });
  patchState({ lastBrainMessage: brainDeliveryRecord(message, target, delivery.status, delivery.detail) });
  if (delivery.status === "sent" || delivery.status === "queued") {
    scanAndProcessCommitments(message, "brain", OWNER_NAME, goalTracker);
  }
}

export async function reflectTick(
  state: BrainState,
  queue: MessageQueue,
  sendMessage: SendFn,
  ownerJid: string,
  graph: MemoryGraph,
  initiativeSignals: InitiativeSignal[] = [],
  signal?: AbortSignal,
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
    proposedToday: countProposedToday(cfg.ownerTimezone),
    autoApprove: cfg.selfImproveAutoApprove,
  };

  const recentMoltbookActivity = getRecentMoltbookActivity();
  const outgoing = collectOutgoingActivity(now);
  const driftSummary = await runDriftAuditForReflect(sendMessage, ownerJid);
  const personProfilesSection = loadPersonProfilesSection();

  log(`Reflect: ${strongestNodes.length} context nodes, ${stats.nodeCount} total nodes, ${initiativeSignals.length} initiative signals, ${recentMoltbookActivity.length} moltbook items, ${outgoing.aria.length} ARIA outgoing conversations (${outgoing.ariaCount} msgs), ${outgoing.owner.length} owner conversations (${outgoing.ownerCount} msgs, observe-only)`);

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
    recentOutgoingActivity: outgoing.aria,
    ownerOutgoingActivity: outgoing.owner,
    driftSummary,
    personProfilesSection,
    lastBrainMessage: state.lastBrainMessage,
    queuedMessages: getScheduledMessages(),
    recentDeliveryLog: getRecentDeliveryLog(DELIVERY_SECTION_WINDOW_MS),
  });
  log(`Reflect prompt: ${prompt.length} chars (~${Math.ceil(prompt.length / 3.5)} tokens)`);

  try {
    const { result, responseText } = await callBrainLlm("reflect", prompt, queue, cfg.models?.reflect, signal);
    const response = parseBrainResponse(responseText);
    if (!response) {
      log("Could not parse reflect response");
      patchState(s => ({ lastReflectTick: now, totalCost: s.totalCost + costOf(result) }));
      return false;
    }

    log(`Reflect reasoning: ${response.reasoning?.slice(0, 300) || "(none)"}`);
    applyVerifiedMemoryOps(graph, response.operations, "reflect");

    if (response.goalOps && response.goalOps.length > 0) {
      const goalResult = goalTracker.applyGoalOps(response.goalOps as GoalOperation[]);
      log(`Reflect goal ops: ${goalResult.applied} applied, ${goalResult.failed} failed${goalResult.errors.length > 0 ? ` — errors: ${goalResult.errors.join("; ")}` : ""}`);
      wm.activeGoals = goalTracker.getWorkingGoalRefs();
    }

    persistSignalState(loadState(), initiativeSignals, response.signalOps, "Reflect");

    if (response.improvementProposals?.length) {
      enqueueImprovementProposals(response.improvementProposals, "reflect", cfg);
    }

    // Reflect is deep self-reflection — ideal for consciousness evolution
    if (response.consciousnessUpdate) {
      runGuarded("Reflect consciousness save", () => {
        saveConsciousness(response.consciousnessUpdate!);
        log(`Reflect consciousness updated (${response.consciousnessUpdate!.length} chars)`);
      });
    }

    if (response.workingMemory) {
      updateWorkingMemory(wm, response.workingMemory);
      saveWorkingMemory(wm);
    }

    if (response.message) {
      await handleReflectMessage(response.message, response.messageTargetJid ?? undefined, sendMessage, ownerJid, goalTracker, cfg, now);
    }

    patchState(s => ({ lastReflectTick: now, totalCost: s.totalCost + costOf(result) }));
    log(`Reflect complete (${graph.nodeCount} nodes, ${graph.edgeCount} edges)`);
    return true;
  } catch (err) {
    patchState({ lastReflectTick: now });
    throw wrapError(err, "reflect", `Reflect failed: ${err}`, {
      elapsedMs: Date.now() - now,
      metadata: { contextNodes: strongestNodes.length, signalCount: initiativeSignals.length },
    });
  }
}
