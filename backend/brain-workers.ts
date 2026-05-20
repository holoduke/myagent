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
  getWeeklyCompletedCount,
} from "./self-improve-queue.js";
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
  loadSubAgentHistory,
  isProcessAlive,
} from "./sub-agents.js";
import type { SubAgentResult } from "./sub-agents.js";
import { getBrainConfig } from "./brain-config.js";
import { randomUUID } from "crypto";
import { scrubWorkerEnv, findDenylistViolations } from "./utils/worker-sandbox.js";

const log = createLogger("brain-workers");

const SELF_IMPROVE_STALE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const SUB_AGENT_STALE_TIMEOUT = 20 * 60 * 1000; // 20 minutes

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
    log(`Self-improve worker spawned (pid: ${child.pid})`);
  } catch (err) {
    log(`Failed to spawn self-improve worker: ${err}`);
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
  if (!existsSync(improveResultFile)) return;

  try {
    const raw = readFileSync(improveResultFile, "utf-8");
    const result = JSON.parse(raw);
    log(`Picked up improve result: success=${result.success}, description=${result.description?.slice(0, 100)}`);

    // Route result through queue — find the running item
    let queueItemId: string | null = null;
    try {
      if (existsSync(queuedMarkerFile)) {
        queueItemId = readFileSync(queuedMarkerFile, "utf-8").trim();
      }
    } catch (err) {
      log(`Failed to read queued marker file: ${err}`);
    }

    if (!queueItemId) {
      const queue = loadQueue();
      const running = queue.items.find(i => i.status === "running");
      if (running) queueItemId = running.id;
    }

    // Post-hoc sandbox audit: if the worker modified denylisted paths, force-fail
    // the queue item and loudly record the violation regardless of what the worker
    // claimed. The PR will still exist on GitHub; a human must close it.
    const filesModified: string[] = Array.isArray(result.filesModified) ? result.filesModified : [];
    const violations = findDenylistViolations(filesModified);
    const sandboxFailed = violations.length > 0;
    if (sandboxFailed) {
      log(`SANDBOX VIOLATION: worker modified denylisted files: ${violations.join(", ")}`);
    }

    if (queueItemId) {
      const queueResult = {
        success: !sandboxFailed && !!result.success,
        description: sandboxFailed
          ? `SANDBOX VIOLATION — worker touched forbidden files: ${violations.join(", ")}. Original: ${result.description || ""}`
          : (result.description || ""),
        prUrl: result.prUrl || undefined,
        branch: result.branch || undefined,
        wasRollback: result.wasRollback || undefined,
        intent: result.intent || undefined,
      };
      if (queueResult.success) {
        completeItem(queueItemId, queueResult);
      } else {
        failItem(queueItemId, queueResult);
      }
    }

    // Clean up marker file
    try { if (existsSync(queuedMarkerFile)) unlinkSync(queuedMarkerFile); } catch (err) { log(`Failed to clean up queued marker file: ${err}`); }

    // Create meta node from result
    if (result.metaNodeContent || sandboxFailed) {
      const id = `n_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      const violationNote = sandboxFailed
        ? `\n!!! SANDBOX VIOLATION: worker modified denylisted files: ${violations.join(", ")}. PR open but flagged.`
        : "";
      const baseContent = result.metaNodeContent || "Self-improvement worker reported no summary";
      graph.addNode({
        id,
        type: "meta",
        content: baseContent + violationNote + (result.prUrl ? `\nPR: ${result.prUrl}` : ""),
        tags: [
          "self-improvement",
          (sandboxFailed || !result.success) ? "failed" : "success",
          ...(result.wasRollback ? ["rollback"] : []),
          ...(sandboxFailed ? ["sandbox-violation"] : []),
        ],
        strength: sandboxFailed ? 1.0 : 0.9,
        pinned: sandboxFailed,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 1,
      });
      graph.save();
      log(`Created meta node ${id} from improve result`);
    }

    // Intent-collision detection: capture loose, classify late.
    // Cluster on intent.hash to spot when two workers shipped fixes for the same root cause.
    if (result.success && result.intent?.hash) {
      try {
        const history = loadHistory();
        const matches = findIntentCollisions(history.entries, result.intent.hash, 30)
          .filter(m => m.id !== queueItemId);
        if (matches.length > 0) {
          const summaries = matches
            .map(m => (m.task?.description ?? "").slice(0, 60))
            .filter(s => s.length > 0)
            .join("; ");
          const collisionId = `n_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
          graph.addNode({
            id: collisionId,
            type: "meta",
            content: `Intent collision detected: '${result.intent.summary}' (hash ${result.intent.hash}) overlaps with ${matches.length} prior improvement(s) in last 30 days: ${summaries}. Two workers may have fixed the same root cause from different ends — review diffs to determine duplicate / complementary / conflicting.`,
            tags: ["self-improvement", "intent-collision"],
            strength: 0.9,
            pinned: true,
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
            accessCount: 1,
          });
          graph.save();
          log(`Intent collision: ${collisionId} (${matches.length} prior match(es) on hash ${result.intent.hash})`);
        }
      } catch (err) {
        log(`Intent collision check failed: ${err}`);
      }
    }

    state.pendingSelfMod = false;
    saveState(state);
    unlinkSync(improveResultFile);
    try { if (existsSync(improveTaskFile)) unlinkSync(improveTaskFile); } catch (err) { log(`Failed to clean up improve task file: ${err}`); }
  } catch (err) {
    log(`Failed to process improve result: ${err}`);
  }
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
    const spawnedAt = state.selfModSpawnedAt || 0;
    const elapsed = Date.now() - spawnedAt;
    if (elapsed > SELF_IMPROVE_STALE_TIMEOUT) {
      if (existsSync(improveTaskFile)) {
        log(`Self-improve worker stale (${Math.round(elapsed / 60000)}m), task file exists — re-spawning`);
        state.selfModSpawnedAt = Date.now();
        saveState(state);
        spawnSelfImproveWorker();
      } else {
        log(`Self-improve worker stale (${Math.round(elapsed / 60000)}m), no task file — clearing flag`);
        state.pendingSelfMod = false;
        state.selfModSpawnedAt = undefined;
        saveState(state);
      }
    }
    return;
  }

  // Case 3: No worker running, no task file — try to dequeue
  if (!state.pendingSelfMod && !existsSync(improveTaskFile)) {
    if (getWeeklyCompletedCount() >= cfg.selfImproveMaxPerWeek) return;

    if (cfg.selfImproveAutoApprove) {
      const queue = loadQueue();
      for (const item of queue.items) {
        if (item.status === "pending") {
          try { approveItem(item.id); } catch (err) { log(`Failed to auto-approve queue item ${item.id}: ${err}`); }
        }
      }
    }

    const item = dequeueApproved();
    if (item) {
      log(`Dequeued approved item ${item.id} — writing task file`);
      try {
        writeFileSync(improveTaskFile, JSON.stringify(item.task, null, 2));
        writeFileSync(queuedMarkerFile, item.id);
      } catch (err) {
        log(`Failed to write task file from queue: ${err}`);
      }
    }
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
