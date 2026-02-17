import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFileSync } from "fs";
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

// ── Main Loop ──

let brainInterval: ReturnType<typeof setInterval> | null = null;
let lastPruneDate = "";
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

  if (timeSinceReflect >= REFLECT_INTERVAL && graph.nodeCount > 0) {
    await reflectTick(state, queue, sendMessage, ownerJid);
  } else if (timeSinceConsolidate >= CONSOLIDATE_INTERVAL && graph.nodeCount > 0) {
    await consolidateTick(state, queue);
  } else if ((hasNewObs && timeSinceThink >= THINK_COOLDOWN) || timeSinceThink >= TIME_AWARENESS_INTERVAL) {
    await thinkTick(state, newObs, queue, sendMessage, ownerJid);
  } else {
    // Nothing to do this tick
    saveState(state);
    return;
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

    log(`Reflect complete (${graph.nodeCount} nodes, ${graph.edgeCount} edges)`);
  } catch (err) {
    log(`Reflect failed: ${err}`);
    state.lastReflectTick = now;
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
