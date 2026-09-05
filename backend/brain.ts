/**
 * Brain orchestrator — main loop, tick scheduling, observation handling, recurring tasks.
 *
 * Claude-calling tick implementations are in brain-ticks.ts / brain-think.ts.
 * Scheduled message delivery is in brain-delivery.ts.
 * Self-improve + sub-agent worker management is in brain-workers.ts.
 * Recurring tasks (messages, think/digest triggers) are in brain-recurring.ts.
 * State persistence (patchState) is in brain-state.ts; pure scheduling
 * policy in brain-policy.ts; the observation queue in brain-observations.ts.
 *
 * State discipline: after the legacy worker section at the top of a tick,
 * every state change is a patchState call at the moment of change. The tick
 * never saves a snapshot it loaded earlier — LLM ticks may outlive their
 * budget and land results later, and the scheduler poller writes concurrently.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { createLogger } from "./logger.js";
import { getObservationsSince, pruneObservations, ensureBrainDir } from "./observer.js";
import type { Observation } from "./observer.js";
import type { MessageQueue } from "./queue.js";
import { MemoryGraph } from "./memory/graph.js";
import { drainGraphInbox, consumeReloadRequest } from "./memory/graph-inbox.js";
import { flushEmbeddings } from "./memory/embeddings.js";
import type { BrainState, TickFailureSummary } from "./memory/types.js";
import { loadWorkingMemory, saveWorkingMemory, populateTemporalContext, updateConversationThreads, scanFollowUpsForResolution } from "./memory/working-memory.js";
import { scoreObservations, getPendingUrgency, clearPendingUrgency, setUrgencyInterruptHandler } from "./urgency.js";
import { detectInitiativeSignals, canTriggerInitiativeThink } from "./initiative.js";
import type { InitiativeSignal } from "./initiative.js";
import { recordObserveHeartbeat } from "./downtime-tracker.js";
import { withTimeout, TimeoutError } from "./utils/async.js";
import { ensureSSHKey } from "./integrations/ssh.js";
import { BrainError, wrapError } from "./brain-errors.js";
import { getBrainConfig, getOwnerLocalDate, getOwnerLocalTime } from "./brain-config.js";
import type { BrainConfig } from "./brain-config.js";

import { BRAIN_DIR, OWNER_NAME, GITHUB_REPO } from "./config.js";
import { createBackup, shouldRunBackup } from "./memory/backup.js";
import { shouldRunNewsDigest, runNewsDigest } from "./news-digest.js";
import { shouldRunPlayStoreDigest, runPlayStoreDigest } from "./playstore-digest.js";
import { shouldRunReplay, replayAndCompare } from "./memory/retrieval-replay.js";
import { loadConsciousness } from "./consciousness.js";

// ── Extracted modules ──
import { thinkTick, consolidateTick, reflectTick } from "./brain-ticks.js";
import { pollScheduledMessages } from "./brain-delivery.js";
import { getRecentDeliveries } from "./scheduler.js";
import {
  pickUpImproveResult,
  interceptDirectTask,
  checkAndSpawnImproveWorker,
  pickUpSubAgentResults,
  checkAndSpawnSubAgentWorkers,
} from "./brain-workers.js";
import { loadQueue, getWeeklyCompletedCount, getDailyCompletedCount, getConsecutiveFailuresToday } from "./self-improve-queue.js";
import { getForcedReflectsToday, recordForcedReflect } from "./self-improve-state.js";
import { startWatchdog, stopWatchdog } from "./brain-watchdog.js";
import { loadState, saveState, patchState } from "./brain-state.js";
import { decideTickKind, computeBackoffMs, tickTimeoutFor } from "./brain-policy.js";
import type { LlmTickKind, TickDecision } from "./brain-policy.js";
import { isSyntheticTrigger, selectUnobserved } from "./brain-observations.js";
import { handleRecurringTasks } from "./brain-recurring.js";
import { cloneSignalState } from "./brain-tick-shared.js";

const log = createLogger("brain");

// ── Config from env ──

const TIME_AWARENESS_INTERVAL = 4 * 60 * 60 * 1000; // 4h — idle think ticks when no observations
const TICK_TIMEOUT_ENV = Number(process.env.BRAIN_TICK_TIMEOUT) || 0; // can only raise the per-kind floor
const CB_MAX_FAILURES = Number(process.env.BRAIN_CB_MAX_FAILURES) || 3;
const CB_MAX_BACKOFF = Number(process.env.BRAIN_CB_MAX_BACKOFF) || 30 * 60 * 1000;
const URGENCY_BYPASS_THRESHOLD = 0.6;
const URGENCY_MIN_COOLDOWN = 5 * 60 * 1000; // minimum spacing between urgency-bypass thinks

// ── File paths ──
const NOTEBOOK_FILE = `${BRAIN_DIR}/notebook.md`;
const IMPROVE_TASK_FILE = `${BRAIN_DIR}/improve-task.json`;
const IMPROVE_RESULT_FILE = `${BRAIN_DIR}/improve-result.json`;
const SELF_MOD_MARKER_FILE = `${BRAIN_DIR}/self-mod-marker.json`;
const BOOT_COUNTER_FILE = `${BRAIN_DIR}/boot-counter`;
const LAST_GOOD_COMMIT_FILE = `${BRAIN_DIR}/last-good-commit`;
const QUEUED_MARKER_FILE = `${BRAIN_DIR}/improve-task.queued`;

const SCHEDULER_POLL_INTERVAL = 10_000;

type SendFn = (jid: string, text: string, source?: string) => Promise<void>;

// ── Delivery Feedback Verification ──

/**
 * Cross-check the last brain-returned message against delivery-log.json.
 * A message recorded as "sent" must appear in the delivery log; if it hasn't
 * after one full tick interval, downgrade it to "failed" and log an explicit
 * failure. This closes the loop that let the brain build false memories of
 * contact (message returned by a think tick but never actually delivered).
 */
function verifyLastBrainMessageDelivery(state: BrainState, tickInterval: number): BrainState {
  const lbm = state.lastBrainMessage;
  if (!lbm || lbm.verified || lbm.status !== "sent") return state;
  try {
    const found = getRecentDeliveries().some(
      d => d.jid === lbm.targetJid && d.messageSnippet === lbm.snippet && d.timestamp >= lbm.at - 60_000,
    );
    if (found) {
      return patchState({ lastBrainMessage: { ...lbm, verified: true } });
    }
    if (Date.now() - lbm.at >= tickInterval) {
      log(`⚠ DELIVERY FAILURE: brain message to ${lbm.targetJid} ("${lbm.snippet.slice(0, 60)}") reported sent at ${new Date(lbm.at).toISOString()} but never appeared in delivery-log.json within one tick — treating as NOT delivered`);
      return patchState({
        lastBrainMessage: {
          ...lbm,
          status: "failed",
          detail: "reported as sent but never appeared in delivery-log.json within one tick",
          verified: true,
        },
      });
    }
  } catch (err) {
    log(`Delivery verification error (non-fatal): ${err}`);
  }
  return state;
}

// ── Health & Boot Helpers ──

export function getBrainHealth(): {
  healthy: boolean;
  consecutiveFailures: number;
  pendingSelfMod: boolean;
  lastSuccessfulTick: number;
  lastTickFailure: TickFailureSummary | null;
  nodeCount: number;
  edgeCount: number;
} {
  const state = loadState();
  return {
    healthy: state.consecutiveFailures < 5,
    consecutiveFailures: state.consecutiveFailures,
    pendingSelfMod: state.pendingSelfMod,
    lastSuccessfulTick: state.lastSuccessfulTick,
    lastTickFailure: state.lastTickFailure ?? null,
    nodeCount: state.nodeCount,
    edgeCount: state.edgeCount,
  };
}

/**
 * Reset consecutive failures and circuit breaker.
 * Called via API when the operator manually clears the unhealthy state.
 */
export function resetConsecutiveFailures(): void {
  patchState({ consecutiveFailures: 0 });
  log("Consecutive failures reset by operator");
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
let initialTickTimer: ReturnType<typeof setTimeout> | null = null;
// True between startBrainLoop() and stopBrainLoop(). A passive deploy
// instance never starts the loop, so its stop must NOT save the (unloaded,
// empty) graph over the active instance's data on the shared volume.
let brainLoopActive = false;
let lastPruneDate = "";
let firstSuccessfulTickDone = false;
const graph = new MemoryGraph();

// ── Urgency Interrupt State ──
let lastUrgencyInterruptTime = 0;
const URGENCY_INTERRUPT_COOLDOWN = 60_000;
/** An interrupt arrived while a tick held the lock; the next tick serves it. */
let pendingInterrupt = false;

function handleUrgencyInterrupt(queue: MessageQueue, sendMessage: SendFn, ownerJid: string, urgencyScore: number): void {
  const now = Date.now();
  if (now - lastUrgencyInterruptTime < URGENCY_INTERRUPT_COOLDOWN) {
    log(`Urgency interrupt: suppressed (last interrupt ${Math.round((now - lastUrgencyInterruptTime) / 1000)}s ago, cooldown ${URGENCY_INTERRUPT_COOLDOWN / 1000}s)`);
    return;
  }
  log(`Urgency interrupt TRIGGERED: score ${urgencyScore.toFixed(2)} — scheduling immediate tick`);
  tick(queue, sendMessage, ownerJid).then((ran) => {
    if (ran) {
      lastUrgencyInterruptTime = Date.now();
      return;
    }
    // Only update the cooldown timestamp when the tick actually ran; a tick
    // skipped by tickLock is remembered and served by the next one.
    pendingInterrupt = true;
    log("Urgency interrupt: tick busy — deferred to the next tick");
  }).catch((err) => {
    log(`Urgency interrupt tick error: ${err}`);
  });
}

export function startBrainLoop(
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
): void {
  const cfg = getBrainConfig();

  if (!cfg.enabled) {
    log("Brain is disabled (BRAIN_ENABLED=false)");
    return;
  }
  if (brainLoopActive) {
    log.warn("startBrainLoop called while already running — ignoring");
    return;
  }
  brainLoopActive = true;

  ensureBrainDir();
  ensureSSHKey();
  const ownerJid = `${process.env.OWNER_PHONE}@s.whatsapp.net`;

  setUrgencyInterruptHandler((urgencyScore: number) => {
    handleUrgencyInterrupt(queue, sendMessage, ownerJid, urgencyScore);
  }, cfg.urgencyInterruptThreshold);

  graph.load();
  drainGraphInbox(graph); // ops queued by other processes while we were down
  migrateNotebook(graph);
  bootstrapIdentity(graph);

  // Bootstrap consciousness.dat if it doesn't exist
  try {
    loadConsciousness();
  } catch (err) {
    log(`Consciousness bootstrap (non-fatal): ${err}`);
  }

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

  initialTickTimer = setTimeout(() => {
    initialTickTimer = null;
    tick(queue, sendMessage, ownerJid).catch((err) => {
      log(`Initial tick error: ${err}`);
    });
  }, 10000);

  startWatchdog({
    getLastSuccessfulTick: () => loadState().lastSuccessfulTick,
    isBrainEnabled: () => getBrainConfig().enabled,
    // Only surface a failure that is newer than the last success — a stale
    // summary from a long-resolved incident would mislabel a fresh stall.
    getLastTickFailure: () => {
      const s = loadState();
      return s.lastTickFailure && s.lastTickFailure.ts > s.lastSuccessfulTick
        ? s.lastTickFailure
        : null;
    },
    // ALERTs escalate to Gillis via the scheduled-messages queue, whose 60s
    // delivery loop needs no Claude API call — the one output path that
    // survives an API outage (root cause of the jun–aug silent failure).
    ownerJid,
  });
}

export function isBrainLoopActive(): boolean {
  return brainLoopActive;
}

export function stopBrainLoop(): void {
  if (!brainLoopActive) {
    log.debug("stopBrainLoop: loop was never started — nothing to stop");
    return;
  }
  brainLoopActive = false;

  try {
    graph.save();
    log("Graph saved on shutdown");
  } catch (err) {
    log(`Failed to save graph on shutdown: ${err}`);
  }
  flushEmbeddings();

  if (brainInterval) {
    clearInterval(brainInterval);
    brainInterval = null;
  }
  if (schedulerPollInterval) {
    clearInterval(schedulerPollInterval);
    schedulerPollInterval = null;
  }
  if (initialTickTimer) {
    clearTimeout(initialTickTimer);
    initialTickTimer = null;
  }
  stopWatchdog();
  log("Brain loop stopped");
}

// ── Tick Concurrency Guards ──
let tickLock = false;
let newsDigestRunning = false;
let lastNewsDigestAttempt = 0;
const NEWS_DIGEST_RETRY_MS = 30 * 60 * 1000; // failed/skipped runs retry at most every 30 min
let playStoreDigestRunning = false;
let lastPlayStoreDigestAttempt = 0;
const PLAYSTORE_DIGEST_RETRY_MS = 30 * 60 * 1000;

/**
 * An LLM tick that outlived its budget and is still running. Its results land
 * via patchState when it finishes; until then no new LLM tick is started so
 * two expensive calls never overlap. Ignored after twice the budget in case
 * the provider's own timeout never fires.
 */
let orphanedTick: { kind: LlmTickKind; startedAt: number } | null = null;

// ── Hourly Stats Tracking ──
interface TickStats {
  thinks: number;
  consolidates: number;
  reflects: number;
  failures: number;
  costUsd: number;
  observations: number;
  selfImproves: number;
  periodStart: number;
}

function freshHourlyStats(): TickStats {
  return { thinks: 0, consolidates: 0, reflects: 0, failures: 0, costUsd: 0, observations: 0, selfImproves: 0, periodStart: Date.now() };
}

let hourlyStats: TickStats = freshHourlyStats();

function bumpHourlyStats(delta: Partial<TickStats>): void {
  const next = { ...hourlyStats };
  for (const [key, value] of Object.entries(delta) as [keyof TickStats, number][]) {
    next[key] = next[key] + value;
  }
  hourlyStats = next;
}

function logHourlyStats(): void {
  const elapsed = (Date.now() - hourlyStats.periodStart) / 3600_000;
  if (elapsed < 0.95) return; // Not yet ~1 hour

  const s = hourlyStats;
  const totalTicks = s.thinks + s.consolidates + s.reflects;
  log(
    `[HOURLY STATS] ` +
    `thinks: ${s.thinks}, consolidates: ${s.consolidates}, reflects: ${s.reflects}, ` +
    `failures: ${s.failures}, observations: ${s.observations}, ` +
    `cost: $${s.costUsd.toFixed(4)}, self-improves: ${s.selfImproves}, ` +
    `total ticks: ${totalTicks} in ${elapsed.toFixed(1)}h`,
  );
  hourlyStats = freshHourlyStats();
}

// ── Tick Scheduler ──

/** Returns true when the tick ran, false when it was skipped because one is already running. */
async function tick(
  queue: MessageQueue,
  sendMessage: SendFn,
  ownerJid: string,
): Promise<boolean> {
  if (tickLock) {
    log("Skipping tick — previous tick still running");
    return false;
  }
  tickLock = true;
  try {
    await runTick(queue, sendMessage, ownerJid);
    return true;
  } finally {
    tickLock = false;
  }
}

interface TickContext {
  queue: MessageQueue;
  sendMessage: SendFn;
  ownerJid: string;
  cfg: BrainConfig;
  now: number;
}

async function runTick(queue: MessageQueue, sendMessage: SendFn, ownerJid: string): Promise<void> {
  const cfg = getBrainConfig();

  // ── Master kill switch: skip ALL brain operations when disabled ──
  if (!cfg.enabled) {
    return;
  }

  // ── Graph sync: honour a restore-from-backup reload, then apply ops queued by other processes ──
  if (consumeReloadRequest()) {
    log("Reload requested — reloading graph from disk");
    graph.load();
  }
  drainGraphInbox(graph);

  const state = loadState();
  const now = Date.now();
  const today = getOwnerLocalDate(cfg.ownerTimezone);

  // ── Pick up self-improve results from worker ──
  pickUpImproveResult(state, graph, saveState, IMPROVE_RESULT_FILE, IMPROVE_TASK_FILE, QUEUED_MARKER_FILE);

  // ── Intercept task files → route through queue ──
  interceptDirectTask(IMPROVE_TASK_FILE, QUEUED_MARKER_FILE);

  // ── Daily self-improve target: keep proposing until minPerDay improvements
  // have shipped today. Re-nudges at most every NUDGE_SPACING_MS, only while
  // the queue is drained and no worker is running, and stops at quiet hours.
  // Hard caps: at most MAX_FORCED_REFLECTS_PER_DAY forced reflects, and none
  // after MAX_CONSECUTIVE_FAILED_PROPOSALS failed proposals in a row today —
  // a brain that keeps proposing broken changes should stop, not try harder.
  try {
    const ownerHourNow = getOwnerLocalTime(cfg.ownerTimezone).hour;
    const NUDGE_SPACING_MS = 90 * 60 * 1000;
    const MAX_FORCED_REFLECTS_PER_DAY = 2;
    const MAX_CONSECUTIVE_FAILED_PROPOSALS = 3;
    if (
      cfg.selfImproveEnabled &&
      cfg.selfImproveMinPerDay > 0 &&
      ownerHourNow >= cfg.selfImproveDailyHour &&
      ownerHourNow < cfg.quietStart &&
      Date.now() - (state.lastImproveNudgeAt ?? 0) >= NUDGE_SPACING_MS
    ) {
      const queue = loadQueue();
      const queueActionable = queue.items.filter(i =>
        i.status === "pending" || i.status === "approved" || i.status === "running" ||
        i.status === "merge-pending" || i.status === "merge-failed",
      ).length;
      const doneToday = getDailyCompletedCount();
      const weeklyDone = getWeeklyCompletedCount();
      const forcedToday = getForcedReflectsToday(today);
      const failStreak = getConsecutiveFailuresToday();
      if (
        doneToday < cfg.selfImproveMinPerDay &&
        queueActionable === 0 &&
        !state.pendingSelfMod &&
        weeklyDone < cfg.selfImproveMaxPerWeek &&
        forcedToday < MAX_FORCED_REFLECTS_PER_DAY &&
        failStreak < MAX_CONSECUTIVE_FAILED_PROPOSALS
      ) {
        state.lastImproveNudgeAt = Date.now();
        const forcedCount = recordForcedReflect(today);
        log(`Daily improve target: ${doneToday}/${cfg.selfImproveMinPerDay} shipped today — forcing reflect ${forcedCount}/${MAX_FORCED_REFLECTS_PER_DAY} (weekly ${weeklyDone}/${cfg.selfImproveMaxPerWeek}, fail streak ${failStreak})`);
        state.lastReflectTick = 0;
        // The reflect prompt derives its improvement nudge from selfImproveStats
        // (improve queue + history ground truth) — no working-memory note needed,
        // and a self-written tracking string would go stale and read as false fact.
        saveState(state);
      } else if (doneToday < cfg.selfImproveMinPerDay && (forcedToday >= MAX_FORCED_REFLECTS_PER_DAY || failStreak >= MAX_CONSECUTIVE_FAILED_PROPOSALS)) {
        state.lastImproveNudgeAt = Date.now();
        log(`Daily improve target not met (${doneToday}/${cfg.selfImproveMinPerDay}) but nudging stopped: forced reflects ${forcedToday}/${MAX_FORCED_REFLECTS_PER_DAY}, fail streak ${failStreak}`);
        saveState(state);
      }
    }
  } catch (err) {
    log(`Daily improve nudge error: ${err}`);
  }

  // ── Check for pending self-improve task ──
  checkAndSpawnImproveWorker(state, saveState, IMPROVE_TASK_FILE, IMPROVE_RESULT_FILE, QUEUED_MARKER_FILE);

  // ── Sub-agent management ──
  pickUpSubAgentResults();
  checkAndSpawnSubAgentWorkers();

  // ── From here on: patchState at the moment of change, no snapshot saves ──
  const ctx: TickContext = { queue, sendMessage, ownerJid, cfg, now };
  let st = rollDailyCounters(loadState(), today);
  st = verifyLastBrainMessageDelivery(st, cfg.tickInterval);

  // Daily pruning of old observations
  if (lastPruneDate !== today) {
    lastPruneDate = today;
    pruneObservations();
  }

  const observed = await runObservationCycle(st, ctx);
  st = observed.state;

  // ── Detect initiative signals ──
  const signals = detectSignals(st, graph);
  st = loadState();
  const highPrioritySignals = signals.filter(s => s.priority >= 0.5);

  if (circuitBreakerOpen(st, cfg, now)) return;

  const initiativeTriggered = highPrioritySignals.length > 0
    && observed.pending.length === 0
    && now - st.lastThinkTick >= cfg.thinkCooldown
    && initiativeBudgetAvailable(st);

  const decision = decideTickKind({
    now,
    lastThinkTick: st.lastThinkTick,
    lastConsolidateTick: st.lastConsolidateTick,
    lastReflectTick: st.lastReflectTick,
    thinkCooldown: cfg.thinkCooldown,
    consolidateInterval: cfg.consolidateInterval,
    reflectInterval: cfg.reflectInterval,
    timeAwarenessInterval: TIME_AWARENESS_INTERVAL,
    nodeCount: graph.nodeCount,
    hasPending: observed.pending.length > 0,
    hasTriggerPending: observed.pending.some(isSyntheticTrigger),
    pendingUrgency: getPendingUrgency(),
    urgencyBypassThreshold: URGENCY_BYPASS_THRESHOLD,
    urgencyMinCooldown: URGENCY_MIN_COOLDOWN,
    pendingInterrupt,
    initiativeTriggered,
  });
  if (pendingInterrupt && observed.pending.length === 0) pendingInterrupt = false; // nothing left to serve

  // Defer to owner messages
  if (!queue.idle || decision.kind === null) return;

  await runDecidedTick(decision, st, observed.pending, signals, initiativeTriggered, ctx);
  graph.save();
  logHourlyStats();
}

// ── Tick helpers ──

/** Reset the per-day counters when the owner-local date rolled over. */
function rollDailyCounters(state: BrainState, today: string): BrainState {
  const patch: Partial<BrainState> = {};
  if (state.messagesTodayDate !== today) {
    patch.messagesToday = 0;
    patch.messagesTodayDate = today;
  }
  if (state.recurringBudgetDate !== today) {
    patch.recurringBudgetDate = today;
    patch.recurringThinksToday = 0;
  }
  return Object.keys(patch).length > 0 ? patchState(patch) : state;
}

interface ObservationCycle {
  state: BrainState;
  /** Unconsumed queue: everything in observations.jsonl past the consumed cursor, plus fresh triggers. */
  pending: Observation[];
}

/**
 * Read the durable queue, run the free observe pass over what it has not seen
 * yet, inject due recurring triggers and mirror the queue into the graph.
 */
async function runObservationCycle(state: BrainState, ctx: TickContext): Promise<ObservationCycle> {
  const pendingFromFile = getObservationsSince(state.lastObservationTime);
  const newObs = selectUnobserved(pendingFromFile, state.lastObservedAt ?? state.lastObservationTime);
  bumpHourlyStats({ observations: newObs.length });

  // Heartbeat: record that the observation pipeline is alive. Gaps in this
  // history are system downtime — silence detectors consult it so they don't
  // mistake ARIA being deaf for contacts being quiet. Seeded from
  // lastObserveTick so an outage predating the heartbeat file is still visible.
  recordObserveHeartbeat(ctx.now, state.lastObserveTick || state.lastObservationTime);

  let st = state;
  if (newObs.length > 0) {
    scoreObservations(newObs);
    st = observeTick(newObs, ctx.now);
  }

  const recurring = await handleRecurringTasks(st, ctx);
  const pending = [...pendingFromFile, ...recurring.injected];
  for (const obs of pending) graph.addPendingObservation(obs);
  if (pending.length > 0) {
    log(`Observe: ${newObs.length} new, ${pending.length} pending (${graph.getPendingObservations().length} mirrored)`);
  }
  return { state: recurring.state, pending };
}

/** detectInitiativeSignals purges expired snoozes in place — run it on a copy and patch the result. */
function detectSignals(state: BrainState, g: MemoryGraph): InitiativeSignal[] {
  const wm = loadWorkingMemory();
  populateTemporalContext(wm);
  const scratch: BrainState = { ...state, ...cloneSignalState(state) };
  const signals = detectInitiativeSignals(g, wm, scratch);
  saveWorkingMemory(wm);
  patchState({ signalSnoozes: scratch.signalSnoozes, signalSurfacedCounts: scratch.signalSurfacedCounts });
  return signals;
}

/** canTriggerInitiativeThink resets the daily budget in place — patch the rollover if it happened. */
function initiativeBudgetAvailable(state: BrainState): boolean {
  const scratch = { ...state };
  const allowed = canTriggerInitiativeThink(scratch);
  if (scratch.initiativeBudgetDate !== state.initiativeBudgetDate) {
    patchState({ initiativeBudgetDate: scratch.initiativeBudgetDate, initiativeThinksToday: scratch.initiativeThinksToday });
  }
  return allowed;
}

/**
 * Circuit breaker: after CB_MAX_FAILURES consecutive failures, back off
 * exponentially from the last ATTEMPT (not the last completed tick), so
 * failures before the LLM call engage the backoff too.
 */
function circuitBreakerOpen(state: BrainState, cfg: BrainConfig, now: number): boolean {
  if (state.consecutiveFailures < CB_MAX_FAILURES) return false;
  const backoffMs = computeBackoffMs(state.consecutiveFailures, cfg.tickInterval, CB_MAX_BACKOFF);
  const lastAttempt = state.lastTickAttemptAt
    ?? Math.max(state.lastThinkTick, state.lastConsolidateTick, state.lastReflectTick);
  const sinceAttempt = now - lastAttempt;
  if (sinceAttempt < backoffMs) {
    log(`Circuit breaker OPEN: backing off (${state.consecutiveFailures} failures, next attempt in ${Math.round((backoffMs - sinceAttempt) / 1000)}s)`);
    return true;
  }
  log(`Circuit breaker HALF-OPEN: ${state.consecutiveFailures} failures, backoff elapsed — retrying one tick`);
  return false;
}

interface TickOutcome {
  ran: boolean;
  succeeded: boolean;
  error: BrainError | null;
}

function orphanStillRunning(now: number): boolean {
  if (!orphanedTick) return false;
  if (now - orphanedTick.startedAt >= 2 * tickTimeoutFor(orphanedTick.kind, TICK_TIMEOUT_ENV)) {
    log(`Orphaned ${orphanedTick.kind} tick from ${new Date(orphanedTick.startedAt).toISOString()} never settled — ignoring it`);
    orphanedTick = null;
    return false;
  }
  return true;
}

/** Race one LLM tick against its budget; a timed-out tick is tracked as orphaned until it settles. */
async function runWithBudget(kind: LlmTickKind, work: (signal: AbortSignal) => Promise<boolean>): Promise<TickOutcome> {
  const now = Date.now();
  if (orphanStillRunning(now)) {
    log(`Skipping ${kind} tick — orphaned ${orphanedTick!.kind} tick still running (${Math.round((now - orphanedTick!.startedAt) / 1000)}s)`);
    return { ran: false, succeeded: false, error: null };
  }
  const controller = new AbortController();
  const promise = work(controller.signal);
  try {
    const succeeded = await withTimeout(promise, tickTimeoutFor(kind, TICK_TIMEOUT_ENV), `${kind}Tick`, controller);
    return { ran: true, succeeded, error: null };
  } catch (err) {
    if (err instanceof TimeoutError) {
      orphanedTick = { kind, startedAt: now };
      promise.then(
        (ok) => { log(`Orphaned ${kind} tick finished late (${ok ? "success" : "failure"}) — results persisted by the tick itself`); },
        (late) => { log(`Orphaned ${kind} tick failed late: ${late}`); },
      ).finally(() => { orphanedTick = null; });
    }
    const wrapped = err instanceof BrainError ? err : wrapError(err, kind, `Tick execution error: ${err}`);
    const structured = wrapped.toStructuredLog();
    log(`Tick execution error [${structured.phase}]: ${structured.message} (transient=${structured.transient}, elapsed=${structured.elapsedMs ?? "?"}ms)`);
    if (structured.cause) log(`  cause: ${structured.cause}`);
    return { ran: true, succeeded: false, error: wrapped };
  }
}

async function runDecidedTick(
  decision: TickDecision,
  state: BrainState,
  pending: Observation[],
  signals: InitiativeSignal[],
  initiativeTriggered: boolean,
  ctx: TickContext,
): Promise<void> {
  const kind = decision.kind!;
  const { queue, sendMessage, ownerJid, now } = ctx;
  const prevCost = state.totalCost;
  log(`${kind} tick: ${decision.reason}`);
  if (decision.urgentBypass) pendingInterrupt = false;
  patchState({ lastTickAttemptAt: now });

  const outcome = await runWithBudget(kind, async (signal) => {
    if (kind === "reflect") return reflectTick(state, queue, sendMessage, ownerJid, graph, signals, signal);
    if (kind === "consolidate") {
      const ok = await consolidateTick(state, queue, graph, signal);
      return ok ? await chainPostConsolidateThink(ctx, signals, signal) || ok : ok;
    }
    const ok = await thinkTick(state, pending, queue, sendMessage, ownerJid, graph, signals, signal);
    // Only consume initiative budget after successful execution.
    if (ok && initiativeTriggered && pending.length === 0) {
      const next = patchState(s => ({ initiativeThinksToday: s.initiativeThinksToday + 1 }));
      log(`Initiative think #${next.initiativeThinksToday} today (${signals.filter(s => s.priority >= 0.5).length} high-priority signals)`);
    }
    return ok;
  });
  if (!outcome.ran) return;

  recordTickOutcome(outcome, kind, now);
  const after = patchState({ nodeCount: graph.nodeCount, edgeCount: graph.edgeCount });
  bumpHourlyStats({ costUsd: Math.max(0, after.totalCost - prevCost) });
  runPostTickChores(after, ctx);
}

/**
 * After consolidation, check whether new observations arrived during it.
 * Without this, ARIA goes blind for up to a full tick interval after a long consolidate.
 */
async function chainPostConsolidateThink(ctx: TickContext, signals: InitiativeSignal[], signal: AbortSignal): Promise<boolean> {
  const state = loadState();
  const postObs = getObservationsSince(state.lastObservationTime);
  if (postObs.length === 0) return false;
  log(`Post-consolidate: ${postObs.length} pending observations, chaining think tick`);
  const fresh = selectUnobserved(postObs, state.lastObservedAt ?? state.lastObservationTime);
  if (fresh.length > 0) {
    scoreObservations(fresh);
    observeTick(fresh, Date.now());
  }
  for (const obs of postObs) graph.addPendingObservation(obs);
  try {
    return await thinkTick(loadState(), postObs, ctx.queue, ctx.sendMessage, ctx.ownerJid, graph, signals, signal);
  } catch (err) {
    log(`Post-consolidate think failed: ${err}`);
    return false;
  }
}

/** Track success/failure for health, urgency and stats. */
function recordTickOutcome(outcome: TickOutcome, kind: LlmTickKind, now: number): void {
  // Pending urgency is cleared either way: a failed tick must not keep
  // bypassing the cooldown every minute — the backoff owns the retry cadence.
  clearPendingUrgency();
  if (!outcome.succeeded) {
    // Persist a compact failure summary so the watchdog alert and dashboard
    // can name the root cause even after a restart.
    const next = patchState(s => {
      const consecutiveFailures = s.consecutiveFailures + 1;
      const lastTickFailure: TickFailureSummary = {
        ts: now,
        phase: outcome.error?.context.phase ?? kind,
        message: (outcome.error?.message ?? "tick returned failure without an exception").slice(0, 200),
        transient: outcome.error?.context.transient ?? false,
        consecutiveFailures,
      };
      return { consecutiveFailures, lastTickFailure };
    });
    bumpHourlyStats({ failures: 1 });
    const errInfo = outcome.error ? ` [${outcome.error.context.phase}, transient=${outcome.error.context.transient}]` : "";
    log(`Tick failed${errInfo} (${next.consecutiveFailures} consecutive failures)`);
    return;
  }
  patchState({ consecutiveFailures: 0, lastSuccessfulTick: now });
  bumpHourlyStats(kind === "think" ? { thinks: 1 } : kind === "consolidate" ? { consolidates: 1 } : { reflects: 1 });

  if (!firstSuccessfulTickDone) {
    firstSuccessfulTickDone = true;
    resetBootCounter();
    saveLastGoodCommit();
    log("First successful tick — boot counter reset, last good commit saved");
  }
  // Only check for self-modification on consolidate/reflect ticks (not every think tick)
  if (kind !== "think") recordSelfModification(now);
}

function recordSelfModification(now: number): void {
  const selfModChanges = checkSelfMod();
  if (!selfModChanges) return;
  let alreadyTracked = false;
  try {
    if (existsSync(SELF_MOD_MARKER_FILE)) {
      const marker = JSON.parse(readFileSync(SELF_MOD_MARKER_FILE, "utf-8"));
      alreadyTracked = marker.changes === selfModChanges;
    }
  } catch (err) {
    log(`Self-mod marker unreadable (treating as new): ${err}`);
  }
  if (alreadyTracked) return; // Same uncommitted changes already recorded — skip duplicate node
  log(`Self-modification detected:\n${selfModChanges}`);
  writeSelfModMarker(selfModChanges);
  graph.addNode({
    id: `n_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
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

/** Backup, retrieval-drift replay and the once-a-day digests (all after a completed LLM tick). */
function runPostTickChores(state: BrainState, ctx: TickContext): void {
  if (shouldRunBackup(state.lastBackupTick ?? 0)) {
    try {
      createBackup("auto");
      patchState({ lastBackupTick: Date.now() });
      log("Daily memory backup completed");
    } catch (err) {
      log(`Daily backup failed: ${err}`);
    }
  }

  // Weekly retrieval-drift replay (structural, no Claude call): replays a
  // frozen set of canonical prompts through the activation pipeline and
  // compares top-K node sets against a stored baseline.
  if (shouldRunReplay()) {
    try {
      const replayReport = replayAndCompare(graph);
      if (replayReport?.alert) log(`⚠ RETRIEVAL REPLAY ALERT: ${replayReport.alert}`);
    } catch (err) {
      log(`Retrieval replay failed (non-fatal): ${err}`);
    }
  }

  runDailyNewsDigest(state, ctx.cfg);
  runDailyPlayStoreDigest(state, ctx);
}

/** Daily news digest (once/day after configured local hour, silent, fire-and-forget). */
function runDailyNewsDigest(state: BrainState, cfg: BrainConfig): void {
  if (
    !shouldRunNewsDigest(state.lastNewsDigestTick ?? 0, cfg.ownerTimezone) ||
    newsDigestRunning ||
    Date.now() - lastNewsDigestAttempt < NEWS_DIGEST_RETRY_MS
  ) return;
  newsDigestRunning = true;
  lastNewsDigestAttempt = Date.now();
  // The digest is context-only, so nothing in this tick needs its result and
  // awaiting it would hold the tick lock for up to ~75s. The day's slot is
  // only consumed on success — failed runs retry after NEWS_DIGEST_RETRY_MS.
  runNewsDigest(graph)
    .then((digest) => {
      if (!digest.stored) return;
      patchState({ lastNewsDigestTick: Date.now() });
      log(`Daily news digest stored (${digest.itemCount} items reviewed)`);
    })
    .catch((err) => log(`News digest failed (non-fatal): ${err}`))
    .finally(() => { newsDigestRunning = false; });
}

/** Daily Play Store report (once/day after configured local hour, via WhatsApp, fire-and-forget). */
function runDailyPlayStoreDigest(state: BrainState, ctx: TickContext): void {
  if (
    !shouldRunPlayStoreDigest(state.lastPlayStoreDigestTick ?? 0, ctx.cfg.ownerTimezone) ||
    playStoreDigestRunning ||
    Date.now() - lastPlayStoreDigestAttempt < PLAYSTORE_DIGEST_RETRY_MS
  ) return;
  playStoreDigestRunning = true;
  lastPlayStoreDigestAttempt = Date.now();
  runPlayStoreDigest(ctx.sendMessage, ctx.ownerJid)
    .then((result) => {
      if (!result.consumed) {
        if (result.reason) log(`Play Store report skipped: ${result.reason}`);
        return;
      }
      patchState(s => ({
        lastPlayStoreDigestTick: Date.now(),
        lastMessageTime: result.delivered ? Date.now() : s.lastMessageTime,
        messagesToday: result.delivered ? s.messagesToday + 1 : s.messagesToday,
      }));
    })
    .catch((err) => log(`Play Store report failed (non-fatal): ${err}`))
    .finally(() => { playStoreDigestRunning = false; });
}

// ── Observe Tick (free, no Claude call) ──

/** name/tag/JID → person node ids, for O(1) sender lookup instead of O(persons×observations). */
function buildPersonNameIndex(): Map<string, string[]> {
  const nameIndex = new Map<string, string[]>();
  const indexKey = (key: string, id: string) => {
    if (key.length < 2) return;
    nameIndex.set(key, [...(nameIndex.get(key) ?? []), id]);
  };
  for (const node of graph.findByType("person")) {
    // Index by content words and tags. Words are also indexed with surrounding
    // punctuation stripped so identifiers like "(JID 1234-5678)" in node
    // content become matchable against a group chat's JID.
    for (const w of node.content.toLowerCase().split(/\s+/)) {
      indexKey(w, node.id);
      const cleaned = w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
      if (cleaned !== w) indexKey(cleaned, node.id);
    }
    for (const tag of node.tags) indexKey(tag.toLowerCase(), node.id);
  }
  return nameIndex;
}

/**
 * Lookup keys for an observation: sender name — and for group chats also the
 * group's JID and name, so person nodes representing the group itself are
 * reinforced by activity from any participant.
 */
function observationLookupKeys(obs: Observation): string[] {
  const keys: string[] = [];
  if (obs.sender) keys.push(obs.sender.toLowerCase());
  if (!obs.isGroup) return keys;
  const groupJid = obs.chatJid ?? (obs.senderJid?.endsWith("@g.us") ? obs.senderJid : undefined);
  if (groupJid) {
    keys.push(groupJid.toLowerCase(), groupJid.split("@")[0].toLowerCase()); // bare id, as written in node content
  }
  const groupName = obs.groupName || obs.chatName;
  if (groupName) {
    const g = groupName.toLowerCase();
    keys.push(g, g.replace(/\s+/g, "-")); // tag convention: "familie haas" → "familie-haas"
  }
  return keys;
}

/**
 * Free reinforcement pass over observations the brain has not yet seen:
 * touches matching person nodes and updates conversation threads. Advances
 * `lastObservedAt` only — consumption is the think tick's business.
 */
function observeTick(observations: Observation[], now: number): BrainState {
  const nameIndex = buildPersonNameIndex();
  const accessedIds = new Set<string>();
  for (const obs of observations) {
    for (const key of observationLookupKeys(obs)) {
      for (const id of nameIndex.get(key) ?? []) {
        if (accessedIds.has(id)) continue;
        graph.accessNode(id);
        accessedIds.add(id);
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

  return patchState({ lastObservedAt: now, lastObserveTick: now });
}
