import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { appendFileSync } from "fs";
import { spawn, execSync } from "child_process";
import { askClaudeStreaming } from "./claude.js";
import { getObservationsSince, pruneObservations, ensureBrainDir } from "./observer.js";
import type { Observation } from "./observer.js";
import { buildThinkPrompt, buildConsolidatePrompt, buildReflectPrompt } from "./brain-prompt.js";
import type { MessageQueue } from "./queue.js";
import { MemoryGraph } from "./memory/graph.js";
import type { MemoryOperation, BrainResponse, BrainState, GoalOperation } from "./memory/types.js";
import { getDueMessages, markDelivered, markFailed } from "./scheduler.js";
import { isWhatsAppConnected } from "./integrations/whatsapp.js";
import { isWhitelisted } from "./contact-whitelist.js";
import { MAX_NODES_SOFT } from "./memory/types.js";
import { runConsolidation } from "./memory/decay.js";
import { loadWorkingMemory, saveWorkingMemory, updateWorkingMemory, populateTemporalContext, updateConversationThreads } from "./memory/working-memory.js";
import {
  selectContextForThink,
  selectContextForConsolidate,
  selectContextForReflect,
} from "./memory/activation.js";
import { scoreObservations, getPendingUrgency, clearPendingUrgency } from "./urgency.js";
import { GoalTracker } from "./goals.js";
import { getDueRecurringTasks, markExecuted } from "./recurring.js";
import type { RecurringTask } from "./recurring.js";
import { detectInitiativeSignals, canTriggerInitiativeThink, recordInitiativeThink } from "./initiative.js";
import { ensureSSHKey } from "./integrations/ssh.js";
import { getBrainConfig, getActivePreset, getOwnerLocalTime } from "./brain-config.js";
import {
  loadQueue,
  enqueue,
  enqueueApproved,
  approveItem,
  dequeueApproved,
  completeItem,
  failItem,
  getWeeklyCompletedCount,
} from "./self-improve-queue.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [brain] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

// Config from env (non-responsiveness constants)
const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const OWNER_NAME = process.env.OWNER_NAME || "Owner";
const GITHUB_REPO = process.env.GITHUB_REPO || "";

// Tool access for brain ticks (empty string = no tools, comma-separated list = those tools)
const BRAIN_TOOLS = process.env.BRAIN_TOOLS ?? "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch";
const TIME_AWARENESS_INTERVAL = 30 * 60 * 1000; // 30 min — think even without observations

// Urgency bypass
const URGENCY_BYPASS_THRESHOLD = 0.6;
const URGENCY_MIN_COOLDOWN = 60000; // 1 min minimum even for urgent

// Recurring task budget
const MAX_RECURRING_THINKS_PER_DAY = 5;
let recurringThinksToday = 0;
let recurringBudgetDate = "";

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
    consecutiveFailures: 0,
    lastSuccessfulTick: 0,
    pendingSelfMod: false,
  };
}

function loadState(): BrainState {
  try {
    if (existsSync(STATE_FILE)) {
      return { ...defaultState(), ...JSON.parse(readFileSync(STATE_FILE, "utf-8")) };
    }
  } catch {
    log("Failed to read state, using defaults");
  }
  return defaultState();
}

function saveState(state: BrainState): void {
  try {
    if (!existsSync(BRAIN_DIR)) {
      mkdirSync(BRAIN_DIR, { recursive: true });
    }
    const tmp = STATE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    log(`Failed to save state: ${err}`);
  }
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
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
  } catch {
    log(`Failed to parse brain response: ${raw.slice(0, 200)}`);
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
  } catch {}
}

function saveLastGoodCommit(): void {
  try {
    const hash = execSync("git -C /app rev-parse HEAD", { timeout: 5000, stdio: "pipe" }).toString().trim();
    if (hash) {
      writeFileSync(LAST_GOOD_COMMIT_FILE, hash);
      log(`Saved last good commit: ${hash}`);
    }
  } catch {}
}

function checkSelfMod(): string | null {
  try {
    const status = execSync("git -C /app status --porcelain backend/", { timeout: 5000, stdio: "pipe" }).toString().trim();
    if (status) return status;
  } catch {}
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
    } catch {}

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
    try { if (existsSync(QUEUED_MARKER_FILE)) unlinkSync(QUEUED_MARKER_FILE); } catch {}

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
          try { approveItem(item.id); } catch {}
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

function writeSelfModMarker(changes: string): void {
  try {
    writeFileSync(SELF_MOD_MARKER_FILE, JSON.stringify({
      detectedAt: Date.now(),
      changes,
    }));
  } catch {}
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
let lastPruneDate = "";
let firstSuccessfulTickDone = false;
const graph = new MemoryGraph();

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
    log("Brain loop stopped");
  }
}

// ── Tick Scheduler ──

async function tick(
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
): Promise<void> {
  const cfg = getBrainConfig();
  const state = loadState();
  const now = Date.now();
  const today = todayStr();

  // ── Pick up self-improve results from worker ──
  pickUpImproveResult(state);

  // ── Intercept task files written by reflect tick → route through queue ──
  interceptDirectTask();

  // ── Check for pending self-improve task file (may be created during any tick type) ──
  checkAndSpawnImproveWorker(state);

  // ── Deliver due scheduled messages ──
  await deliverScheduledMessages(state, sendMessage, ownerJid);

  // Reset daily counter
  if (state.messagesTodayDate !== today) {
    state.messagesToday = 0;
    state.messagesTodayDate = today;
  }

  // Reset recurring task budget
  if (recurringBudgetDate !== today) {
    recurringBudgetDate = today;
    recurringThinksToday = 0;
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
    && canTriggerInitiativeThink();

  // Defer to owner messages — skip if queue is busy
  if (!queue.idle) {
    // Still save state from observe tick
    saveState(state);
    return;
  }

  let tickSucceeded = false;

  if (timeSinceReflect >= cfg.reflectInterval && graph.nodeCount > 0) {
    tickSucceeded = await reflectTick(state, queue, sendMessage, ownerJid, signals);
  } else if (timeSinceConsolidate >= cfg.consolidateInterval && graph.nodeCount > 0) {
    tickSucceeded = await consolidateTick(state, queue);
  } else if (
    (hasNewObs && timeSinceThink >= cfg.thinkCooldown) ||
    (hasNewObs && urgentBypass) ||
    timeSinceThink >= TIME_AWARENESS_INTERVAL ||
    initiativeTriggered
  ) {
    if (initiativeTriggered && !hasNewObs) {
      recordInitiativeThink();
      log(`Initiative-triggered think (${highPrioritySignals.length} high-priority signals)`);
    }
    tickSucceeded = await thinkTick(state, newObs, queue, sendMessage, ownerJid, signals);
  } else {
    // Nothing to do this tick
    saveState(state);
    return;
  }

  // Clear urgency after processing
  clearPendingUrgency();

  // ── Track success/failure for health ──
  if (!tickSucceeded) {
    state.consecutiveFailures++;
    log(`Tick failed (${state.consecutiveFailures} consecutive failures)`);
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
  for (const obs of observations) {
    if (!obs.sender) continue;
    const senderLower = obs.sender.toLowerCase();
    const personNodes = graph.findByType("person");
    for (const node of personNodes) {
      if (node.content.toLowerCase().includes(senderLower) ||
          node.tags.some(t => t.toLowerCase() === senderLower)) {
        graph.accessNode(node.id);
      }
    }
  }

  // Update conversation threads in working memory
  const wm = loadWorkingMemory();
  updateConversationThreads(wm, observations);
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
          if (isWhitelisted(action.targetJid)) {
            await sendMessage(action.targetJid, action.template);
            state.lastMessageTime = Date.now();
            state.messagesToday++;
            log(`[recurring] Sent message for task "${task.label}" to ${action.targetJid}`);
          } else {
            log(`[recurring] Blocked message for "${task.label}": target not whitelisted`);
          }
          markExecuted(task.id);
          break;
        }

        case "think_trigger": {
          if (recurringThinksToday >= MAX_RECURRING_THINKS_PER_DAY) {
            log(`[recurring] Skipping think_trigger "${task.label}": daily budget exhausted (${recurringThinksToday}/${MAX_RECURRING_THINKS_PER_DAY})`);
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
          recurringThinksToday++;
          markExecuted(task.id);
          log(`[recurring] Injected think trigger for "${task.label}" (${recurringThinksToday}/${MAX_RECURRING_THINKS_PER_DAY} today)`);
          break;
        }

        case "digest": {
          if (recurringThinksToday >= MAX_RECURRING_THINKS_PER_DAY) {
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
          recurringThinksToday++;
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
  const contextNodes = selectContextForThink(graph, wm, allObs, signalNodeIds);

  // Get goals section
  const goalTracker = new GoalTracker(graph);
  const goalsSection = goalTracker.serializeForPrompt();
  wm.activeGoals = goalTracker.getWorkingGoalRefs();

  log(`Think: ${allObs.length} observations, ${contextNodes.length} context nodes, ${initiativeSignals.length} initiative signals`);

  const cfg = getBrainConfig();

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
      log("Could not parse think response, skipping");
      state.lastThinkTick = now;
      graph.clearPendingObservations();
      return false;
    }

    log(`Think reasoning: ${response.reasoning?.slice(0, 200) || "(none)"}`);

    // Apply memory operations
    if (response.operations.length > 0) {
      const { applied, skipped } = graph.applyOperations(response.operations as MemoryOperation[]);
      log(`Think ops: ${applied} applied, ${skipped} skipped`);
    }

    // Apply goal operations
    if (response.goalOps && response.goalOps.length > 0) {
      goalTracker.applyGoalOps(response.goalOps as GoalOperation[]);
      wm.activeGoals = goalTracker.getWorkingGoalRefs();
    }

    // Update working memory
    if (response.workingMemory) {
      updateWorkingMemory(wm, response.workingMemory);
      // Track activated context nodes
      wm.activatedNodeIds = contextNodes.slice(0, 10).map(n => n.id);
      saveWorkingMemory(wm);
    }

    // Handle message — briefings (digest-triggered thinks) bypass rate limits
    if (response.message) {
      const isDigestTriggered = allObs.some(o => o.text.startsWith("[DIGEST REQUEST:"));
      await trySendMessage(state, sendMessage, ownerJid, response.message, {
        bypassLimits: isDigestTriggered,
      });
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
    log(`Think failed: ${err}`);
    state.lastThinkTick = now;
    state.lastObservationTime = now;
    graph.clearPendingObservations();
    return false;
  }
}

// ── Consolidate Tick (Claude call) ──

async function consolidateTick(
  state: BrainState,
  queue: MessageQueue,
): Promise<boolean> {
  const now = Date.now();

  // Run automatic decay first (free)
  const decayResult = runConsolidation(graph);
  log(`Consolidate decay: ${decayResult.nodesDecayed} nodes decayed, ${decayResult.nodesPruned} pruned, ${decayResult.edgesDecayed} edges decayed, ${decayResult.edgesPruned} pruned, ${decayResult.orphansPruned} orphans`);

  // Prepare context for Claude consolidation
  const wm = loadWorkingMemory();
  populateTemporalContext(wm);
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
      const { applied, skipped } = graph.applyOperations(response.operations as MemoryOperation[]);
      log(`Consolidate ops: ${applied} applied, ${skipped} skipped`);
    }

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
    log(`Consolidate failed: ${err}`);
    state.lastConsolidateTick = now;
    return false;
  }
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

  log(`Reflect: ${strongestNodes.length} context nodes, ${stats.nodeCount} total nodes, ${initiativeSignals.length} initiative signals`);

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
      const { applied, skipped } = graph.applyOperations(response.operations as MemoryOperation[]);
      log(`Reflect ops: ${applied} applied, ${skipped} skipped`);
    }

    // Apply goal operations
    if (response.goalOps && response.goalOps.length > 0) {
      goalTracker.applyGoalOps(response.goalOps as GoalOperation[]);
      wm.activeGoals = goalTracker.getWorkingGoalRefs();
    }

    // Enqueue self-improvement proposals
    if (response.improvementProposals && response.improvementProposals.length > 0 && cfg.selfImproveEnabled) {
      const weeklyRemaining = cfg.selfImproveMaxPerWeek - getWeeklyCompletedCount();
      const currentPending = loadQueue().items.filter(i => i.status === "pending" || i.status === "approved" || i.status === "running").length;
      const canEnqueue = Math.max(0, weeklyRemaining - currentPending);

      for (const proposal of response.improvementProposals.slice(0, canEnqueue)) {
        if (!proposal.description || !proposal.rationale) {
          log(`Skipping invalid improvement proposal: missing description or rationale`);
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
        // Brain-originated proposals are pre-approved — they've already been
        // through the brain's deliberation. No need for selfImproveAutoApprove.
        enqueueApproved(task);
        log(`Enqueued improvement proposal (pre-approved): ${proposal.description.slice(0, 80)}`);
      }

      if (response.improvementProposals.length > canEnqueue) {
        log(`Dropped ${response.improvementProposals.length - canEnqueue} proposals (weekly budget/queue limit)`);
      }
    }

    if (response.workingMemory) {
      updateWorkingMemory(wm, response.workingMemory);
      saveWorkingMemory(wm);
    }

    if (response.message) {
      await trySendMessage(state, sendMessage, ownerJid, response.message);
    }

    state.lastReflectTick = now;
    if (result.stats) {
      state.totalCost += result.stats.totalCostUsd || 0;
    }

    log(`Reflect complete (${graph.nodeCount} nodes, ${graph.edgeCount} edges)`);
    return true;
  } catch (err) {
    log(`Reflect failed: ${err}`);
    state.lastReflectTick = now;
    return false;
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
    const dueCount = getDueMessages().length;
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

  for (const msg of dueMessages) {
    try {
      const jid = msg.targetJid || ownerJid;
      if (!isWhitelisted(jid)) {
        log(`Blocked scheduled message ${msg.id}: target ${jid} not on whitelist`);
        deliveredIds.push(msg.id); // Remove blocked messages (they'll never succeed)
        continue;
      }
      await sendMessage(jid, msg.message);
      state.lastMessageTime = Date.now();
      state.messagesToday++;
      deliveredIds.push(msg.id);
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
      await sendMessage(ownerJid, pending.message);
      state.lastMessageTime = Date.now();
      state.messagesToday++;
      unlinkSync(pendingPath);
      log(`Sent legacy pending message (${pending.message.length} chars)`);
    }
  } catch (err) {
    log(`Error processing legacy pending message: ${err}`);
    try { unlinkSync(pendingPath); } catch {}
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
