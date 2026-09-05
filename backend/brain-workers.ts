/**
 * Self-improvement worker management and sub-agent lifecycle.
 * Extracted from brain.ts for maintainability.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { createLogger } from "./logger.js";
import { openWorkerLog, pruneWorkerLogs } from "./worker-logs.js";
import type { BrainState } from "./memory/types.js";
import type { MemoryGraph } from "./memory/graph.js";
import {
  loadQueue,
  loadHistory,
  enqueue,
  approveItem,
  dequeueApproved,
  completeItem,
  failItem,
  markMergePending,
  recordMergeFailure,
  getMergeCandidates,
  getQueueItem,
  getWeeklyCompletedCount,
  getDailyAttemptCount,
  getLastMergeAt,
} from "./self-improve-queue.js";
import type { QueueItem, ImproveResult } from "./self-improve-queue.js";
import {
  verifyAndMergePr,
  evaluateMergeGates,
  mergeBackoffMs,
  closePr,
  MAX_MERGE_ATTEMPTS,
} from "./self-improve-merge.js";
import { setWorkerPid, getWorkerPid, recordLastMerge } from "./self-improve-state.js";
import { findIntentCollisions } from "./utils/intent-hash.js";
import {
  getDueSubAgents,
  loadSubAgentState,
  markRunning,
  clearRunning,
  addRunToHistory,
  loadSubAgents,
  saveSubAgents,
  taskFilePath,
  resultFilePath,
  isProcessAlive,
} from "./sub-agents.js";
import type { SubAgentResult } from "./sub-agents.js";
import { getBrainConfig, getOwnerLocalTime } from "./brain-config.js";
import { randomUUID } from "crypto";
import { scrubWorkerEnv, findDenylistViolations, isPidAlive, killProcessGroup } from "./utils/worker-sandbox.js";

const log = createLogger("brain-workers");

const SELF_IMPROVE_STALE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const SUB_AGENT_STALE_TIMEOUT = 20 * 60 * 1000; // 20 minutes

// ── Shared helpers ──

function addMetaNode(graph: MemoryGraph, content: string, tags: string[], pinned: boolean): void {
  try {
    graph.addNode({
      id: `n_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      type: "meta",
      content,
      tags: ["self-improvement", ...tags],
      strength: pinned ? 1.0 : 0.9,
      pinned,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 1,
    });
    graph.save();
  } catch (err) {
    log(`Failed to record meta node (${tags.join(",")}): ${err}`);
  }
}

// ── Self-Improvement Worker ──

function spawnSelfImproveWorker(): void {
  log("Spawning self-improve worker as detached process");
  try {
    pruneWorkerLogs();
    const logFd = openWorkerLog(`self-improve-${Date.now()}`);
    const child = spawn("npx", ["tsx", "backend/self-improve.ts"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: "/app",
      env: scrubWorkerEnv(process.env),
    });
    child.unref();
    setWorkerPid(child.pid);
    log(`Self-improve worker spawned (pid: ${child.pid})`);
  } catch (err) {
    log(`Failed to spawn self-improve worker: ${err}`);
  }
}

function readQueuedItemId(queuedMarkerFile: string): string | null {
  try {
    if (existsSync(queuedMarkerFile)) {
      return readFileSync(queuedMarkerFile, "utf-8").trim() || null;
    }
  } catch (err) {
    log(`Failed to read queued marker file: ${err}`);
  }
  const running = loadQueue().items.find(i => i.status === "running");
  return running ? running.id : null;
}

/** Route a worker result to its queue item: fail, complete, or park for a verified merge. */
function routeResultToQueue(queueItemId: string, queueResult: ImproveResult): void {
  if (!queueResult.success) {
    failItem(queueItemId, queueResult);
    return;
  }
  if (!queueResult.prUrl) {
    completeItem(queueItemId, queueResult);
    return;
  }
  // The merge happens later, gated and verified, from processMergeQueue().
  if (!markMergePending(queueItemId, queueResult)) {
    log(`Queue item ${queueItemId} disappeared before merge — PR left open: ${queueResult.prUrl}`);
  }
}

function recordIntentCollisions(graph: MemoryGraph, result: { intent?: { hash: string; summary: string } }, queueItemId: string | null): void {
  if (!result.intent?.hash) return;
  try {
    const history = loadHistory();
    const matches = findIntentCollisions(history.entries, result.intent.hash, 30)
      .filter(m => m.id !== queueItemId);
    if (matches.length === 0) return;
    const summaries = matches
      .map(m => (m.task?.description ?? "").slice(0, 60))
      .filter(s => s.length > 0)
      .join("; ");
    addMetaNode(
      graph,
      `Intent collision detected: '${result.intent.summary}' (hash ${result.intent.hash}) overlaps with ${matches.length} prior improvement(s) in last 30 days: ${summaries}. Two workers may have fixed the same root cause from different ends — review diffs to determine duplicate / complementary / conflicting.`,
      ["intent-collision"],
      true,
    );
    log(`Intent collision: ${matches.length} prior match(es) on hash ${result.intent.hash}`);
  } catch (err) {
    log(`Intent collision check failed: ${err}`);
  }
}

export function pickUpImproveResult(
  state: BrainState,
  graph: MemoryGraph,
  saveState: (s: BrainState) => void,
  improveResultFile: string,
  improveTaskFile: string,
  queuedMarkerFile: string,
): void {
  // Parked results first: this is the continuation of result handling.
  processMergeQueue(graph);

  if (!existsSync(improveResultFile)) return;

  try {
    const raw = readFileSync(improveResultFile, "utf-8");
    const result = JSON.parse(raw);
    log(`Picked up improve result: success=${result.success}, description=${result.description?.slice(0, 100)}`);

    const queueItemId = readQueuedItemId(queuedMarkerFile);

    // Post-hoc sandbox audit on the worker's self-report. The authoritative
    // check runs on the real PR diff before merge (self-improve-merge.ts).
    const filesModified: string[] = Array.isArray(result.filesModified) ? result.filesModified : [];
    const violations = findDenylistViolations(filesModified);
    const sandboxFailed = violations.length > 0;
    if (sandboxFailed) {
      log(`SANDBOX VIOLATION: worker modified denylisted files: ${violations.join(", ")}`);
    }

    if (queueItemId) {
      routeResultToQueue(queueItemId, {
        success: !sandboxFailed && !!result.success,
        description: sandboxFailed
          ? `SANDBOX VIOLATION — worker touched forbidden files: ${violations.join(", ")}. Original: ${result.description || ""}`
          : (result.description || ""),
        prUrl: result.prUrl || undefined,
        branch: result.branch || undefined,
        wasRollback: result.wasRollback || undefined,
        intent: result.intent || undefined,
      });
    }

    try { if (existsSync(queuedMarkerFile)) unlinkSync(queuedMarkerFile); } catch (err) { log(`Failed to clean up queued marker file: ${err}`); }

    if (result.metaNodeContent || sandboxFailed) {
      const violationNote = sandboxFailed
        ? `\n!!! SANDBOX VIOLATION: worker modified denylisted files: ${violations.join(", ")}. PR open but flagged.`
        : "";
      const baseContent = result.metaNodeContent || "Self-improvement worker reported no summary";
      addMetaNode(
        graph,
        baseContent + violationNote + (result.prUrl ? `\nPR: ${result.prUrl}` : ""),
        [
          (sandboxFailed || !result.success) ? "failed" : "success",
          ...(result.wasRollback ? ["rollback"] : []),
          ...(sandboxFailed ? ["sandbox-violation"] : []),
        ],
        sandboxFailed,
      );
    }

    if (result.success) recordIntentCollisions(graph, result, queueItemId);

    state.pendingSelfMod = false;
    saveState(state);
    setWorkerPid(undefined);
    unlinkSync(improveResultFile);
    try { if (existsSync(improveTaskFile)) unlinkSync(improveTaskFile); } catch (err) { log(`Failed to clean up improve task file: ${err}`); }
  } catch (err) {
    log(`Failed to process improve result: ${err}`);
  }
}

// ── Verified merge queue ──

let mergeInProgress: string | null = null;

function finishMergeFailure(item: QueueItem, error: string, prNumber: number | null, graph: MemoryGraph): void {
  const updated = recordMergeFailure(item.id, error, Date.now() + mergeBackoffMs((item.mergeAttempts ?? 0) + 2));
  const attempts = updated?.mergeAttempts ?? MAX_MERGE_ATTEMPTS;
  if (attempts < MAX_MERGE_ATTEMPTS && prNumber !== null) {
    log(`Merge attempt ${attempts}/${MAX_MERGE_ATTEMPTS} failed for ${item.id} — will retry: ${error.slice(0, 200)}`);
    return;
  }
  log(`Merge exhausted for ${item.id} — closing PR: ${error.slice(0, 200)}`);
  if (prNumber !== null) {
    void closePr(prNumber, `ARIA auto-merge gave up after ${attempts} attempt(s). Last error:\n\n\`\`\`\n${error}\n\`\`\``);
  }
  failItem(item.id, { ...(item.result ?? { success: false, description: "" }), success: false, mergeError: error });
  addMetaNode(
    graph,
    `Self-improve PR could not be merged after ${attempts} attempt(s) and was closed: ${item.result?.prUrl ?? "?"}\nError: ${error.slice(0, 300)}`,
    ["merge-failed"],
    true,
  );
}

async function runVerifiedMerge(item: QueueItem, graph: MemoryGraph): Promise<void> {
  const prUrl = item.result?.prUrl;
  if (!prUrl) {
    failItem(item.id, { ...(item.result ?? { success: false, description: "" }), success: false, mergeError: "no PR URL" });
    return;
  }
  const outcome = await verifyAndMergePr(prUrl, { stillWanted: () => getQueueItem(item.id) !== null });
  if (outcome.ok) {
    recordLastMerge({ prNumber: outcome.prNumber, prUrl, mergeSha: outcome.mergeSha, mergedAt: outcome.mergedAt });
    if (!completeItem(item.id, item.result ?? { success: true, description: "" }, outcome.mergedAt)) {
      log(`Merged ${prUrl} but queue item ${item.id} was gone — recorded in state only`);
    }
    return;
  }
  if (getQueueItem(item.id) === null) {
    log(`Skipping merge bookkeeping for ${item.id}: item was deleted (${outcome.error.slice(0, 120)})`);
    return;
  }
  finishMergeFailure(item, outcome.error, outcome.prNumber, graph);
}

/**
 * Merge at most one parked PR per tick, subject to the budget/spacing/quiet
 * gates. Runs in the background so the tick is not blocked by verification.
 */
export function processMergeQueue(graph: MemoryGraph): void {
  if (mergeInProgress) return;
  const now = Date.now();
  const [candidate] = getMergeCandidates(now);
  if (!candidate) return;

  const cfg = getBrainConfig();
  const gate = evaluateMergeGates({
    cfg,
    ownerHour: getOwnerLocalTime(cfg.ownerTimezone).hour,
    dailyAttempts: getDailyAttemptCount(),
    lastMergeAt: getLastMergeAt(),
    now,
    isRecovery: !!candidate.result?.wasRollback,
  });
  if (!gate.allowed) {
    log(`Merge of ${candidate.id} deferred: ${gate.reason}`);
    return;
  }

  mergeInProgress = candidate.id;
  log(`Starting verified merge for ${candidate.id}: ${candidate.result?.prUrl}`);
  runVerifiedMerge(candidate, graph)
    .catch(err => log(`Verified merge crashed for ${candidate.id}: ${err}`))
    .finally(() => { mergeInProgress = null; });
}

export function interceptDirectTask(
  improveTaskFile: string,
  queuedMarkerFile: string,
): void {
  if (!existsSync(improveTaskFile)) return;
  if (existsSync(queuedMarkerFile)) return;

  try {
    const raw = readFileSync(improveTaskFile, "utf-8");
    const task = JSON.parse(raw);
    enqueue(task);
    unlinkSync(improveTaskFile);
    log("Intercepted self-improvement task → queued");
  } catch (err) {
    log(`Failed to intercept improve task: ${err}`);
  }
}

function handleStaleWorker(
  state: BrainState,
  saveState: (s: BrainState) => void,
  improveTaskFile: string,
  elapsedMin: number,
): void {
  const pid = getWorkerPid();
  if (pid && isPidAlive(pid)) {
    log(`Self-improve worker pid ${pid} still alive after ${elapsedMin}m — killing its process group`);
    killProcessGroup(pid);
  }
  setWorkerPid(undefined);

  if (existsSync(improveTaskFile)) {
    log(`Self-improve worker stale (${elapsedMin}m), task file exists — re-spawning`);
    state.selfModSpawnedAt = Date.now();
    saveState(state);
    spawnSelfImproveWorker();
  } else {
    log(`Self-improve worker stale (${elapsedMin}m), no task file — clearing flag`);
    state.pendingSelfMod = false;
    state.selfModSpawnedAt = undefined;
    saveState(state);
  }
}

function dequeueNextTask(cfg: ReturnType<typeof getBrainConfig>, improveTaskFile: string, queuedMarkerFile: string): void {
  if (getWeeklyCompletedCount() >= cfg.selfImproveMaxPerWeek) return;
  const attemptsToday = getDailyAttemptCount();
  if (attemptsToday >= cfg.selfImproveMaxPerDay) {
    return;
  }

  if (cfg.selfImproveAutoApprove) {
    for (const item of loadQueue().items) {
      if (item.status === "pending") {
        try { approveItem(item.id); } catch (err) { log(`Failed to auto-approve queue item ${item.id}: ${err}`); }
      }
    }
  }

  const item = dequeueApproved();
  if (!item) return;
  log(`Dequeued approved item ${item.id} — writing task file (attempts today ${attemptsToday}/${cfg.selfImproveMaxPerDay})`);
  try {
    writeFileSync(improveTaskFile, JSON.stringify(item.task, null, 2));
    writeFileSync(queuedMarkerFile, item.id);
  } catch (err) {
    log(`Failed to write task file from queue: ${err}`);
  }
}

export function checkAndSpawnImproveWorker(
  state: BrainState,
  saveState: (s: BrainState) => void,
  improveTaskFile: string,
  improveResultFile: string,
  queuedMarkerFile: string,
): void {
  const cfg = getBrainConfig();
  if (!cfg.selfImproveEnabled) return;

  // Case 1: Task file exists but no worker running — spawn one
  if (existsSync(improveTaskFile) && !state.pendingSelfMod) {
    log("Found improve-task.json — spawning self-improve worker");
    state.pendingSelfMod = true;
    state.selfModSpawnedAt = Date.now();
    saveState(state);
    spawnSelfImproveWorker();
    return;
  }

  // Case 2: Worker was spawned but seems stuck
  if (state.pendingSelfMod && !existsSync(improveResultFile)) {
    const elapsed = Date.now() - (state.selfModSpawnedAt || 0);
    if (elapsed > SELF_IMPROVE_STALE_TIMEOUT) {
      handleStaleWorker(state, saveState, improveTaskFile, Math.round(elapsed / 60000));
    }
    return;
  }

  // Case 3: No worker running, no task file — try to dequeue
  if (!state.pendingSelfMod && !existsSync(improveTaskFile)) {
    dequeueNextTask(cfg, improveTaskFile, queuedMarkerFile);
  }
}

// ── Sub-Agent Management ──

export function pickUpSubAgentResults(): void {
  const saState = loadSubAgentState();
  const running = Object.entries(saState.runningAgents);
  if (running.length === 0) return;

  for (const [agentId, info] of running) {
    const resFile = resultFilePath(agentId);

    if (existsSync(resFile)) {
      try {
        const result: SubAgentResult = JSON.parse(readFileSync(resFile, "utf-8"));
        addRunToHistory({
          id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          agentId,
          startedAt: info.startedAt,
          completedAt: result.completedAt || Date.now(),
          success: result.success,
          summary: result.summary || "",
          details: result.details || "",
          metrics: result.metrics,
          error: result.error,
        });

        const agents = loadSubAgents();
        const agent = agents.find(a => a.id === agentId);
        if (agent) {
          agent.lastRunAt = Date.now();
          saveSubAgents(agents);
        }

        clearRunning(agentId);
        unlinkSync(resFile);
        log(`Sub-agent result picked up: ${agentId} success=${result.success}`);
      } catch (err) {
        log(`Failed to read sub-agent result for ${agentId}: ${err}`);
        clearRunning(agentId);
        try { unlinkSync(resFile); } catch (cleanupErr) { log(`Failed to clean up sub-agent result file ${resFile}: ${cleanupErr}`); }
      }
    } else {
      const elapsed = Math.max(0, Date.now() - info.startedAt);
      const processAlive = info.pid ? isProcessAlive(info.pid) : false;

      if (elapsed > SUB_AGENT_STALE_TIMEOUT && !processAlive) {
        log(`Sub-agent worker stale for ${agentId} (${Math.round(elapsed / 60000)}m, pid=${info.pid ?? "unknown"}, alive=${processAlive}) — clearing`);
        addRunToHistory({
          id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          agentId,
          startedAt: info.startedAt,
          completedAt: Date.now(),
          success: false,
          summary: "Worker timed out",
          details: `Worker did not produce results within ${Math.round(SUB_AGENT_STALE_TIMEOUT / 60000)} minutes (pid=${info.pid ?? "unknown"})`,
          error: "timeout",
        });
        clearRunning(agentId);
        const taskFile = taskFilePath(agentId);
        try { if (existsSync(taskFile)) unlinkSync(taskFile); } catch (err) { log(`Failed to clean up stale task file ${taskFile}: ${err}`); }
      } else if (elapsed > SUB_AGENT_STALE_TIMEOUT && processAlive) {
        log(`Sub-agent worker for ${agentId} exceeded timeout (${Math.round(elapsed / 60000)}m) but pid=${info.pid} still alive — skipping cleanup`);
      }
    }
  }
}

function spawnSubAgentWorker(agentId: string): void {
  const logFd = openWorkerLog(`sub-agent-${agentId}-${Date.now()}`);
  const child = spawn("npx", ["tsx", "backend/sub-agent-worker.ts", agentId], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: "/app",
    env: scrubWorkerEnv(process.env),
  });
  if (child.pid) {
    markRunning(agentId, child.pid);
  }
  child.unref();
  log(`Spawned sub-agent worker for ${agentId} (pid=${child.pid})`);
}

export function checkAndSpawnSubAgentWorkers(): void {
  const due = getDueSubAgents();
  if (due.length === 0) return;

  for (const agent of due) {
    const tFile = taskFilePath(agent.id);
    try {
      writeFileSync(tFile, JSON.stringify({
        agentId: agent.id,
        name: agent.name,
        prompt: agent.prompt,
        tools: agent.tools,
        timeout: agent.timeout,
      }, null, 2));
    } catch (err) {
      log(`Failed to write task file for sub-agent ${agent.id}: ${err}`);
      continue;
    }

    spawnSubAgentWorker(agent.id);
  }
}
