/**
 * Brain orchestrator — main loop, tick scheduling, observation handling, recurring tasks.
 *
 * Claude-calling tick implementations are in brain-ticks.ts.
 * Scheduled message delivery is in brain-delivery.ts.
 * Self-improve + sub-agent worker management is in brain-workers.ts.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import { getObservationsSince, pruneObservations, ensureBrainDir } from "./observer.js";
import type { Observation } from "./observer.js";
import type { MessageQueue } from "./queue.js";
import { MemoryGraph } from "./memory/graph.js";
import type { BrainState } from "./memory/types.js";
import { loadWorkingMemory, saveWorkingMemory, populateTemporalContext, updateConversationThreads, scanFollowUpsForResolution } from "./memory/working-memory.js";
import { scoreObservations, getPendingUrgency, clearPendingUrgency, setUrgencyInterruptHandler } from "./urgency.js";
import { getDueRecurringTasks, markExecuted } from "./recurring.js";
import { detectInitiativeSignals, canTriggerInitiativeThink, recordInitiativeThink } from "./initiative.js";
import { withTimeout } from "./utils/async.js";
import { ensureSSHKey } from "./integrations/ssh.js";
import { verify } from "./action-verifier.js";
import { BrainError, wrapError } from "./brain-errors.js";
import { getBrainConfig, getOwnerLocalDate, getOwnerLocalTime } from "./brain-config.js";

import { BRAIN_DIR, OWNER_NAME, GITHUB_REPO } from "./config.js";

// ── Extracted modules ──
import { thinkTick, consolidateTick, reflectTick } from "./brain-ticks.js";
import { pollScheduledMessages } from "./brain-delivery.js";
import {
  pickUpImproveResult,
  interceptDirectTask,
  checkAndSpawnImproveWorker,
  pickUpSubAgentResults,
  checkAndSpawnSubAgentWorkers,
} from "./brain-workers.js";

const log = createLogger("brain");

// ── Config from env ──

const TIME_AWARENESS_INTERVAL = 30 * 60 * 1000; // 30 min
const TICK_TIMEOUT = Number(process.env.BRAIN_TICK_TIMEOUT) || 120_000;
const CB_MAX_FAILURES = Number(process.env.BRAIN_CB_MAX_FAILURES) || 3;
const CB_MAX_BACKOFF = Number(process.env.BRAIN_CB_MAX_BACKOFF) || 30 * 60 * 1000;
const URGENCY_BYPASS_THRESHOLD = 0.6;
const URGENCY_MIN_COOLDOWN = 60000;
const MAX_RECURRING_THINKS_PER_DAY = 5;

// ── File paths ──
const STATE_FILE = `${BRAIN_DIR}/state.json`;
const NOTEBOOK_FILE = `${BRAIN_DIR}/notebook.md`;
const IMPROVE_TASK_FILE = `${BRAIN_DIR}/improve-task.json`;
const IMPROVE_RESULT_FILE = `${BRAIN_DIR}/improve-result.json`;
const SELF_MOD_MARKER_FILE = `${BRAIN_DIR}/self-mod-marker.json`;
const BOOT_COUNTER_FILE = `${BRAIN_DIR}/boot-counter`;
const LAST_GOOD_COMMIT_FILE = `${BRAIN_DIR}/last-good-commit`;
const QUEUED_MARKER_FILE = `${BRAIN_DIR}/improve-task.queued`;

const SCHEDULER_POLL_INTERVAL = 10_000;

// ── State Management ──

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

// ── Health & Boot Helpers ──

export function getBrainHealth(): {
  healthy: boolean;
  consecutiveFailures: number;
  pendingSelfMod: boolean;
  lastSuccessfulTick: number;
  nodeCount: number;
  edgeCount: number;
} {
  const state = loadState();
  return {
    healthy: state.consecutiveFailures < 5,
    consecutiveFailures: state.consecutiveFailures,
    pendingSelfMod: state.pendingSelfMod,
    lastSuccessfulTick: state.lastSuccessfulTick,
    nodeCount: state.nodeCount,
    edgeCount: state.edgeCount,
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

// ── Migration ──

function migrateNotebook(graph: MemoryGraph): void {
  if (graph.nodeCount > 0) return;
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

// ── Identity Bootstrap ──

function bootstrapIdentity(g: MemoryGraph): void {
  const pinnedNodes = g.allNodes().filter(n => n.pinned);
  if (pinnedNodes.length > 0) return;
  if (g.nodeCount > 0) return;

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
const URGENCY_INTERRUPT_COOLDOWN = 60_000;

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

  graph.load();
  migrateNotebook(graph);
  bootstrapIdentity(graph);

  log(`Brain loop starting (tick every ${cfg.tickInterval / 1000}s, think cooldown ${cfg.thinkCooldown / 1000}s, consolidate every ${cfg.consolidateInterval / 3600000}h, reflect every ${cfg.reflectInterval / 3600000}h)`);

  brainInterval = setInterval(() => {
    tick(queue, sendMessage, ownerJid).catch((err) => {
      log(`Tick error: ${err}`);
    });
  }, cfg.tickInterval);

  schedulerPollInterval = setInterval(() => {
    pollScheduledMessages(sendMessage, ownerJid, loadState, saveState, BRAIN_DIR).catch((err) => {
      log(`Scheduler poll error: ${err}`);
    });
  }, SCHEDULER_POLL_INTERVAL);

  setTimeout(() => {
    tick(queue, sendMessage, ownerJid).catch((err) => {
      log(`Initial tick error: ${err}`);
    });
  }, 10000);
}

export function stopBrainLoop(): void {
  try {
    graph.save();
    log("Graph saved on shutdown");
  } catch (err) {
    log(`Failed to save graph on shutdown: ${err}`);
  }

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

// ── Tick Concurrency Guards ──
let tickLock = false;
let thinkRunning = false;
let consolidateRunning = false;
let reflectRunning = false;

// ── Tick Scheduler ──

async function tick(
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
): Promise<void> {
  if (tickLock) {
    log("Skipping tick — previous tick still running");
    return;
  }
  tickLock = true;
  try {
  const cfg = getBrainConfig();
  const state = loadState();
  const now = Date.now();
  const today = getOwnerLocalDate(cfg.ownerTimezone);

  // ── Pick up self-improve results from worker ──
  pickUpImproveResult(state, graph, saveState, IMPROVE_RESULT_FILE, IMPROVE_TASK_FILE, QUEUED_MARKER_FILE);

  // ── Intercept task files → route through queue ──
  interceptDirectTask(IMPROVE_TASK_FILE, QUEUED_MARKER_FILE);

  // ── Check for pending self-improve task ──
  checkAndSpawnImproveWorker(state, saveState, IMPROVE_TASK_FILE, IMPROVE_RESULT_FILE, QUEUED_MARKER_FILE);

  // ── Sub-agent management ──
  pickUpSubAgentResults();
  checkAndSpawnSubAgentWorkers();

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

  const newObs = getObservationsSince(state.lastObservationTime);

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

  // ── Circuit breaker ──
  if (state.consecutiveFailures >= CB_MAX_FAILURES) {
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

  const urgency = getPendingUrgency();
  const urgentBypass = urgency >= URGENCY_BYPASS_THRESHOLD && timeSinceThink >= URGENCY_MIN_COOLDOWN;
  if (urgentBypass) {
    log(`Urgency bypass: score ${urgency.toFixed(2)} >= ${URGENCY_BYPASS_THRESHOLD}, bypassing ${cfg.thinkCooldown / 1000}s cooldown`);
  }

  const initiativeTriggered = highPrioritySignals.length > 0
    && !hasNewObs
    && timeSinceThink >= cfg.thinkCooldown
    && canTriggerInitiativeThink(state);

  // Defer to owner messages
  if (!queue.idle) {
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
            reflectTick(state, queue, sendMessage, ownerJid, graph, signals),
            Math.max(TICK_TIMEOUT, 600_000),
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
            consolidateTick(state, queue, graph),
            TICK_TIMEOUT,
            "consolidateTick",
          );
        } finally {
          consolidateRunning = false;
        }

        // After consolidation, check if new observations arrived during it.
        // Without this, ARIA goes blind for up to a full tick interval after a long consolidate.
        if (tickSucceeded && !thinkRunning) {
          const postConsolidateObs = getObservationsSince(state.lastObservationTime);
          if (postConsolidateObs.length > 0) {
            log(`Post-consolidate: ${postConsolidateObs.length} new observations arrived, chaining think tick`);
            scoreObservations(postConsolidateObs);
            observeTick(state, postConsolidateObs);
            thinkRunning = true;
            try {
              const thinkOk = await withTimeout(
                thinkTick(state, postConsolidateObs, queue, sendMessage, ownerJid, graph, signals),
                TICK_TIMEOUT,
                "thinkTick (post-consolidate)",
              );
              if (thinkOk) tickSucceeded = true;
            } catch (err) {
              log(`Post-consolidate think failed: ${err}`);
            } finally {
              thinkRunning = false;
            }
          }
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
        const isInitiativeThink = initiativeTriggered && !hasNewObs;
        if (isInitiativeThink) {
          log(`Initiative-triggered think (${highPrioritySignals.length} high-priority signals)`);
        }
        thinkRunning = true;
        try {
          tickSucceeded = await withTimeout(
            thinkTick(state, newObs, queue, sendMessage, ownerJid, graph, signals),
            TICK_TIMEOUT,
            "thinkTick",
          );
          // Only consume initiative budget after successful execution.
          // Previously, budget was consumed before the tick ran, so if the
          // queue wasn't idle or the tick failed, budget was wasted.
          if (isInitiativeThink && tickSucceeded) {
            recordInitiativeThink(state);
          }
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
    saveState(state);
    return;
  }

  // ── Track success/failure for health ──
  if (!tickSucceeded) {
    state.consecutiveFailures++;
    const errInfo = lastTickError
      ? ` [${lastTickError.context.phase}, transient=${lastTickError.context.transient}]`
      : "";
    log(`Tick failed${errInfo} (${state.consecutiveFailures} consecutive failures)`);
  } else {
    clearPendingUrgency();
    state.consecutiveFailures = 0;
    state.lastSuccessfulTick = now;

    if (!firstSuccessfulTickDone) {
      firstSuccessfulTickDone = true;
      resetBootCounter();
      saveLastGoodCommit();
      log("First successful tick — boot counter reset, last good commit saved");
    }

    const selfModChanges = checkSelfMod();
    if (selfModChanges) {
      log(`Self-modification detected:\n${selfModChanges}`);
      writeSelfModMarker(selfModChanges);
      const id = `n_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

  // ── Selective state save ──
  const freshState = loadState();

  freshState.lastThinkTick = state.lastThinkTick;
  freshState.lastConsolidateTick = state.lastConsolidateTick;
  freshState.lastReflectTick = state.lastReflectTick;
  freshState.lastObservationTime = state.lastObservationTime;
  freshState.consecutiveFailures = state.consecutiveFailures;
  freshState.lastSuccessfulTick = state.lastSuccessfulTick;
  freshState.messagesTodayDate = state.messagesTodayDate;
  freshState.recurringBudgetDate = state.recurringBudgetDate;

  freshState.nodeCount = graph.nodeCount;
  freshState.edgeCount = graph.edgeCount;

  freshState.totalThinks = Math.max(freshState.totalThinks, state.totalThinks);
  freshState.totalCost = Math.max(freshState.totalCost, state.totalCost);
  freshState.recurringThinksToday = Math.max(freshState.recurringThinksToday, state.recurringThinksToday);
  freshState.initiativeThinksToday = Math.max(freshState.initiativeThinksToday, state.initiativeThinksToday);

  if (state.messagesToday > freshState.messagesToday) {
    freshState.messagesToday = state.messagesToday;
  }
  if (state.lastMessageTime > freshState.lastMessageTime) {
    freshState.lastMessageTime = state.lastMessageTime;
  }

  saveState(freshState);
  graph.save();
  } finally {
    tickLock = false;
  }
}

// ── Observe Tick (free, no Claude call) ──

function observeTick(state: BrainState, observations: Observation[]): void {
  for (const obs of observations) {
    graph.addPendingObservation(obs);
  }

  // Build name→nodeId index for O(1) sender lookup instead of O(persons×observations)
  const personNodes = graph.findByType("person");
  const nameIndex = new Map<string, string[]>();
  for (const node of personNodes) {
    // Index by content words and tags
    const words = node.content.toLowerCase().split(/\s+/);
    for (const w of words) {
      if (w.length < 2) continue;
      const ids = nameIndex.get(w) ?? [];
      ids.push(node.id);
      nameIndex.set(w, ids);
    }
    for (const tag of node.tags) {
      const t = tag.toLowerCase();
      const ids = nameIndex.get(t) ?? [];
      ids.push(node.id);
      nameIndex.set(t, ids);
    }
  }

  const accessedIds = new Set<string>();
  for (const obs of observations) {
    if (!obs.sender) continue;
    const senderLower = obs.sender.toLowerCase();
    const matchedIds = nameIndex.get(senderLower);
    if (matchedIds) {
      for (const id of matchedIds) {
        if (!accessedIds.has(id)) {
          graph.accessNode(id);
          accessedIds.add(id);
        }
      }
    }
  }

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
  _currentObs: Observation[],
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
            // Mark as executed even when blocked to prevent retry loop every tick
            markExecuted(task.id);
          } else {
            await sendMessage(action.targetJid, action.template);
            state.lastMessageTime = Date.now();
            state.messagesToday++;
            markExecuted(task.id);
            log(`[recurring] Sent message for task "${task.label}" to ${action.targetJid}`);
          }
          break;
        }

        case "think_trigger": {
          if (state.recurringThinksToday >= MAX_RECURRING_THINKS_PER_DAY) {
            log(`[recurring] Skipping think_trigger "${task.label}": daily budget exhausted (${state.recurringThinksToday}/${MAX_RECURRING_THINKS_PER_DAY})`);
            break;
          }
          const action = task.action as { type: "think_trigger"; topic: string; context?: string };
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
          const { hour } = getOwnerLocalTime(getBrainConfig().ownerTimezone);
          const isEvening = hour >= 17;
          const digestPrompt = isEvening
            ? `[DIGEST REQUEST: ${task.label}] Create a brief evening briefing for the owner. Summarize the day's key events: notable conversations, important messages, things that happened, any open items or pending decisions, and anything worth reflecting on. Keep it concise and personal.`
            : `[DIGEST REQUEST: ${task.label}] Create a brief morning briefing for the owner. Cover: what happened overnight, important messages received, pending items from yesterday, anything coming up today, and any initiative signals. Keep it concise and personal.`;
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
      log(`[recurring] Error handling task "${task.label}": ${err} — will retry on next matching tick`);
    }
  }
}
