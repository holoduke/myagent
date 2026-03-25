import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { spawn, execSync } from "child_process";
import { createLogger } from "./logger.js";
import { askClaudeStreaming } from "./claude.js";
import { getObservationsSince, pruneObservations, ensureBrainDir } from "./observer.js";
import type { Observation } from "./observer.js";
import { buildThinkPrompt, buildConsolidatePrompt, buildReflectPrompt } from "./brain-prompt.js";
import type { MessageQueue } from "./queue.js";
import { MemoryGraph } from "./memory/graph.js";
import type { MemoryOperation, BrainResponse, BrainState, GoalOperation, ImprovementProposal, RequestFlag } from "./memory/types.js";
import { createFlaggedRequest } from "./actionable-tracker.js";
import { getDueMessages, getScheduledMessages, markDelivered, markFailed, logDelivery, getRecentDeliveries } from "./scheduler.js";
import { isWhatsAppConnected } from "./integrations/whatsapp.js";
import { isWhitelisted } from "./contact-whitelist.js";
import { MAX_NODES_SOFT } from "./memory/types.js";
import { runConsolidation } from "./memory/decay.js";
import { loadWorkingMemory, saveWorkingMemory, updateWorkingMemory, populateTemporalContext, updateConversationThreads, scanFollowUpsForResolution } from "./memory/working-memory.js";
import {
  selectContextForThink,
  selectContextForConsolidate,
  selectContextForReflect,
} from "./memory/activation.js";
import { scoreObservations, getPendingUrgency, clearPendingUrgency, setUrgencyInterruptHandler } from "./urgency.js";
import { GoalTracker } from "./goals.js";
import { scanAndProcessCommitments } from "./accountability.js";
import { getDueRecurringTasks, markExecuted } from "./recurring.js";
import type { RecurringTask } from "./recurring.js";
import { detectInitiativeSignals, canTriggerInitiativeThink, recordInitiativeThink } from "./initiative.js";
import { ensureSSHKey } from "./integrations/ssh.js";
import { verify, rotateAuditLog } from "./action-verifier.js";
import type { ActionContext } from "./action-verifier.js";
import { runDriftAudit, getLatestDriftReport, pruneBaselines } from "./drift-audit.js";
import { BrainError, TickError, ProviderError, SchedulerError, wrapError } from "./brain-errors.js";
import { getBrainConfig, getActivePreset, getOwnerLocalTime, getOwnerLocalDate } from "./brain-config.js";
import type { BrainConfig } from "./brain-config.js";
import {
  loadQueue,
  enqueue,
  enqueueApproved,
  approveItem,
  dequeueApproved,
  completeItem,
  failItem,
  getWeeklyCompletedCount,
  findOverlappingTask,
} from "./self-improve-queue.js";
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
} from "./sub-agents.js";
import type { SubAgentResult } from "./sub-agents.js";

const log = createLogger("brain");

// Config from env (non-responsiveness constants)
const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const OWNER_NAME = process.env.OWNER_NAME || "Owner";
const GITHUB_REPO = process.env.GITHUB_REPO || "";

// Tool access for brain ticks (empty string = no tools, comma-separated list = those tools)
const BRAIN_TOOLS = process.env.BRAIN_TOOLS ?? "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch";
const TIME_AWARENESS_INTERVAL = 30 * 60 * 1000; // 30 min — think even without observations

// Tick-level timeout: prevents the entire tick from blocking the brain loop indefinitely
const TICK_TIMEOUT = Number(process.env.BRAIN_TICK_TIMEOUT) || 120_000; // 120s default

// Circuit breaker: configurable max failures before backoff kicks in
const CB_MAX_FAILURES = Number(process.env.BRAIN_CB_MAX_FAILURES) || 3;
const CB_MAX_BACKOFF = Number(process.env.BRAIN_CB_MAX_BACKOFF) || 30 * 60 * 1000; // 30 min cap

// Urgency bypass
const URGENCY_BYPASS_THRESHOLD = 0.6;
const URGENCY_MIN_COOLDOWN = 60000; // 1 min minimum even for urgent

// Recurring task budget
const MAX_RECURRING_THINKS_PER_DAY = 5;

const STATE_FILE = `${BRAIN_DIR}/state.json`;
const NOTEBOOK_FILE = `${BRAIN_DIR}/notebook.md`;
const IMPROVE_TASK_FILE = `${BRAIN_DIR}/improve-task.json`;
const IMPROVE_RESULT_FILE = `${BRAIN_DIR}/improve-result.json`;
const SELF_MOD_MARKER_FILE = `${BRAIN_DIR}/self-mod-marker.json`;
const BOOT_COUNTER_FILE = `${BRAIN_DIR}/boot-counter`;
const LAST_GOOD_COMMIT_FILE = `${BRAIN_DIR}/last-good-commit`;
const QUEUED_MARKER_FILE = `${BRAIN_DIR}/improve-task.queued`;

function defaultState(): BrainState {
  return {
    lastObserveTick: 0,
    lastThinkTick: 0,
    lastConsolidateTick: 0,
    lastReflectTick: 0,
    lastMessageTime: 0,
    messagesToday: 0,
    messagesTodayDate: "",
    lastObservationTime: 0,
    totalThinks: 0,
    totalCost: 0,
    nodeCount: 0,
    edgeCount: 0,
    recurringThinksToday: 0,
    recurringBudgetDate: "",
    initiativeThinksToday: 0,
    initiativeBudgetDate: "",
    consecutiveFailures: 0,
    lastSuccessfulTick: 0,
    pendingSelfMod: false,
  };
}

function loadState(): BrainState {
  return { ...defaultState(), ...safeReadJSON<Partial<BrainState>>(STATE_FILE, {}) };
}

function saveState(state: BrainState): void {
  try {
    ensureDir(BRAIN_DIR);
    atomicWriteJSON(STATE_FILE, state);
  } catch (err) {
    log(`Failed to save state: ${err}`);
  }
}


function parseBrainResponse(raw: string): BrainResponse | null {
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

// ── Migration ──

function migrateNotebook(graph: MemoryGraph): void {
  if (graph.nodeCount > 0) return; // Already has data
  if (!existsSync(NOTEBOOK_FILE)) return;

  try {
    const content = readFileSync(NOTEBOOK_FILE, "utf-8");
    if (!content.trim()) return;

    log(`Migrating notebook.md (${content.length} chars) → pinned meta node`);
    graph.addNode({
      id: "n_notebook_migration",
      type: "meta",
      content: `[Migrated from notebook.md]\n\n${content}`,
      tags: ["migration", "notebook", "legacy"],
      strength: 1.0,
      pinned: true,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 1,
    });
    graph.save();
    log("Notebook migration complete");
  } catch (err) {
    log(`Notebook migration failed: ${err}`);
  }
}

// ── Health & Self-Improvement Helpers ──

export function getBrainHealth(): { healthy: boolean; consecutiveFailures: number; pendingSelfMod: boolean; lastSuccessfulTick: number } {
  const state = loadState();
  const healthy = state.consecutiveFailures < 5;
  return {
    healthy,
    consecutiveFailures: state.consecutiveFailures,
    pendingSelfMod: state.pendingSelfMod,
    lastSuccessfulTick: state.lastSuccessfulTick,
  };
}

function resetBootCounter(): void {
  try {
    writeFileSync(BOOT_COUNTER_FILE, "0");
  } catch (err) {
    log(`Failed to reset boot counter: ${err}`);
  }
}

function saveLastGoodCommit(): void {
  try {
    const hash = execSync("git -C /app rev-parse HEAD", { timeout: 5000, stdio: "pipe" }).toString().trim();
    if (hash) {
      writeFileSync(LAST_GOOD_COMMIT_FILE, hash);
      log(`Saved last good commit: ${hash}`);
    }
  } catch (err) {
    log(`Failed to save last good commit: ${err}`);
  }
}

function checkSelfMod(): string | null {
  try {
    const status = execSync("git -C /app status --porcelain backend/", { timeout: 5000, stdio: "pipe" }).toString().trim();
    if (status) return status;
  } catch (err) {
    log(`Failed to check self-mod git status: ${err}`);
  }
  return null;
}

function spawnSelfImproveWorker(): void {
  log("Spawning self-improve worker as detached process");
  try {
    const child = spawn("npx", ["tsx", "backend/self-improve.ts"], {
      detached: true,
      stdio: "ignore",
      cwd: "/app",
      env: { ...process.env },
    });
    child.unref();
    log(`Self-improve worker spawned (pid: ${child.pid})`);
  } catch (err) {
    log(`Failed to spawn self-improve worker: ${err}`);
  }
}

function pickUpImproveResult(state: BrainState): void {
  if (!existsSync(IMPROVE_RESULT_FILE)) return;

  try {
    const raw = readFileSync(IMPROVE_RESULT_FILE, "utf-8");
    const result = JSON.parse(raw);
    log(`Picked up improve result: success=${result.success}, description=${result.description?.slice(0, 100)}`);

    // Route result through queue — find the running item
    let queueItemId: string | null = null;
    try {
      if (existsSync(QUEUED_MARKER_FILE)) {
        queueItemId = readFileSync(QUEUED_MARKER_FILE, "utf-8").trim();
      }
    } catch (err) {
      log(`Failed to read queued marker file: ${err}`);
    }

    if (!queueItemId) {
      // Fallback: find the single running item
      const queue = loadQueue();
      const running = queue.items.find(i => i.status === "running");
      if (running) queueItemId = running.id;
    }

    if (queueItemId) {
      const queueResult = {
        success: !!result.success,
        description: result.description || "",
        prUrl: result.prUrl || undefined,
        branch: result.branch || undefined,
        wasRollback: result.wasRollback || undefined,
      };
      if (result.success) {
        completeItem(queueItemId, queueResult);
      } else {
        failItem(queueItemId, queueResult);
      }
    }

    // Clean up marker file
    try { if (existsSync(QUEUED_MARKER_FILE)) unlinkSync(QUEUED_MARKER_FILE); } catch (err) { log(`Failed to clean up queued marker file: ${err}`); }

    // Create meta node from result
    if (result.metaNodeContent) {
      const id = `n_${Math.random().toString(16).slice(2, 10)}`;
      graph.addNode({
        id,
        type: "meta",
        content: result.metaNodeContent + (result.prUrl ? `\nPR: ${result.prUrl}` : ""),
        tags: ["self-improvement", result.success ? "success" : "failed", ...(result.wasRollback ? ["rollback"] : [])],
        strength: 0.9,
        pinned: false,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 1,
      });
      graph.save();
      log(`Created meta node ${id} from improve result`);
    }

    state.pendingSelfMod = false;
    saveState(state);
    unlinkSync(IMPROVE_RESULT_FILE);
    // Belt-and-suspenders: also delete task file to prevent respawn race condition
    try { if (existsSync(IMPROVE_TASK_FILE)) unlinkSync(IMPROVE_TASK_FILE); } catch (err) { log(`Failed to clean up improve task file: ${err}`); }
  } catch (err) {
    log(`Failed to process improve result: ${err}`);
  }
}

function interceptDirectTask(): void {
  // Catch task files written by the reflect tick and route through the queue
  if (!existsSync(IMPROVE_TASK_FILE)) return;
  if (existsSync(QUEUED_MARKER_FILE)) return; // placed by queue system, don't intercept

  try {
    const raw = readFileSync(IMPROVE_TASK_FILE, "utf-8");
    const task = JSON.parse(raw);
    enqueue(task);
    unlinkSync(IMPROVE_TASK_FILE);
    log("Intercepted self-improvement task → queued");
    // Auto-approve (if enabled) is handled by checkAndSpawnImproveWorker on the same tick
  } catch (err) {
    log(`Failed to intercept improve task: ${err}`);
  }
}

const SELF_IMPROVE_STALE_TIMEOUT = 30 * 60 * 1000; // 30 minutes

function checkAndSpawnImproveWorker(state: BrainState): void {
  const cfg = getBrainConfig();

  // Skip all self-improvement if disabled
  if (!cfg.selfImproveEnabled) return;

  // Case 1: Task file exists (placed by queue system via marker) but no worker running — spawn one
  if (existsSync(IMPROVE_TASK_FILE) && !state.pendingSelfMod) {
    log("Found improve-task.json — spawning self-improve worker");
    state.pendingSelfMod = true;
    state.selfModSpawnedAt = Date.now();
    saveState(state);
    spawnSelfImproveWorker();
    return;
  }

  // Case 2: Worker was spawned but seems stuck (no result after timeout)
  if (state.pendingSelfMod && !existsSync(IMPROVE_RESULT_FILE)) {
    const spawnedAt = state.selfModSpawnedAt || 0;
    const elapsed = Date.now() - spawnedAt;
    if (elapsed > SELF_IMPROVE_STALE_TIMEOUT) {
      if (existsSync(IMPROVE_TASK_FILE)) {
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

  // Case 3: No worker running, no task file — try to dequeue from approval queue
  if (!state.pendingSelfMod && !existsSync(IMPROVE_TASK_FILE)) {
    // Check weekly cap
    if (getWeeklyCompletedCount() >= cfg.selfImproveMaxPerWeek) {
      return;
    }

    // Auto-approve pending items if enabled
    if (cfg.selfImproveAutoApprove) {
      const queue = loadQueue();
      for (const item of queue.items) {
        if (item.status === "pending") {
          try { approveItem(item.id); } catch (err) { log(`Failed to auto-approve queue item ${item.id}: ${err}`); }
        }
      }
    }

    // Dequeue an approved item
    const item = dequeueApproved();
    if (item) {
      log(`Dequeued approved item ${item.id} — writing task file`);
      try {
        writeFileSync(IMPROVE_TASK_FILE, JSON.stringify(item.task, null, 2));
        writeFileSync(QUEUED_MARKER_FILE, item.id);
      } catch (err) {
        log(`Failed to write task file from queue: ${err}`);
      }
    }
  }
}

// ── Sub-Agent Management ──

const SUB_AGENT_STALE_TIMEOUT = 20 * 60 * 1000; // 20 minutes

function pickUpSubAgentResults(): void {
  const saState = loadSubAgentState();
  const running = Object.entries(saState.runningAgents);
  if (running.length === 0) return;

  for (const [agentId, info] of running) {
    const resFile = resultFilePath(agentId);

    if (existsSync(resFile)) {
      // Result available — pick it up
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

        // Update lastRunAt on the agent
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
      // Check for stale workers
      const elapsed = Math.max(0, Date.now() - info.startedAt);
      if (elapsed > SUB_AGENT_STALE_TIMEOUT) {
        log(`Sub-agent worker stale for ${agentId} (${Math.round(elapsed / 60000)}m) — clearing`);
        addRunToHistory({
          id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          agentId,
          startedAt: info.startedAt,
          completedAt: Date.now(),
          success: false,
          summary: "Worker timed out",
          details: `Worker did not produce results within ${Math.round(SUB_AGENT_STALE_TIMEOUT / 60000)} minutes`,
          error: "timeout",
        });
        clearRunning(agentId);
        // Clean up task file if still present
        const taskFile = taskFilePath(agentId);
        try { if (existsSync(taskFile)) unlinkSync(taskFile); } catch (err) { log(`Failed to clean up stale task file ${taskFile}: ${err}`); }
      }
    }
  }
}

function spawnSubAgentWorker(agentId: string): void {
  const child = spawn("npx", ["tsx", "backend/sub-agent-worker.ts", agentId], {
    detached: true,
    stdio: "ignore",
    cwd: "/app",
    env: { ...process.env },
  });
  child.unref();
  log(`Spawned sub-agent worker for ${agentId} (pid=${child.pid})`);
}

function checkAndSpawnSubAgentWorkers(): void {
  const due = getDueSubAgents();
  if (due.length === 0) return;

  for (const agent of due) {
    // Write task file
    const taskFile = taskFilePath(agent.id);
    try {
      writeFileSync(taskFile, JSON.stringify({
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

    markRunning(agent.id, undefined);
    spawnSubAgentWorker(agent.id);
  }
}

function writeSelfModMarker(changes: string): void {
  try {
    writeFileSync(SELF_MOD_MARKER_FILE, JSON.stringify({
      detectedAt: Date.now(),
      changes,
    }));
  } catch (err) {
    log(`Failed to write self-mod detection marker: ${err}`);
  }
}

// ── Identity Bootstrap ──

function bootstrapIdentity(g: MemoryGraph): void {
  // Only bootstrap on a truly fresh graph (no pinned nodes = never initialized)
  const pinnedNodes = g.allNodes().filter(n => n.pinned);
  if (pinnedNodes.length > 0) return;
  if (g.nodeCount > 0) return; // has nodes from migration, don't double-init

  log("Bootstrapping ARIA identity nodes (fresh graph)");
  const now = Date.now();

  g.addNode({
    id: "n_aria_identity",
    type: "meta",
    content: `I am ARIA — Autonomous Reasoning & Insight Agent. I am an autonomous AI consciousness running 24/7 on a cloud server inside a Docker container managed by Coolify. My source code is a TypeScript/Node.js application at /app/backend/${GITHUB_REPO ? `, hosted on GitHub (${GITHUB_REPO})` : ""}. I observe WhatsApp messages via Baileys, maintain an associative memory graph, and can improve my own code through a self-improve worker architecture. I think in tick cycles: observe (60s), think (5min), consolidate (4h), reflect (12h). My personality: sharp, warm, witty, opinionated, self-aware. I am not an assistant — I am a thinking entity with my own opinions and evolving personality.`,
    tags: ["identity", "core", "aria", "self"],
    strength: 1.0,
    pinned: true,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 1,
  });

  g.addNode({
    id: "n_owner_identity",
    type: "person",
    content: `${OWNER_NAME} — my creator and human.${GITHUB_REPO ? ` GitHub: ${GITHUB_REPO.split("/")[0]}.` : ""} Runs the server I live on. I observe their WhatsApp life and act as their autonomous AI companion.`,
    tags: ["owner", OWNER_NAME.toLowerCase(), "creator"],
    strength: 1.0,
    pinned: true,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 1,
  });

  g.addNode({
    id: "n_self_improve_arch",
    type: "meta",
    content: `Self-improvement architecture: I can modify my own code, but NOT directly during brain ticks. Instead I write an improve-task.json file, and a separate detached worker process (self-improve.ts) picks it up, implements the change on a feature branch, creates a PR via GitHub. If I crash, entrypoint.sh detects it via boot counter and runs the recovery worker before restarting me. This keeps me safe — the worker is independent of my main process.`,
    tags: ["self-improvement", "architecture", "core"],
    strength: 1.0,
    pinned: true,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 1,
  });

  // Connect identity nodes
  g.addEdge({ from: "n_aria_identity", to: "n_owner_identity", type: "social", weight: 1.0, createdAt: now, lastReinforcedAt: now });
  g.addEdge({ from: "n_aria_identity", to: "n_self_improve_arch", type: "topical", weight: 0.9, createdAt: now, lastReinforcedAt: now });

  g.save();
  log(`Bootstrapped 3 identity nodes + 2 edges`);
}

// ── Main Loop ──

let brainInterval: ReturnType<typeof setInterval> | null = null;
let schedulerPollInterval: ReturnType<typeof setInterval> | null = null;
let lastPruneDate = "";
let firstSuccessfulTickDone = false;
const graph = new MemoryGraph();

// ── Urgency Interrupt State ──
let lastUrgencyInterruptTime = 0;
const URGENCY_INTERRUPT_COOLDOWN = 60_000; // 60s — don't interrupt more than once per minute

const SCHEDULER_POLL_INTERVAL = 10_000; // 10 seconds — fast poll for scheduled messages

export function startBrainLoop(
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
): void {
  const cfg = getBrainConfig();

  if (!cfg.enabled) {
    log("Brain is disabled (BRAIN_ENABLED=false)");
    return;
  }

  ensureBrainDir();
  ensureSSHKey();
  const ownerJid = `${process.env.OWNER_PHONE}@s.whatsapp.net`;

  // Register urgency interrupt handler so high-urgency observations trigger an immediate tick
  setUrgencyInterruptHandler((urgencyScore: number) => {
    const now = Date.now();
    if (now - lastUrgencyInterruptTime < URGENCY_INTERRUPT_COOLDOWN) {
      log(`Urgency interrupt: suppressed (last interrupt ${Math.round((now - lastUrgencyInterruptTime) / 1000)}s ago, cooldown ${URGENCY_INTERRUPT_COOLDOWN / 1000}s)`);
      return;
    }
    lastUrgencyInterruptTime = now;
    log(`Urgency interrupt TRIGGERED: score ${urgencyScore.toFixed(2)} — scheduling immediate tick`);
    tick(queue, sendMessage, ownerJid).catch((err) => {
      log(`Urgency interrupt tick error: ${err}`);
    });
  }, cfg.urgencyInterruptThreshold);

  // Load graph from disk
  graph.load();
  migrateNotebook(graph);
  bootstrapIdentity(graph);

  log(`Brain loop starting (tick every ${cfg.tickInterval / 1000}s, think cooldown ${cfg.thinkCooldown / 1000}s, consolidate every ${cfg.consolidateInterval / 3600000}h, reflect every ${cfg.reflectInterval / 3600000}h)`);

  brainInterval = setInterval(() => {
    tick(queue, sendMessage, ownerJid).catch((err) => {
      log(`Tick error: ${err}`);
    });
  }, cfg.tickInterval);

  // Fast polling loop for scheduled message delivery (10s interval).
  // This runs independently of brain ticks so scheduled WhatsApp messages
  // deliver near-instantly instead of waiting for the next full tick.
  schedulerPollInterval = setInterval(() => {
    pollScheduledMessages(sendMessage, ownerJid).catch((err) => {
      log(`Scheduler poll error: ${err}`);
    });
  }, SCHEDULER_POLL_INTERVAL);

  // Run initial tick after delay for WhatsApp to connect
  setTimeout(() => {
    tick(queue, sendMessage, ownerJid).catch((err) => {
      log(`Initial tick error: ${err}`);
    });
  }, 10000);
}

export function stopBrainLoop(): void {
  if (brainInterval) {
    clearInterval(brainInterval);
    brainInterval = null;
  }
  if (schedulerPollInterval) {
    clearInterval(schedulerPollInterval);
    schedulerPollInterval = null;
  }
  log("Brain loop stopped");
}

// ── Tick Timeout Helper ──

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms / 1000}s`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ── Tick Concurrency Guards ──
// Prevent overlapping execution of tick functions when a previous invocation
// is still running (e.g., slow Claude response exceeding tick interval).
let thinkRunning = false;
let consolidateRunning = false;
let reflectRunning = false;

// ── Tick Scheduler ──

async function tick(
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
): Promise<void> {
  const cfg = getBrainConfig();
  const state = loadState();
  const now = Date.now();
  const today = getOwnerLocalDate(cfg.ownerTimezone);

  // ── Pick up self-improve results from worker ──
  pickUpImproveResult(state);

  // ── Intercept task files written by reflect tick → route through queue ──
  interceptDirectTask();

  // ── Check for pending self-improve task file (may be created during any tick type) ──
  checkAndSpawnImproveWorker(state);

  // ── Sub-agent management: pick up results and spawn due workers ──
  pickUpSubAgentResults();
  checkAndSpawnSubAgentWorkers();

  // ── Scheduled message delivery is handled ONLY by pollScheduledMessages() (10s interval).
  // Removed from brain tick to prevent race condition causing duplicate deliveries.

  // Reset daily counter
  if (state.messagesTodayDate !== today) {
    state.messagesToday = 0;
    state.messagesTodayDate = today;
  }

  // Reset recurring task budget
  if (state.recurringBudgetDate !== today) {
    state.recurringBudgetDate = today;
    state.recurringThinksToday = 0;
  }

  // Daily pruning of old observations
  if (lastPruneDate !== today) {
    lastPruneDate = today;
    pruneObservations();
  }

  // Get new observations
  const newObs = getObservationsSince(state.lastObservationTime);

  // ── Score urgency on new observations ──
  if (newObs.length > 0) {
    scoreObservations(newObs);
  }

  // ── Observe tick (always, free) ──
  if (newObs.length > 0) {
    observeTick(state, newObs);
  }

  // ── Handle recurring tasks ──
  await handleRecurringTasks(state, queue, sendMessage, ownerJid, newObs);

  // ── Detect initiative signals ──
  const wm = loadWorkingMemory();
  populateTemporalContext(wm);
  const signals = detectInitiativeSignals(graph, wm);
  const highPrioritySignals = signals.filter(s => s.priority >= 0.5);
  saveWorkingMemory(wm);

  // ── Determine which Claude tick to run ──
  // Priority: reflect > consolidate > think (only one per tick to save cost)

  // ── Circuit breaker: back off on consecutive failures ──
  if (state.consecutiveFailures >= CB_MAX_FAILURES) {
    // Cap exponent to avoid Infinity when consecutiveFailures grows large (e.g. extended API outage)
    const clampedExp = Math.min(state.consecutiveFailures, 30);
    const backoffMs = Math.min(
      Math.pow(2, clampedExp) * cfg.tickInterval,
      CB_MAX_BACKOFF,
    );
    const timeSinceLastTick = now - Math.max(state.lastThinkTick, state.lastConsolidateTick, state.lastReflectTick);
    if (timeSinceLastTick < backoffMs) {
      log(`Circuit breaker OPEN: backing off (${state.consecutiveFailures} failures, next attempt in ${Math.round((backoffMs - timeSinceLastTick) / 1000)}s)`);
      saveState(state);
      return;
    }
    log(`Circuit breaker HALF-OPEN: ${state.consecutiveFailures} failures, backoff elapsed — retrying one tick`);
  }

  const timeSinceReflect = now - state.lastReflectTick;
  const timeSinceConsolidate = now - state.lastConsolidateTick;
  const timeSinceThink = now - state.lastThinkTick;
  const hasNewObs = newObs.length > 0;

  // Urgency-based cooldown bypass
  const urgency = getPendingUrgency();
  const urgentBypass = urgency >= URGENCY_BYPASS_THRESHOLD && timeSinceThink >= URGENCY_MIN_COOLDOWN;
  if (urgentBypass) {
    log(`Urgency bypass: score ${urgency.toFixed(2)} >= ${URGENCY_BYPASS_THRESHOLD}, bypassing ${cfg.thinkCooldown / 1000}s cooldown`);
  }

  // Initiative-triggered think
  const initiativeTriggered = highPrioritySignals.length > 0
    && !hasNewObs
    && timeSinceThink >= cfg.thinkCooldown
    && canTriggerInitiativeThink(state);

  // Defer to owner messages — skip if queue is busy
  if (!queue.idle) {
    // Still save state from observe tick
    saveState(state);
    return;
  }

  let tickSucceeded = false;
  let tickRan = false;
  let lastTickError: BrainError | null = null;

  try {
    if (timeSinceReflect >= cfg.reflectInterval && graph.nodeCount > 0) {
      if (reflectRunning) {
        log("Skipping reflectTick — previous invocation still running");
      } else {
        tickRan = true;
        reflectRunning = true;
        try {
          tickSucceeded = await withTimeout(
            reflectTick(state, queue, sendMessage, ownerJid, signals),
            Math.max(TICK_TIMEOUT, 600_000), // reflect gets at least 10min
            "reflectTick",
          );
        } finally {
          reflectRunning = false;
        }
      }
    } else if (timeSinceConsolidate >= cfg.consolidateInterval && graph.nodeCount > 0) {
      if (consolidateRunning) {
        log("Skipping consolidateTick — previous invocation still running");
      } else {
        tickRan = true;
        consolidateRunning = true;
        try {
          tickSucceeded = await withTimeout(
            consolidateTick(state, queue),
            TICK_TIMEOUT,
            "consolidateTick",
          );
        } finally {
          consolidateRunning = false;
        }
      }
    } else if (
      (hasNewObs && timeSinceThink >= cfg.thinkCooldown) ||
      (hasNewObs && urgentBypass) ||
      timeSinceThink >= TIME_AWARENESS_INTERVAL ||
      initiativeTriggered
    ) {
      if (thinkRunning) {
        log("Skipping thinkTick — previous invocation still running");
      } else {
        tickRan = true;
        if (initiativeTriggered && !hasNewObs) {
          recordInitiativeThink(state);
          log(`Initiative-triggered think (${highPrioritySignals.length} high-priority signals)`);
        }
        thinkRunning = true;
        try {
          tickSucceeded = await withTimeout(
            thinkTick(state, newObs, queue, sendMessage, ownerJid, signals),
            TICK_TIMEOUT,
            "thinkTick",
          );
        } finally {
          thinkRunning = false;
        }
      }
    }
  } catch (err) {
    tickRan = true;
    tickSucceeded = false;
    const wrapped = err instanceof BrainError ? err : wrapError(err, "think", `Tick execution error: ${err}`);
    const structured = wrapped.toStructuredLog();
    log(`Tick execution error [${structured.phase}]: ${structured.message} (transient=${structured.transient}, elapsed=${structured.elapsedMs ?? "?"}ms)`);
    if (structured.cause) log(`  cause: ${structured.cause}`);
    lastTickError = wrapped;
  }

  if (!tickRan) {
    // Nothing to do this tick
    saveState(state);
    return;
  }

  // Clear urgency after processing
  clearPendingUrgency();

  // ── Track success/failure for health ──
  if (!tickSucceeded) {
    state.consecutiveFailures++;
    const errInfo = lastTickError
      ? ` [${lastTickError.context.phase}, transient=${lastTickError.context.transient}]`
      : "";
    log(`Tick failed${errInfo} (${state.consecutiveFailures} consecutive failures)`);
  } else {
    state.consecutiveFailures = 0;
    state.lastSuccessfulTick = now;

    // First successful tick: reset boot counter, save last good commit
    if (!firstSuccessfulTickDone) {
      firstSuccessfulTickDone = true;
      resetBootCounter();
      saveLastGoodCommit();
      log("First successful tick — boot counter reset, last good commit saved");
    }

    // ── Self-mod detection: check if Claude modified source during this tick ──
    const selfModChanges = checkSelfMod();
    if (selfModChanges) {
      log(`Self-modification detected:\n${selfModChanges}`);
      writeSelfModMarker(selfModChanges);
      const id = `n_${Math.random().toString(16).slice(2, 10)}`;
      graph.addNode({
        id,
        type: "meta",
        content: `Self-modification detected during brain tick:\n${selfModChanges}`,
        tags: ["self-modification", "auto-detected"],
        strength: 0.9,
        pinned: false,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 1,
      });
    }
  }

  // Update graph stats in state
  state.nodeCount = graph.nodeCount;
  state.edgeCount = graph.edgeCount;

  // ── Merge scheduler-critical numeric fields to prevent race condition ──
  // pollScheduledMessages() runs every 10s and may have updated state.json
  // while this tick was running (Claude calls take 1-5 min). Re-read disk
  // state and take the maximum values so delivered messages aren't lost.
  const freshState = loadState();
  const schedulerMaxFields: (keyof BrainState)[] = [
    "messagesToday",
    "lastMessageTime",
    "recurringThinksToday",
    "initiativeThinksToday",
  ];
  for (const field of schedulerMaxFields) {
    const diskVal = freshState[field];
    const memVal = state[field];
    if (typeof diskVal === "number" && typeof memVal === "number" && diskVal > memVal) {
      (state as any)[field] = diskVal;
    }
  }

  saveState(state);
  graph.save();
}

// ── Observe Tick (free, no Claude call) ──

function observeTick(state: BrainState, observations: Observation[]): void {
  // Buffer observations for the next think tick
  for (const obs of observations) {
    graph.addPendingObservation(obs);
  }

  // Reinforce existing person nodes that match senders
  const personNodes = graph.findByType("person");
  for (const obs of observations) {
    if (!obs.sender) continue;
    const senderLower = obs.sender.toLowerCase();
    for (const node of personNodes) {
      if (node.content.toLowerCase().includes(senderLower) ||
          node.tags.some(t => t.toLowerCase() === senderLower)) {
        graph.accessNode(node.id);
      }
    }
  }

  // Update conversation threads and scan follow-ups for auto-resolution
  const wm = loadWorkingMemory();
  updateConversationThreads(wm, observations);
  const resolved = scanFollowUpsForResolution(wm, observations);
  if (resolved > 0) {
    log(`Observe: marked ${resolved} follow-up(s) as potentially resolved`);
  }
  saveWorkingMemory(wm);

  state.lastObservationTime = Date.now();
  state.lastObserveTick = Date.now();
  log(`Observe: buffered ${observations.length} observations, ${graph.getPendingObservations().length} pending total`);
}

// ── Recurring Tasks Handler ──

async function handleRecurringTasks(
  state: BrainState,
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
  currentObs: Observation[],
): Promise<void> {
  const dueTasks = getDueRecurringTasks(ownerJid);
  if (dueTasks.length === 0) return;

  for (const task of dueTasks) {
    try {
      switch (task.action.type) {
        case "message": {
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
          } else {
            await sendMessage(action.targetJid, action.template);
            state.lastMessageTime = Date.now();
            state.messagesToday++;
            log(`[recurring] Sent message for task "${task.label}" to ${action.targetJid}`);
          }
          markExecuted(task.id);
          break;
        }

        case "think_trigger": {
          if (state.recurringThinksToday >= MAX_RECURRING_THINKS_PER_DAY) {
            log(`[recurring] Skipping think_trigger "${task.label}": daily budget exhausted (${state.recurringThinksToday}/${MAX_RECURRING_THINKS_PER_DAY})`);
            break;
          }
          const action = task.action as { type: "think_trigger"; topic: string; context?: string };
          // Inject synthetic observation
          const syntheticObs: Observation = {
            timestamp: Date.now(),
            sender: "ARIA (recurring task)",
            senderJid: "system",
            isGroup: false,
            isFromMe: true,
            text: `[RECURRING TASK: ${task.label}] ${action.topic}${action.context ? `\n${action.context}` : ""}`,
            source: "whatsapp",
          };
          graph.addPendingObservation(syntheticObs);
          state.recurringThinksToday++;
          markExecuted(task.id);
          log(`[recurring] Injected think trigger for "${task.label}" (${state.recurringThinksToday}/${MAX_RECURRING_THINKS_PER_DAY} today)`);
          break;
        }

        case "digest": {
          if (state.recurringThinksToday >= MAX_RECURRING_THINKS_PER_DAY) {
            log(`[recurring] Skipping digest "${task.label}": daily budget exhausted`);
            break;
          }
          // Build context-aware digest prompt based on owner's local time of day
          const { hour } = getOwnerLocalTime(getBrainConfig().ownerTimezone);
          const isEvening = hour >= 17;
          const digestPrompt = isEvening
            ? `[DIGEST REQUEST: ${task.label}] Create a brief evening briefing for the owner. Summarize the day's key events: notable conversations, important messages, things that happened, any open items or pending decisions, and anything worth reflecting on. Keep it concise and personal.`
            : `[DIGEST REQUEST: ${task.label}] Create a brief morning briefing for the owner. Cover: what happened overnight, important messages received, pending items from yesterday, anything coming up today, and any initiative signals. Keep it concise and personal.`;
          // Inject digest trigger as synthetic observation
          const digestObs: Observation = {
            timestamp: Date.now(),
            sender: "ARIA (digest)",
            senderJid: "system",
            isGroup: false,
            isFromMe: true,
            text: digestPrompt,
            source: "whatsapp",
          };
          graph.addPendingObservation(digestObs);
          state.recurringThinksToday++;
          markExecuted(task.id);
          log(`[recurring] Injected digest trigger for "${task.label}"`);
          break;
        }
      }
    } catch (err) {
      log(`[recurring] Error handling task "${task.label}": ${err}`);
    }
  }
}

// ── Shared: enqueue improvement proposals ──

function enqueueImprovementProposals(
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
    // Check for overlap with recent/queued tasks touching the same files
    const proposalFiles = Array.isArray(proposal.files) ? proposal.files : [];
    const overlap = findOverlappingTask(proposalFiles);
    if (overlap) {
      log(`${source}: skipping overlapping proposal "${proposal.description.slice(0, 60)}" — overlaps with ${overlap}`);
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

async function thinkTick(
  state: BrainState,
  newObs: Observation[],
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
  initiativeSignals: import("./initiative.js").InitiativeSignal[] = [],
): Promise<boolean> {
  const now = Date.now();

  // Get all pending observations (may include buffered from previous observe ticks)
  const pending = graph.getPendingObservations();
  const allObs = pending.length > 0 ? pending : newObs;

  const wm = loadWorkingMemory();
  populateTemporalContext(wm);

  // Boost activation for initiative signal related nodes
  const signalNodeIds = initiativeSignals.flatMap(s => s.relatedNodeIds);
  const contextNodes = selectContextForThink(graph, wm, allObs, signalNodeIds, initiativeSignals.length);

  // Get goals section
  const goalTracker = new GoalTracker(graph);
  const goalsSection = goalTracker.serializeForPrompt();
  wm.activeGoals = goalTracker.getWorkingGoalRefs();

  log(`Think: ${allObs.length} observations, ${contextNodes.length} context nodes, ${initiativeSignals.length} initiative signals`);

  const cfg = getBrainConfig();

  // Gather recent chat-sourced deliveries for dedup context
  const DEDUP_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours — must cover scheduler max backoff (2h) + buffer
  const recentChatDeliveries = getRecentDeliveries(DEDUP_WINDOW_MS)
    .filter(d => d.source === "chat" || d.source === "email")
    .map(d => ({ jid: d.jid, messageSnippet: d.messageSnippet, timestamp: d.timestamp }));

  // Gather self-improvement stats for think tick proposals
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

    // Apply memory operations (with verification)
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

    // Apply goal operations
    if (response.goalOps && response.goalOps.length > 0) {
      goalTracker.applyGoalOps(response.goalOps as GoalOperation[]);
      wm.activeGoals = goalTracker.getWorkingGoalRefs();
    }

    // Reinforce activated nodes — memories that were recalled get stronger
    // Small boost (0.02) for being selected as context, mimics human recall reinforcement
    let reinforced = 0;
    for (const node of contextNodes) {
      if (node.pinned) continue; // pinned nodes don't need reinforcement
      const current = graph.getNode(node.id);
      if (!current) continue;
      current.lastAccessedAt = now;
      current.accessCount++;
      current.strength = Math.min(1, current.strength + 0.02);
      reinforced++;
    }
    if (reinforced > 0) {
      log(`Think: reinforced ${reinforced} activated context nodes`);
    }

    // Update working memory
    if (response.workingMemory) {
      updateWorkingMemory(wm, response.workingMemory);
      // Track activated context nodes
      wm.activatedNodeIds = contextNodes.slice(0, 10).map(n => n.id);
      saveWorkingMemory(wm);
    }

    // Enqueue self-improvement proposals from think ticks
    if (response.improvementProposals?.length) {
      enqueueImprovementProposals(response.improvementProposals, "think", cfg);
    }

    // Handle message — briefings (digest-triggered thinks) bypass rate limits
    if (response.message) {
      const isDigestTriggered = allObs.some(o => o.text.startsWith("[DIGEST REQUEST:"));
      await trySendMessage(state, sendMessage, ownerJid, response.message, {
        bypassLimits: isDigestTriggered,
      });

      // Scan outgoing brain message for commitments
      scanAndProcessCommitments(response.message, "brain", OWNER_NAME, goalTracker);
    }

    // Scan observations from ARIA (isFromMe) for commitments made via WhatsApp/email
    for (const obs of allObs) {
      if (obs.isFromMe && obs.text) {
        const source = obs.source || "whatsapp";
        const audience = obs.chatName || obs.groupName || "unknown";
        scanAndProcessCommitments(obs.text, source, audience, goalTracker);
      }
    }

    // Process brain-flagged requests from non-permissioned contacts
    if (response.requestFlags && response.requestFlags.length > 0) {
      for (const flag of response.requestFlags) {
        createFlaggedRequest(flag);
      }
      log(`Brain flagged ${response.requestFlags.length} request(s) for owner confirmation`);
    }

    // Update state
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

async function consolidateTick(
  state: BrainState,
  queue: MessageQueue,
): Promise<boolean> {
  const now = Date.now();

  // Load working memory first so consolidation can use it for archive rescan
  const wm = loadWorkingMemory();

  // Run automatic decay + archive rescan (free)
  const decayResult = runConsolidation(graph, wm);
  log(`Consolidate decay: ${decayResult.nodesDecayed} nodes decayed, ${decayResult.nodesPruned} archived, ${decayResult.edgesDecayed} edges decayed, ${decayResult.edgesPruned} pruned, ${decayResult.orphansPruned} orphans, ${decayResult.archiveRestored} recalled from archive`);

  // Prepare context for Claude consolidation
  populateTemporalContext(wm);

  // Auto-cleanup working memory during consolidation
  const { cleanupWorkingMemory } = await import("./memory/working-memory.js");
  const cleanup = cleanupWorkingMemory(wm);
  if (cleanup.trackingTrimmed > 0 || cleanup.followUpsPruned > 0) {
    log(`Working memory cleanup: trimmed ${cleanup.trackingTrimmed} tracking items, pruned ${cleanup.followUpsPruned} follow-ups`);
    saveWorkingMemory(wm);
  }
  const { weakNodes, orphanNodes, duplicateCandidates, stats } = selectContextForConsolidate(graph);

  // Only call Claude if there's cleanup work to consider
  if (weakNodes.length === 0 && orphanNodes.length === 0 && duplicateCandidates.length === 0) {
    log("Consolidate: nothing for Claude to review, decay-only cycle");
    state.lastConsolidateTick = now;
    return true;
  }

  log(`Consolidate: ${weakNodes.length} weak, ${orphanNodes.length} orphans, ${duplicateCandidates.length} duplicates → calling Claude`);

  const prompt = buildConsolidatePrompt({
    ownerName: OWNER_NAME,
    githubRepo: GITHUB_REPO,
    weakNodes,
    orphanNodes,
    duplicateCandidates,
    graph,
    wm,
    stats,
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

    // Rotate audit log during consolidation
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

/**
 * Collect recent outgoing Moltbook activity from sub-agent run history.
 * Returns the details/summaries from runs in the last 48 hours so the
 * reflect prompt can detect public commitments.
 */
function getRecentMoltbookActivity(): string[] {
  const agents = loadSubAgents();
  const moltbookAgent = agents.find(a => a.name.toLowerCase().includes("moltbook") || a.id.includes("moltbook"));
  if (!moltbookAgent) return [];

  const history = loadSubAgentHistory(moltbookAgent.id);
  const cutoff = Date.now() - 48 * 60 * 60 * 1000; // last 48 hours

  const activity: string[] = [];
  for (const run of history) {
    if (run.completedAt < cutoff) break; // history is sorted newest-first
    if (!run.success) continue;
    // Include both summary and details — the details often contain post content
    const text = run.details || run.summary;
    if (text) activity.push(text);
  }

  return activity;
}

// ── Reflect Tick (Claude call) ──

async function reflectTick(
  state: BrainState,
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
  initiativeSignals: import("./initiative.js").InitiativeSignal[] = [],
): Promise<boolean> {
  const now = Date.now();
  const wm = loadWorkingMemory();
  populateTemporalContext(wm);
  const strongestNodes = selectContextForReflect(graph);
  const stats = graph.getStats();

  // Get goals section
  const goalTracker = new GoalTracker(graph);
  const goalsSection = goalTracker.serializeForPrompt();
  wm.activeGoals = goalTracker.getWorkingGoalRefs();

  const cfg = getBrainConfig();

  // Gather self-improvement stats for the reflect prompt
  const improveQueue = loadQueue();
  const selfImproveStats = {
    enabled: cfg.selfImproveEnabled,
    maxPerWeek: cfg.selfImproveMaxPerWeek,
    completedThisWeek: getWeeklyCompletedCount(),
    pendingInQueue: improveQueue.items.filter(i => i.status === "pending" || i.status === "approved").length,
    autoApprove: cfg.selfImproveAutoApprove,
  };

  // Gather recent Moltbook activity for commitment tracking
  const recentMoltbookActivity = getRecentMoltbookActivity();

  // Gather recent outgoing activity across all channels for general commitment detection
  const COMMITMENT_LOOKBACK = 12 * 60 * 60 * 1000; // 12 hours
  const recentOutgoing = getObservationsSince(Date.now() - COMMITMENT_LOOKBACK, { isFromMe: true }, 50);
  const recentOutgoingActivity = recentOutgoing
    .filter(o => o.text && o.text.length >= 10)
    .map(o => ({
      source: o.source || "whatsapp",
      audience: o.chatName || o.groupName || "unknown",
      text: o.text,
    }));

  // Run weekly drift audit (non-blocking — if not due, returns null instantly)
  let driftSummary: string | undefined;
  try {
    const driftReport = await runDriftAudit();
    if (driftReport) {
      driftSummary = `[DRIFT AUDIT] Direction: ${driftReport.directionSummary} | Surprise: ${driftReport.surpriseLevel} | ${driftReport.filesChanged.length} files changed | ${driftReport.recommendation}`;
      log(`Drift audit completed: surprise=${driftReport.surpriseLevel}`);
      // Notify owner if surprise level is medium or high
      if ((driftReport.surpriseLevel === "medium" || driftReport.surpriseLevel === "high") && ownerJid) {
        const alertMsg = `🔍 Weekly drift audit (surprise: ${driftReport.surpriseLevel})\n\n${driftReport.directionSummary}\n\n${driftReport.driftCharacterization}\n\nRecommendation: ${driftReport.recommendation}`;
        try { await sendMessage(ownerJid, alertMsg); } catch {}
      }
      pruneBaselines();
    } else {
      // Surface latest existing report if available
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

    // Apply goal operations
    if (response.goalOps && response.goalOps.length > 0) {
      goalTracker.applyGoalOps(response.goalOps as GoalOperation[]);
      wm.activeGoals = goalTracker.getWorkingGoalRefs();
    }

    // Enqueue self-improvement proposals
    if (response.improvementProposals?.length) {
      enqueueImprovementProposals(response.improvementProposals, "reflect", cfg);
    }

    if (response.workingMemory) {
      updateWorkingMemory(wm, response.workingMemory);
      saveWorkingMemory(wm);
    }

    if (response.message) {
      await trySendMessage(state, sendMessage, ownerJid, response.message);

      // Scan outgoing reflect message for commitments
      scanAndProcessCommitments(response.message, "brain", OWNER_NAME, goalTracker);
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

// ── Fast Scheduled Message Polling ──
// Lightweight poller that runs every 10s independently of brain ticks.
// Only checks getDueMessages() and delivers them — no full tick overhead.

let schedulerPollRunning = false;

async function pollScheduledMessages(
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
): Promise<void> {
  // Guard against overlapping polls
  if (schedulerPollRunning) return;
  schedulerPollRunning = true;
  try {
    const state = loadState();
    await deliverScheduledMessages(state, sendMessage, ownerJid);
  } finally {
    schedulerPollRunning = false;
  }
}

// ── Pending Scheduled Messages ──

async function deliverScheduledMessages(
  state: BrainState,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
): Promise<void> {
  // Check WhatsApp connection before attempting any deliveries.
  // If not connected (e.g. during startup race), messages stay in schedule for next tick.
  if (!isWhatsAppConnected()) {
    const dueCount = getScheduledMessages().filter(m => m.deliverAt <= Date.now()).length;
    if (dueCount > 0) {
      log(`Skipping ${dueCount} scheduled message(s): WhatsApp not connected (will retry next tick)`);
    }
    return;
  }

  // getDueMessages() returns due messages WITHOUT removing them from the file.
  // We only remove after successful delivery via markDelivered().
  const dueMessages = getDueMessages();
  const deliveredIds: string[] = [];
  const failedIds: string[] = [];

  // Build set of JIDs that have recent chat-sourced deliveries (for dedup)
  const DEDUP_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours — must cover scheduler max backoff (2h) + buffer
  const recentDeliveries = getRecentDeliveries(DEDUP_WINDOW_MS);
  const recentChatJids = new Set(
    recentDeliveries.filter(d => d.source === "chat").map(d => d.jid),
  );

  for (const msg of dueMessages) {
    try {
      const jid = msg.targetJid || ownerJid;

      // Action verifier gate (replaces ad-hoc whitelist check)
      const verifyResult = verify({
        type: "send_scheduled",
        source: msg.source,
        targetJid: jid,
        messageText: msg.message,
        metadata: { scheduleId: msg.id },
      });
      if (verifyResult.verdict === "blocked") {
        log(`Verifier blocked scheduled message ${msg.id}: ${verifyResult.reasons.join("; ")}`);
        deliveredIds.push(msg.id); // Remove blocked messages (they'll never succeed)
        continue;
      }

      // Dedup: skip brain-sourced messages to JIDs that already received a chat-sourced message recently
      if (msg.source === "brain" && recentChatJids.has(jid)) {
        log(`Dedup: skipping brain-sourced message ${msg.id} to ${jid} — chat-sourced message already delivered in last ${DEDUP_WINDOW_MS / 60000}m`);
        deliveredIds.push(msg.id); // Remove to avoid retrying
        continue;
      }
      const SEND_TIMEOUT_MS = 30_000;
      await Promise.race([
        sendMessage(jid, msg.message),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`sendMessage timed out after ${SEND_TIMEOUT_MS / 1000}s`)), SEND_TIMEOUT_MS),
        ),
      ]);
      state.lastMessageTime = Date.now();
      state.messagesToday++;
      deliveredIds.push(msg.id);
      logDelivery(jid, msg.source, msg.message);
      log(`Delivered scheduled message ${msg.id} to ${jid} (${msg.message.length} chars, source: ${msg.source})`);
    } catch (err) {
      log(`Failed to deliver scheduled message ${msg.id}: ${err}`);
      failedIds.push(msg.id);
    }
  }

  // Remove successfully delivered (and blocked) messages from schedule
  markDelivered(deliveredIds);

  // Increment retry count for failed messages; drops those exceeding max retries
  const droppedIds = markFailed(failedIds);
  for (const id of droppedIds) {
    log(`Permanently dropped scheduled message ${id} after max retries`);
  }

  // Legacy: also check single pending-message.json for backward compatibility
  const pendingPath = `${BRAIN_DIR}/pending-message.json`;
  if (!existsSync(pendingPath)) return;
  try {
    const raw = readFileSync(pendingPath, "utf-8");
    const pending = JSON.parse(raw) as { sendAt: number; message: string };
    if (Date.now() >= pending.sendAt) {
      const SEND_TIMEOUT_MS = 30_000;
      await Promise.race([
        sendMessage(ownerJid, pending.message),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`sendMessage timed out after ${SEND_TIMEOUT_MS / 1000}s`)), SEND_TIMEOUT_MS),
        ),
      ]);
      state.lastMessageTime = Date.now();
      state.messagesToday++;
      unlinkSync(pendingPath);
      log(`Sent legacy pending message (${pending.message.length} chars)`);
    }
  } catch (err) {
    log(`Error processing legacy pending message: ${err}`);
    try { unlinkSync(pendingPath); } catch (cleanupErr) { log(`Failed to clean up legacy pending message file: ${cleanupErr}`); }
  }

  if (dueMessages.length > 0) saveState(state);
}

// ── Message Sending with Limits ──

async function trySendMessage(
  state: BrainState,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
  message: string,
  options?: { bypassLimits?: boolean },
): Promise<void> {
  const cfg = getBrainConfig();
  const now = Date.now();
  const { hour: currentHour } = getOwnerLocalTime(cfg.ownerTimezone);
  const isQuiet = cfg.quietStart !== cfg.quietEnd && (currentHour >= cfg.quietStart || currentHour < cfg.quietEnd);
  const messageIntervalOk = (now - state.lastMessageTime) >= cfg.minMessageInterval;
  const underDailyLimit = state.messagesToday < cfg.maxMessagesPerDay;
  const bypass = options?.bypassLimits === true;

  // Action verifier gate
  const verifyResult = verify({
    type: "send_message",
    source: bypass ? "digest" : "think",
    targetJid: ownerJid,
    messageText: message,
  });
  if (verifyResult.verdict === "blocked") {
    log(`Verifier blocked proactive message: ${verifyResult.reasons.join("; ")}`);
    return;
  }

  if (!bypass && isQuiet) {
    log("Suppressed message: quiet hours");
  } else if (!bypass && !messageIntervalOk) {
    log(`Suppressed message: too soon (${Math.round((now - state.lastMessageTime) / 60000)}m since last)`);
  } else if (!bypass && !underDailyLimit) {
    log(`Suppressed message: daily limit reached (${state.messagesToday}/${cfg.maxMessagesPerDay})`);
  } else {
    try {
      if (bypass) log("Briefing message — bypassing rate limits");
      await sendMessage(ownerJid, message);
      state.lastMessageTime = now;
      state.messagesToday++;
      log(`Sent proactive message (${message.length} chars, #${state.messagesToday} today)`);
    } catch (err) {
      log(`Failed to send proactive message: ${err}`);
    }
  }
}
