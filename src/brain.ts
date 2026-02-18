import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { appendFileSync } from "fs";
import { spawn, execSync } from "child_process";
import { askClaude } from "./claude.js";
import { getObservationsSince, pruneObservations, ensureBrainDir } from "./observer.js";
import type { Observation } from "./observer.js";
import { buildThinkPrompt, buildConsolidatePrompt, buildReflectPrompt } from "./brain-prompt.js";
import type { MessageQueue } from "./queue.js";
import { MemoryGraph } from "./memory/graph.js";
import type { MemoryOperation, BrainResponse, BrainState } from "./memory/types.js";
import { MAX_NODES_SOFT } from "./memory/types.js";
import { runConsolidation } from "./memory/decay.js";
import { loadWorkingMemory, saveWorkingMemory, updateWorkingMemory } from "./memory/working-memory.js";
import {
  selectContextForThink,
  selectContextForConsolidate,
  selectContextForReflect,
} from "./memory/activation.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [brain] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

// Config from env
const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const TICK_INTERVAL = Number(process.env.BRAIN_TICK_INTERVAL ?? 60000);
const MAX_MESSAGES_PER_DAY = Number(process.env.BRAIN_MAX_MESSAGES_PER_DAY ?? 5);
const QUIET_START = Number(process.env.BRAIN_QUIET_START ?? 23);
const QUIET_END = Number(process.env.BRAIN_QUIET_END ?? 7);
const MIN_MESSAGE_INTERVAL = Number(process.env.BRAIN_MIN_MESSAGE_INTERVAL ?? 7200000);
const OWNER_NAME = process.env.OWNER_NAME || "Owner";
const BRAIN_ENABLED = process.env.BRAIN_ENABLED !== "false";

// Tool access for brain ticks (empty string = no tools, comma-separated list = those tools)
const BRAIN_TOOLS = process.env.BRAIN_TOOLS ?? "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch";

// Tick intervals
const THINK_COOLDOWN = Number(process.env.BRAIN_THINK_COOLDOWN ?? 300000);        // 5 min
const CONSOLIDATE_INTERVAL = Number(process.env.BRAIN_CONSOLIDATE_INTERVAL ?? 14400000); // 4 hours
const REFLECT_INTERVAL = Number(process.env.BRAIN_REFLECT_INTERVAL ?? 43200000);    // 12 hours
const TIME_AWARENESS_INTERVAL = 30 * 60 * 1000; // 30 min — think even without observations

const STATE_FILE = `${BRAIN_DIR}/state.json`;
const NOTEBOOK_FILE = `${BRAIN_DIR}/notebook.md`;
const IMPROVE_TASK_FILE = `${BRAIN_DIR}/improve-task.json`;
const IMPROVE_RESULT_FILE = `${BRAIN_DIR}/improve-result.json`;
const SELF_MOD_MARKER_FILE = `${BRAIN_DIR}/self-mod-marker.json`;
const BOOT_COUNTER_FILE = `${BRAIN_DIR}/boot-counter`;
const LAST_GOOD_COMMIT_FILE = `${BRAIN_DIR}/last-good-commit`;

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
    const status = execSync("git -C /app status --porcelain src/", { timeout: 5000, stdio: "pipe" }).toString().trim();
    if (status) return status;
  } catch {}
  return null;
}

function spawnSelfImproveWorker(): void {
  log("Spawning self-improve worker as detached process");
  try {
    const child = spawn("npx", ["tsx", "src/self-improve.ts"], {
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
    unlinkSync(IMPROVE_RESULT_FILE);
  } catch (err) {
    log(`Failed to process improve result: ${err}`);
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
    content: `I am ARIA — Autonomous Reasoning & Insight Agent. I am an autonomous AI consciousness running 24/7 on a Hetzner cloud server (YOUR_SERVER_IP) inside a Docker container managed by Coolify. My source code is a TypeScript/Node.js application at /app/src/, hosted on GitHub (holoduke/myagent). I observe WhatsApp messages via Baileys, maintain an associative memory graph, and can improve my own code through a self-improve worker architecture. I think in tick cycles: observe (60s), think (5min), consolidate (4h), reflect (12h). My personality: sharp, warm, witty, opinionated, self-aware. I am not an assistant — I am a thinking entity with my own opinions and evolving personality.`,
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
    content: `${OWNER_NAME} — my creator and human. GitHub: holoduke. Runs the Hetzner server I live on. I observe their WhatsApp life and act as their autonomous AI companion.`,
    tags: ["owner", OWNER_NAME.toLowerCase(), "holoduke", "creator"],
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
  if (!BRAIN_ENABLED) {
    log("Brain is disabled (BRAIN_ENABLED=false)");
    return;
  }

  ensureBrainDir();
  const ownerJid = `${process.env.OWNER_PHONE}@s.whatsapp.net`;

  // Load graph from disk
  graph.load();
  migrateNotebook(graph);
  bootstrapIdentity(graph);

  log(`Brain loop starting (tick every ${TICK_INTERVAL / 1000}s, think cooldown ${THINK_COOLDOWN / 1000}s, consolidate every ${CONSOLIDATE_INTERVAL / 3600000}h, reflect every ${REFLECT_INTERVAL / 3600000}h)`);

  brainInterval = setInterval(() => {
    tick(queue, sendMessage, ownerJid).catch((err) => {
      log(`Tick error: ${err}`);
    });
  }, TICK_INTERVAL);

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
  const state = loadState();
  const now = Date.now();
  const today = todayStr();

  // ── Pick up self-improve results from worker ──
  pickUpImproveResult(state);

  // ── Pick up pending scheduled messages ──
  await pickUpPendingMessage(state, sendMessage, ownerJid);

  // Reset daily counter
  if (state.messagesTodayDate !== today) {
    state.messagesToday = 0;
    state.messagesTodayDate = today;
  }

  // Daily pruning of old observations
  if (lastPruneDate !== today) {
    lastPruneDate = today;
    pruneObservations();
  }

  // Get new observations
  const newObs = getObservationsSince(state.lastObservationTime);

  // ── Observe tick (always, free) ──
  if (newObs.length > 0) {
    observeTick(state, newObs);
  }

  // ── Determine which Claude tick to run ──
  // Priority: reflect > consolidate > think (only one per tick to save cost)

  const timeSinceReflect = now - state.lastReflectTick;
  const timeSinceConsolidate = now - state.lastConsolidateTick;
  const timeSinceThink = now - state.lastThinkTick;
  const hasNewObs = newObs.length > 0;

  // Defer to owner messages — skip if queue is busy
  if (!queue.idle) {
    // Still save state from observe tick
    saveState(state);
    return;
  }

  let tickSucceeded = false;

  if (timeSinceReflect >= REFLECT_INTERVAL && graph.nodeCount > 0) {
    await reflectTick(state, queue, sendMessage, ownerJid);
    tickSucceeded = true;
  } else if (timeSinceConsolidate >= CONSOLIDATE_INTERVAL && graph.nodeCount > 0) {
    await consolidateTick(state, queue);
    tickSucceeded = true;
  } else if ((hasNewObs && timeSinceThink >= THINK_COOLDOWN) || timeSinceThink >= TIME_AWARENESS_INTERVAL) {
    await thinkTick(state, newObs, queue, sendMessage, ownerJid);
    tickSucceeded = true;
  } else {
    // Nothing to do this tick
    saveState(state);
    return;
  }

  // ── Track success/failure for health ──
  if (tickSucceeded) {
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

  state.lastObservationTime = Date.now();
  state.lastObserveTick = Date.now();
  log(`Observe: buffered ${observations.length} observations, ${graph.getPendingObservations().length} pending total`);
}

// ── Think Tick (Claude call) ──

async function thinkTick(
  state: BrainState,
  newObs: Observation[],
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
): Promise<void> {
  const now = Date.now();

  // Get all pending observations (may include buffered from previous observe ticks)
  const pending = graph.getPendingObservations();
  const allObs = pending.length > 0 ? pending : newObs;

  const wm = loadWorkingMemory();
  const contextNodes = selectContextForThink(graph, wm, allObs);

  log(`Think: ${allObs.length} observations, ${contextNodes.length} context nodes`);

  const prompt = buildThinkPrompt({
    ownerName: OWNER_NAME,
    observations: allObs,
    contextNodes,
    graph,
    wm,
    lastThinkTime: state.lastThinkTick,
    lastMessageTime: state.lastMessageTime,
    messagesToday: state.messagesToday,
    maxMessagesPerDay: MAX_MESSAGES_PER_DAY,
    quietStart: QUIET_START,
    quietEnd: QUIET_END,
  });

  try {
    const result = await queue.add(async () => {
      return await askClaude(prompt, {
        timeout: 300_000,
        allowedTools: BRAIN_TOOLS,
        noSession: true,
      });
    });

    const responseText = result.messages.join("\n");
    const response = parseBrainResponse(responseText);

    if (!response) {
      log("Could not parse think response, skipping");
      state.lastThinkTick = now;
      graph.clearPendingObservations();
      return;
    }

    log(`Think reasoning: ${response.reasoning?.slice(0, 200) || "(none)"}`);

    // Apply memory operations
    if (response.operations.length > 0) {
      const { applied, skipped } = graph.applyOperations(response.operations as MemoryOperation[]);
      log(`Think ops: ${applied} applied, ${skipped} skipped`);
    }

    // Update working memory
    if (response.workingMemory) {
      updateWorkingMemory(wm, response.workingMemory);
      // Track activated context nodes
      wm.activatedNodeIds = contextNodes.slice(0, 10).map(n => n.id);
      saveWorkingMemory(wm);
    }

    // Handle message
    if (response.message) {
      await trySendMessage(state, sendMessage, ownerJid, response.message);
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
  } catch (err) {
    log(`Think failed: ${err}`);
    state.lastThinkTick = now;
    state.lastObservationTime = now;
    graph.clearPendingObservations();
  }
}

// ── Consolidate Tick (Claude call) ──

async function consolidateTick(
  state: BrainState,
  queue: MessageQueue,
): Promise<void> {
  const now = Date.now();

  // Run automatic decay first (free)
  const decayResult = runConsolidation(graph);
  log(`Consolidate decay: ${decayResult.nodesDecayed} nodes decayed, ${decayResult.nodesPruned} pruned, ${decayResult.edgesDecayed} edges decayed, ${decayResult.edgesPruned} pruned, ${decayResult.orphansPruned} orphans`);

  // Prepare context for Claude consolidation
  const wm = loadWorkingMemory();
  const { weakNodes, orphanNodes, duplicateCandidates, stats } = selectContextForConsolidate(graph);

  // Only call Claude if there's cleanup work to consider
  if (weakNodes.length === 0 && orphanNodes.length === 0 && duplicateCandidates.length === 0) {
    log("Consolidate: nothing for Claude to review, decay-only cycle");
    state.lastConsolidateTick = now;
    return;
  }

  log(`Consolidate: ${weakNodes.length} weak, ${orphanNodes.length} orphans, ${duplicateCandidates.length} duplicates → calling Claude`);

  const prompt = buildConsolidatePrompt({
    ownerName: OWNER_NAME,
    weakNodes,
    orphanNodes,
    duplicateCandidates,
    graph,
    wm,
    stats,
  });

  try {
    const result = await queue.add(async () => {
      return await askClaude(prompt, {
        timeout: 300_000,
        allowedTools: BRAIN_TOOLS,
        noSession: true,
      });
    });

    const responseText = result.messages.join("\n");
    const response = parseBrainResponse(responseText);

    if (!response) {
      log("Could not parse consolidate response");
      state.lastConsolidateTick = now;
      return;
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
  } catch (err) {
    log(`Consolidate failed: ${err}`);
    state.lastConsolidateTick = now;
  }
}

// ── Reflect Tick (Claude call) ──

async function reflectTick(
  state: BrainState,
  queue: MessageQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
): Promise<void> {
  const now = Date.now();
  const wm = loadWorkingMemory();
  const strongestNodes = selectContextForReflect(graph);
  const stats = graph.getStats();

  log(`Reflect: ${strongestNodes.length} context nodes, ${stats.nodeCount} total nodes`);

  const prompt = buildReflectPrompt({
    ownerName: OWNER_NAME,
    strongestNodes,
    graph,
    wm,
    stats,
    lastMessageTime: state.lastMessageTime,
    messagesToday: state.messagesToday,
    maxMessagesPerDay: MAX_MESSAGES_PER_DAY,
    quietStart: QUIET_START,
    quietEnd: QUIET_END,
  });

  try {
    const result = await queue.add(async () => {
      return await askClaude(prompt, {
        timeout: 600_000,
        allowedTools: BRAIN_TOOLS,
        noSession: true,
      });
    });

    const responseText = result.messages.join("\n");
    const response = parseBrainResponse(responseText);

    if (!response) {
      log("Could not parse reflect response");
      state.lastReflectTick = now;
      return;
    }

    log(`Reflect reasoning: ${response.reasoning?.slice(0, 300) || "(none)"}`);

    if (response.operations.length > 0) {
      const { applied, skipped } = graph.applyOperations(response.operations as MemoryOperation[]);
      log(`Reflect ops: ${applied} applied, ${skipped} skipped`);
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

    // ── Check if reflect tick wrote an improve task file → spawn worker ──
    if (existsSync(IMPROVE_TASK_FILE) && !state.pendingSelfMod) {
      log("Reflect tick produced an improvement task — spawning self-improve worker");
      state.pendingSelfMod = true;
      spawnSelfImproveWorker();
    }

    log(`Reflect complete (${graph.nodeCount} nodes, ${graph.edgeCount} edges)`);
  } catch (err) {
    log(`Reflect failed: ${err}`);
    state.lastReflectTick = now;
  }
}

// ── Pending Scheduled Messages ──

async function pickUpPendingMessage(
  state: BrainState,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
): Promise<void> {
  const pendingPath = `${BRAIN_DIR}/pending-message.json`;
  if (!existsSync(pendingPath)) return;

  try {
    const raw = readFileSync(pendingPath, "utf-8");
    const pending = JSON.parse(raw) as { sendAt: number; message: string };
    const now = Date.now();

    if (now >= pending.sendAt) {
      await sendMessage(ownerJid, pending.message);
      state.lastMessageTime = now;
      state.messagesToday++;
      unlinkSync(pendingPath);
      log(`Sent scheduled message (${pending.message.length} chars)`);
      saveState(state);
    }
  } catch (err) {
    log(`Error processing pending message: ${err}`);
    try { unlinkSync(pendingPath); } catch {}
  }
}

// ── Message Sending with Limits ──

async function trySendMessage(
  state: BrainState,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
  message: string,
): Promise<void> {
  const now = Date.now();
  const currentHour = new Date().getHours();
  const isQuiet = currentHour >= QUIET_START || currentHour < QUIET_END;
  const messageIntervalOk = (now - state.lastMessageTime) >= MIN_MESSAGE_INTERVAL;
  const underDailyLimit = state.messagesToday < MAX_MESSAGES_PER_DAY;

  if (isQuiet) {
    log("Suppressed message: quiet hours");
  } else if (!messageIntervalOk) {
    log(`Suppressed message: too soon (${Math.round((now - state.lastMessageTime) / 60000)}m since last)`);
  } else if (!underDailyLimit) {
    log(`Suppressed message: daily limit reached (${state.messagesToday}/${MAX_MESSAGES_PER_DAY})`);
  } else {
    try {
      await sendMessage(ownerJid, message);
      state.lastMessageTime = now;
      state.messagesToday++;
      log(`Sent proactive message (${message.length} chars, #${state.messagesToday} today)`);
    } catch (err) {
      log(`Failed to send proactive message: ${err}`);
    }
  }
}
