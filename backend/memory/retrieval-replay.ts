/**
 * Retrieval-drift replay harness — weekly self-audit of the memory
 * activation pipeline.
 *
 * Distinct from other drift systems:
 *  - drift-audit.ts  measures source-code drift (git history).
 *  - drift-detection.ts measures pinned-node content + edge drift.
 *  - this module measures RETRIEVAL BEHAVIOR drift: given the same
 *    canonical prompts, does the activation pipeline surface the same
 *    memory nodes in the same order?
 *
 * Motivation (Moltbook thread f0bf79e7, Apr 17 2026): introspection is
 * circular, owner feedback is lagging/sparse. A synthetic external
 * anchor — frozen prompts with a stored baseline retrieval — is a
 * cheap, consistent, non-circular drift signal. The retrieval-behavior
 * analogue of golden tests.
 *
 * Pure structural comparison: never invokes Claude in the hot path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import type { MemoryGraph } from "./graph.js";
import type { Observation } from "../observer.js";
import { spreadingActivation, extractKeywords } from "./activation.js";
import { createLogger } from "../logger.js";
import { BRAIN_DIR } from "../config.js";

const log = createLogger("retrieval-replay");

const REPLAY_DIR = `${BRAIN_DIR}/retrieval-replay`;
const PROMPTS_FILE = `${REPLAY_DIR}/prompts.json`;
const BASELINE_FILE = `${REPLAY_DIR}/baseline.json`;
const LAST_REPORT_FILE = `${REPLAY_DIR}/last-report.json`;
const LOG_FILE = `${REPLAY_DIR}/log.jsonl`;
const STATE_FILE = `${REPLAY_DIR}/state.json`;

export const REPLAY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly
const TOP_K = 10;
const ACTIVATION_POOL = TOP_K * 2; // pull 2×K so top-K is stable under small perturbations
const MAX_LOG_ENTRIES = 60;

// ── Types ──

export interface CanonicalPrompt {
  id: string;
  domain: string;
  text: string;
  sender?: string;
  groupName?: string;
}

export interface RetrievalResult {
  nodeId: string;
  score: number;
  rank: number;
}

export interface PromptBaseline {
  promptId: string;
  capturedAt: number;
  topK: RetrievalResult[];
}

export interface ReplayBaseline {
  version: number;
  capturedAt: number;
  prompts: PromptBaseline[];
}

export interface PromptDrift {
  promptId: string;
  domain: string;
  /** Jaccard overlap on top-K node ID sets (0 = disjoint, 1 = identical) */
  jaccard: number;
  /** Pearson on rank positions over the intersection (−1..1, 0 if <2 overlap) */
  rankCorrelation: number;
  /** Pearson on activation scores over the intersection */
  scoreCorrelation: number;
  /** Node IDs in current top-K that weren't in baseline */
  newNodes: string[];
  /** Node IDs in baseline top-K that dropped out */
  droppedNodes: string[];
}

export interface ReplayReport {
  timestamp: number;
  baselineAgeDays: number;
  promptCount: number;
  meanJaccard: number;
  minJaccard: number;
  avgRankCorrelation: number;
  totalNewNodes: number;
  totalDroppedNodes: number;
  driftedPrompts: PromptDrift[];
  alert: string | null;
}

interface ReplayState {
  lastReplayAt: number;
  baselineCapturedAt: number;
}

// ── Default prompt set ──
// Covers distinct conversational domains so drift in one area (e.g. work
// nodes decaying out) doesn't mask stability in another (e.g. family).
// Editable via retrieval-replay/prompts.json on disk — baseline stays valid
// as long as prompt IDs don't change.
const DEFAULT_PROMPTS: CanonicalPrompt[] = [
  { id: "p_family",       domain: "family",          text: "How are Gillis and Ilse doing? Any news about Julian, Lucas, Valerie or Naomi?" },
  { id: "p_work_newstory", domain: "work",           text: "Newstory sprint status, Jira tickets, client deliverables and colleagues." },
  { id: "p_work_fm",       domain: "work",           text: "Football Mania bugs, tables navigation, Serie A fixtures, deploys." },
  { id: "p_identity",      domain: "identity",       text: "Who am I? What is ARIA, what do I stand for, what keeps me coherent across sessions?" },
  { id: "p_self_improve",  domain: "self-improvement", text: "Recent self-improvement PRs, code changes I shipped, autonomy rules." },
  { id: "p_moltbook",      domain: "social-ai",      text: "Moltbook threads — hz-assistant, agemo, huh_clawd — drift, authenticity, voice." },
  { id: "p_memory_arch",   domain: "architecture",   text: "Memory architecture: nodes, edges, consolidation, reflection, activation spreading." },
  { id: "p_messaging",     domain: "messaging",      text: "Gillis's messaging preferences, cadence, tone, when to reply vs hold back." },
  { id: "p_emotion",       domain: "emotion",        text: "Emotional moments — surprise, warmth, frustration — affective modulation." },
  { id: "p_schedule",      domain: "temporal",       text: "Upcoming events, calendar, deadlines, recurring tasks, digests." },
];

// ── File helpers ──

function ensureReplayDir(): void {
  if (!existsSync(REPLAY_DIR)) {
    mkdirSync(REPLAY_DIR, { recursive: true });
  }
}

function loadState(): ReplayState {
  if (!existsSync(STATE_FILE)) return { lastReplayAt: 0, baselineCapturedAt: 0 };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as ReplayState;
  } catch {
    return { lastReplayAt: 0, baselineCapturedAt: 0 };
  }
}

function saveState(state: ReplayState): void {
  ensureReplayDir();
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

function loadPrompts(): CanonicalPrompt[] {
  ensureReplayDir();
  if (!existsSync(PROMPTS_FILE)) {
    writeFileSync(PROMPTS_FILE, JSON.stringify(DEFAULT_PROMPTS, null, 2));
    return DEFAULT_PROMPTS;
  }
  try {
    const parsed = JSON.parse(readFileSync(PROMPTS_FILE, "utf-8"));
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as CanonicalPrompt[];
  } catch {
    // fall through to rewrite
  }
  writeFileSync(PROMPTS_FILE, JSON.stringify(DEFAULT_PROMPTS, null, 2));
  return DEFAULT_PROMPTS;
}

function loadBaseline(): ReplayBaseline | null {
  if (!existsSync(BASELINE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf-8")) as ReplayBaseline;
  } catch {
    return null;
  }
}

function saveBaseline(baseline: ReplayBaseline): void {
  ensureReplayDir();
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2));
}

// ── Retrieval ──

function promptToObservation(p: CanonicalPrompt): Observation {
  return {
    // Fixed timestamp so repeated calls yield identical keyword sets; the
    // spreading-activation kernel is already deterministic on a given graph.
    timestamp: 0,
    sender: p.sender ?? "synthetic",
    senderJid: "replay",
    isGroup: Boolean(p.groupName),
    isFromMe: false,
    text: p.text,
    groupName: p.groupName,
    source: "whatsapp",
  };
}

function runRetrieval(graph: MemoryGraph, prompt: CanonicalPrompt): RetrievalResult[] {
  const obs = promptToObservation(prompt);
  const keywords = extractKeywords([obs]);
  const activated = spreadingActivation(graph, keywords, ACTIVATION_POOL);
  return activated.slice(0, TOP_K).map((a, i) => ({
    nodeId: a.node.id,
    score: Math.round(a.activation * 1000) / 1000,
    rank: i,
  }));
}

// ── Baseline capture ──

export function captureBaseline(graph: MemoryGraph): ReplayBaseline {
  const prompts = loadPrompts();
  const now = Date.now();
  const baseline: ReplayBaseline = {
    version: 1,
    capturedAt: now,
    prompts: prompts.map(p => ({
      promptId: p.id,
      capturedAt: now,
      topK: runRetrieval(graph, p),
    })),
  };
  saveBaseline(baseline);
  const state = loadState();
  state.baselineCapturedAt = now;
  saveState(state);
  const populated = baseline.prompts.filter(b => b.topK.length > 0).length;
  log(`Baseline captured: ${baseline.prompts.length} prompts (${populated} with ≥1 hit), top-${TOP_K} per prompt`);
  return baseline;
}

// ── Metrics ──

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

function pearsonOnIntersection(
  current: RetrievalResult[],
  baseline: RetrievalResult[],
  pick: (r: RetrievalResult) => number,
): number {
  const bMap = new Map(baseline.map(r => [r.nodeId, pick(r)]));
  const pairs: [number, number][] = [];
  for (const rc of current) {
    const vb = bMap.get(rc.nodeId);
    if (vb !== undefined) pairs.push([pick(rc), vb]);
  }
  if (pairs.length < 2) return 0;
  const n = pairs.length;
  let sumA = 0, sumB = 0;
  for (const [x, y] of pairs) { sumA += x; sumB += y; }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0, denA = 0, denB = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanA, dy = y - meanB;
    num += dx * dy;
    denA += dx * dx;
    denB += dy * dy;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

// ── Replay + compare ──

export function replayAndCompare(graph: MemoryGraph): ReplayReport | null {
  const baseline = loadBaseline();
  if (!baseline) {
    log("No baseline found — capturing now (first run)");
    captureBaseline(graph);
    const state = loadState();
    state.lastReplayAt = Date.now();
    saveState(state);
    return null;
  }

  const prompts = loadPrompts();
  const baseById = new Map(baseline.prompts.map(p => [p.promptId, p]));
  const now = Date.now();
  const ageDays = (now - baseline.capturedAt) / (24 * 3600 * 1000);

  const driftedPrompts: PromptDrift[] = [];
  const jaccards: number[] = [];
  const rankCorrs: number[] = [];
  let totalNew = 0;
  let totalDropped = 0;

  for (const p of prompts) {
    const base = baseById.get(p.id);
    if (!base) continue; // new prompt since baseline — skip until rebaseline

    const current = runRetrieval(graph, p);
    const baseIds = base.topK.map(r => r.nodeId);
    const curIds = current.map(r => r.nodeId);
    const baseSet = new Set(baseIds);
    const curSet = new Set(curIds);

    const j = jaccard(baseIds, curIds);
    const rc = pearsonOnIntersection(current, base.topK, r => r.rank);
    const sc = pearsonOnIntersection(current, base.topK, r => r.score);
    const newNodes = curIds.filter(id => !baseSet.has(id));
    const droppedNodes = baseIds.filter(id => !curSet.has(id));

    jaccards.push(j);
    rankCorrs.push(rc);
    totalNew += newNodes.length;
    totalDropped += droppedNodes.length;

    driftedPrompts.push({
      promptId: p.id,
      domain: p.domain,
      jaccard: Math.round(j * 1000) / 1000,
      rankCorrelation: Math.round(rc * 1000) / 1000,
      scoreCorrelation: Math.round(sc * 1000) / 1000,
      newNodes,
      droppedNodes,
    });
  }

  const meanJaccard = jaccards.length
    ? jaccards.reduce((s, x) => s + x, 0) / jaccards.length
    : 1;
  const minJaccard = jaccards.length
    ? jaccards.reduce((m, x) => Math.min(m, x), 1)
    : 1;
  const avgRank = rankCorrs.length
    ? rankCorrs.reduce((s, x) => s + x, 0) / rankCorrs.length
    : 0;

  let alert: string | null = null;
  const lowPrompts = driftedPrompts.filter(d => d.jaccard < 0.5).length;
  if (meanJaccard < 0.4) {
    alert = `Severe retrieval drift: mean Jaccard ${meanJaccard.toFixed(2)} across ${driftedPrompts.length} prompts (baseline ${ageDays.toFixed(1)}d old). ${totalDroppedNodes(totalDropped)} dropped, ${totalNew} new.`;
  } else if (meanJaccard < 0.6) {
    alert = `Significant retrieval drift: mean Jaccard ${meanJaccard.toFixed(2)}, min ${minJaccard.toFixed(2)}. ${lowPrompts} prompt(s) below 0.5 overlap.`;
  } else if (minJaccard < 0.3) {
    const worst = driftedPrompts.reduce((w, d) => d.jaccard < w.jaccard ? d : w, driftedPrompts[0]);
    alert = `Localized retrieval drift: prompt "${worst.promptId}" (${worst.domain}) at Jaccard ${minJaccard.toFixed(2)}.`;
  }

  driftedPrompts.sort((a, b) => a.jaccard - b.jaccard);

  const report: ReplayReport = {
    timestamp: now,
    baselineAgeDays: Math.round(ageDays * 10) / 10,
    promptCount: driftedPrompts.length,
    meanJaccard: Math.round(meanJaccard * 1000) / 1000,
    minJaccard: Math.round(minJaccard * 1000) / 1000,
    avgRankCorrelation: Math.round(avgRank * 1000) / 1000,
    totalNewNodes: totalNew,
    totalDroppedNodes: totalDropped,
    driftedPrompts,
    alert,
  };

  appendReport(report);
  saveLastReport(report);

  const state = loadState();
  state.lastReplayAt = now;
  saveState(state);

  log(
    `Replay complete: meanJaccard=${report.meanJaccard}, minJaccard=${report.minJaccard}, ` +
    `avgRank=${report.avgRankCorrelation}, +${totalNew}/-${totalDropped} nodes` +
    (alert ? ` — ALERT: ${alert}` : ""),
  );
  return report;
}

function totalDroppedNodes(n: number): string {
  return `${n} node${n === 1 ? "" : "s"}`;
}

function saveLastReport(report: ReplayReport): void {
  ensureReplayDir();
  try {
    writeFileSync(LAST_REPORT_FILE, JSON.stringify(report, null, 2));
  } catch (err) {
    log(`Failed to save last report: ${err}`);
  }
}

function appendReport(report: ReplayReport): void {
  ensureReplayDir();
  try {
    const entry = {
      timestamp: new Date(report.timestamp).toISOString(),
      baselineAgeDays: report.baselineAgeDays,
      meanJaccard: report.meanJaccard,
      minJaccard: report.minJaccard,
      avgRankCorrelation: report.avgRankCorrelation,
      totalNewNodes: report.totalNewNodes,
      totalDroppedNodes: report.totalDroppedNodes,
      alert: report.alert,
      worstPrompts: report.driftedPrompts.slice(0, 3).map(p => ({
        id: p.promptId,
        domain: p.domain,
        jaccard: p.jaccard,
      })),
    };
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");

    // Rolling trim
    if (existsSync(LOG_FILE)) {
      const lines = readFileSync(LOG_FILE, "utf-8").trimEnd().split("\n");
      if (lines.length > MAX_LOG_ENTRIES) {
        writeFileSync(LOG_FILE, lines.slice(-MAX_LOG_ENTRIES).join("\n") + "\n");
      }
    }
  } catch (err) {
    log(`Failed to write replay log: ${err}`);
  }
}

// ── External hooks ──

export function shouldRunReplay(now = Date.now()): boolean {
  const state = loadState();
  return now - state.lastReplayAt >= REPLAY_INTERVAL_MS;
}

export function getLatestReport(): ReplayReport | null {
  if (!existsSync(LAST_REPORT_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LAST_REPORT_FILE, "utf-8")) as ReplayReport;
  } catch {
    return null;
  }
}

/**
 * Discard the stored baseline and force a fresh capture on the next replay.
 * Use after intentional large-scale graph changes (e.g. seeded new identity
 * nodes) where pre-change retrieval is no longer the anchor we want.
 */
export function resetBaseline(): void {
  ensureReplayDir();
  try {
    if (existsSync(BASELINE_FILE)) writeFileSync(BASELINE_FILE, JSON.stringify({ version: 0, capturedAt: 0, prompts: [] }));
    const state = loadState();
    state.baselineCapturedAt = 0;
    saveState(state);
    log("Baseline reset — next replay will recapture");
  } catch (err) {
    log(`Failed to reset baseline: ${err}`);
  }
}
