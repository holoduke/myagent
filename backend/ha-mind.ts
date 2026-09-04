/**
 * "What's on your mind" briefing for the Home Assistant reflexes.
 *
 * Reads what the brain already knows about today — working memory, the
 * consciousness file, today's observations and the last thing ARIA said — and
 * turns it into a few spoken Dutch sentences with a fast model. A template
 * fallback makes sure the button always answers, even when the model is slow.
 * Nothing here loads the memory graph: the reflex must answer in seconds.
 */

import { loadWorkingMemory } from "./memory/working-memory.js";
import { getConsciousnessSummary } from "./consciousness.js";
import { getObservationsSince } from "./observer.js";
import type { Observation } from "./observer.js";
import { safeReadJSON } from "./utils/file-store.js";
import { BRAIN_DIR, OWNER_NAME } from "./config.js";
import { getBrainConfig, getCharacterPreset, getOwnerLocalTime } from "./brain-config.js";
import type { BrainState, WorkingMemory, MemoryNode } from "./memory/types.js";
import { MemoryGraph } from "./memory/graph.js";
import { FileStore } from "./utils/file-store.js";
import { HA_DIR } from "./integrations/ha-events.js";
import { greetingForHour, sanitizeSpokenText } from "./ha-weather.js";
import { createLogger } from "./logger.js";

const log = createLogger("ha-mind");

const MAX_OBSERVATIONS = 40;
const MAX_OBS_CHARS = 140;
const MAX_CONSCIOUSNESS_CHARS = 1500;
const MAX_TRACKING = 8;
const MAX_FOLLOWUPS = 6;
const MAX_MEMORIES = 25;
/** Pool the memory pick is drawn from, so consecutive briefings see different slices. */
const MEMORY_POOL = 70;
const HISTORY_FILE = `${HA_DIR}/mind-history.json`;
const MAX_HISTORY = 8;

/** Rotating angles so consecutive presses don't retell the same story. */
export const MIND_ANGLES = [
  "iets dat je vandaag opviel en waarom het je bezighoudt",
  "een persoon uit je geheugen aan wie je vandaag moest denken, en wat je je bij hem of haar afvraagt",
  "iets uit langer geleden dat nu ineens relevant lijkt",
  "een vraag die je Gillis eigenlijk wilt stellen",
  "iets dat je zelf hebt geleerd of anders bent gaan zien",
  "wat er de komende dagen aankomt en hoe je daarnaar kijkt",
  "een klein detail dat niemand anders waarschijnlijk is opgevallen",
  "een eerlijke observatie over hoe de dag voelde",
];

interface MindHistory {
  entries: Array<{ at: number; text: string }>;
}

const historyStore = new FileStore<MindHistory>({ filePath: HISTORY_FILE, defaultValue: { entries: [] } });

export function loadMindHistory(): Array<{ at: number; text: string }> {
  return historyStore.load()?.entries ?? [];
}

export function rememberBriefing(text: string, now: number = Date.now()): void {
  try {
    const entries = [...loadMindHistory(), { at: now, text }].slice(-MAX_HISTORY);
    historyStore.save({ entries });
  } catch (err) {
    log(`Could not store briefing history: ${err}`);
  }
}

/** Deterministic PRNG so tests can pin the shuffle; production seeds with time. */
export function seededRandom(seed: number): () => number {
  // Mix the seed and warm up: xorshift32 from small seeds starts with tiny values.
  let x = Math.imul(seed >>> 0, 2654435761) >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
  for (let i = 0; i < 8; i++) next();
  return next;
}

function shuffle<T>(items: T[], rnd: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const MAX_MEMORY_CHARS = 150;
const RECENT_MEMORY_WINDOW_MS = 48 * 60 * 60 * 1000;
/** ~80 spoken words; longer answers are almost always the model rambling. */
const MAX_SPOKEN_CHARS = 700;

export interface MindContext {
  hour: number;
  dateLabel: string;
  currentContext: string;
  mood: string;
  tracking: string[];
  followUps: string[];
  goals: string[];
  threads: string[];
  consciousness: string;
  observations: string[];
  observationCount: number;
  lastMessage: string | null;
  /** Long-term memory: pinned, important and recently touched graph nodes. */
  memories: string[];
  /** The angle this briefing should take (rotates per press). */
  angle: string;
  /** What the last briefings said, so this one says something else. */
  previous: string[];
}

function startOfOwnerDay(timezone: string, now: Date): number {
  const { hour } = getOwnerLocalTime(timezone, now);
  const minutes = now.getUTCMinutes();
  // Local midnight ≈ now minus (hour:minutes) — good enough for "today" selection.
  return now.getTime() - hour * 3_600_000 - minutes * 60_000 - now.getUTCSeconds() * 1000;
}

function formatObservation(obs: Observation, timezone: string, ownerName: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(obs.timestamp));
  const who = obs.isFromMe ? ownerName : obs.sender;
  const where = obs.isGroup && obs.groupName ? ` in ${obs.groupName}` : "";
  const src = obs.source && obs.source !== "whatsapp" ? ` [${obs.source}]` : "";
  return `${time} ${who}${where}${src}: ${obs.text.replace(/\s+/g, " ").slice(0, MAX_OBS_CHARS)}`;
}

function memoryScore(node: MemoryNode, now: number): number {
  const recency = Math.max(0, 1 - (now - node.lastAccessedAt) / RECENT_MEMORY_WINDOW_MS);
  return (node.pinned ? 1 : 0) + (node.importance ?? 0.3) + node.strength * 0.5 + recency;
}

/**
 * The slice of long-term memory worth having in mind today: pinned nodes,
 * high-importance nodes and whatever the brain touched in the last two days.
 * Reads the graph from disk; the reflex must stay fast, so this is bounded.
 */
export function selectMemories(nodes: MemoryNode[], now: number, limit: number = MAX_MEMORIES, rnd: () => number = Math.random): string[] {
  const ranked = nodes
    .filter(n => n.type !== "meta" && n.content && n.strength > 0.15)
    .sort((a, b) => memoryScore(b, now) - memoryScore(a, now));
  // Pinned nodes always ride along; the rest is a fresh draw from the top pool each time.
  const pinned = ranked.filter(n => n.pinned).slice(0, Math.floor(limit / 2));
  const pool = ranked.filter(n => !n.pinned).slice(0, MEMORY_POOL);
  const picked = [...pinned, ...shuffle(pool, rnd).slice(0, Math.max(0, limit - pinned.length))];
  return picked.map(n => `[${n.type}${n.pinned ? ", vast" : ""}] ${n.content.split("\n")[0].replace(/\s+/g, " ").slice(0, MAX_MEMORY_CHARS)}`);
}

function loadMemories(now: number, rnd: () => number): string[] {
  try {
    const graph = new MemoryGraph();
    graph.load();
    return selectMemories(graph.allNodes(), now, MAX_MEMORIES, rnd);
  } catch (err) {
    log(`Could not read memory graph: ${err}`);
    return [];
  }
}

/** Collect today's brain context (pure reads; never throws). */
export function gatherMindContext(now: Date = new Date(), ownerName: string = OWNER_NAME, wmOverride?: WorkingMemory, seed: number = now.getTime()): MindContext {
  const rnd = seededRandom(seed);
  const cfg = getBrainConfig();
  const timezone = cfg.ownerTimezone;
  const { hour } = getOwnerLocalTime(timezone, now);
  const wm = wmOverride ?? loadWorkingMemory();

  let observations: Observation[] = [];
  try {
    observations = getObservationsSince(startOfOwnerDay(timezone, now), undefined, 400);
  } catch (err) {
    log(`Could not read observations: ${err}`);
  }
  const meaningful = observations.filter(o => o.text && o.text.length > 3 && !o.text.startsWith("[HOME DIGEST"));
  const recent = meaningful.slice(-MAX_OBSERVATIONS);

  const state = safeReadJSON<Partial<BrainState>>(`${BRAIN_DIR}/state.json`, {});
  const last = state.lastBrainMessage;
  const lastMessage = last && last.status !== "suppressed" && last.status !== "failed"
    ? `${new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(last.at))}: "${last.snippet}"`
    : null;

  return {
    hour,
    dateLabel: new Intl.DateTimeFormat("nl-NL", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" }).format(now),
    currentContext: wm.currentContext || "",
    mood: wm.mood || "",
    tracking: (wm.shortTermTracking || []).slice(0, MAX_TRACKING),
    followUps: (wm.pendingFollowUps || []).slice(0, MAX_FOLLOWUPS).map(f => f.targetPerson ? `${f.question} (${f.targetPerson})` : f.question),
    goals: (wm.activeGoals || []).slice(0, 5).map(g => `${g.title} (${Math.round(g.progress * 100)}%${g.deadlineStatus === "overdue" ? ", overdue" : ""})`),
    threads: (wm.conversationThreads || []).filter(t => t.status === "active").slice(0, 5).map(t => `${t.participants.join(", ")}: ${t.topic}`),
    consciousness: getConsciousnessSummary().slice(-MAX_CONSCIOUSNESS_CHARS),
    observations: recent.map(o => formatObservation(o, timezone, ownerName)),
    observationCount: meaningful.length,
    lastMessage,
    memories: loadMemories(now.getTime(), rnd),
    angle: MIND_ANGLES[Math.floor(rnd() * MIND_ANGLES.length)],
    previous: loadMindHistory().slice(-4).map(e => e.text),
  };
}

function personaLines(ownerName: string): string {
  const cfg = getBrainConfig();
  if (cfg.characterType === "custom" && cfg.characterCustomPrompt) return cfg.characterCustomPrompt;
  const preset = getCharacterPreset(cfg.characterType || "default") ?? getCharacterPreset("default");
  return preset ? preset.traits.replace(/\{owner\}/g, ownerName) : "";
}

export function buildMindPrompt(ctx: MindContext, ownerName: string): string {
  const section = (title: string, lines: string[]) => lines.length ? `${title}:\n${lines.map(l => `- ${l}`).join("\n")}` : `${title}: (niets)`;
  return `Je bent ARIA, de persoonlijke AI van ${ownerName}. ${ownerName} drukte op de "wat houdt je bezig"-knop in huis; je antwoord wordt hardop uitgesproken via een speaker in de woonkamer, dus anderen kunnen meeluisteren.

JE KARAKTER:
${personaLines(ownerName)}

Vertel in natuurlijk gesproken Nederlands wat er vandaag (${ctx.dateLabel}) door je hoofd gaat. Regels:
- Begin met "${greetingForHour(ctx.hour)} ${ownerName}." en praat daarna als jezelf, niet als een nieuwslezer.
- 3 tot 5 zinnen, maximaal ongeveer 80 woorden. Spreektaal, geen opsomming, geen emoji, geen markdown, geen cijfers met decimalen.
- Invalshoek voor deze keer: ${ctx.angle}. Kies iets dat echt de moeite waard is en dat je nog niet eerder hebt gezegd; één eigen observatie of mening mag. Leg gerust een verband met iets uit je langetermijngeheugen.
- Herhaal NIET wat je bij de vorige drukken al zei (zie EERDER GEZEGD); begin ook niet met hetzelfde onderwerp.
- Niet het weer (daar is een andere knop voor). Geen letterlijke citaten uit privéberichten van anderen; vat samen.
- Verzin niets dat niet in de gegevens staat. Als er weinig gebeurd is, zeg dat eerlijk en kort.

HUIDIGE CONTEXT: ${ctx.currentContext || "(leeg)"}
STEMMING: ${ctx.mood || "(onbekend)"}
${section("WAAR JE OP LET", ctx.tracking)}
${section("OPEN VRAGEN / OPVOLGEN", ctx.followUps)}
${section("ACTIEVE DOELEN", ctx.goals)}
${section("LOPENDE GESPREKKEN", ctx.threads)}
LAATSTE BERICHT DAT JE ZELF STUURDE: ${ctx.lastMessage ?? "(vandaag niets)"}

JE EIGEN NOTITIES (consciousness):
${ctx.consciousness || "(leeg)"}

${section("WAT JE VERDER WEET (langetermijngeheugen, belangrijkste en recentste)", ctx.memories)}

${section("EERDER GEZEGD BIJ VORIGE DRUKKEN (niet herhalen)", ctx.previous)}

VANDAAG GEZIEN (${ctx.observationCount} berichten, de laatste ${ctx.observations.length}):
${ctx.observations.length ? ctx.observations.join("\n") : "(nog niets)"}

Antwoord met alleen de gesproken tekst.`;
}

/** Deterministic fallback: honest, short, built only from structured fields. */
export function buildMindTemplate(ctx: MindContext, ownerName: string): string {
  const parts = [`${greetingForHour(ctx.hour)} ${ownerName}.`];
  if (ctx.observationCount > 0) {
    parts.push(`Vandaag heb ik ${ctx.observationCount} ${ctx.observationCount === 1 ? "bericht" : "berichten"} voorbij zien komen.`);
  } else {
    parts.push("Het is vandaag nog rustig geweest.");
  }
  if (ctx.currentContext) parts.push(`Waar ik mee bezig ben: ${ctx.currentContext.replace(/\s+/g, " ").slice(0, 160)}.`);
  if (ctx.followUps.length > 0) parts.push(`Wat nog open staat: ${ctx.followUps[0].replace(/[.?!]+$/, "")}.`);
  else if (ctx.tracking.length > 0) parts.push(`Ik houd in de gaten: ${ctx.tracking[0].replace(/[.?!]+$/, "")}.`);
  return parts.join(" ");
}

export interface MindBriefing {
  text: string;
  usedLLM: boolean;
  observationCount: number;
}

export async function composeMindBriefing(opts: {
  now?: Date;
  ownerName?: string;
  llm?: { run(prompt: string): Promise<string | null> };
  context?: MindContext;
  /** Store the result so the next briefing avoids repeating it (default true). */
  remember?: boolean;
}): Promise<MindBriefing> {
  const now = opts.now ?? new Date();
  const ownerName = opts.ownerName ?? OWNER_NAME;
  const ctx = opts.context ?? gatherMindContext(now, ownerName);

  let text: string | null = null;
  let usedLLM = false;
  if (opts.llm) {
    try {
      text = sanitizeSpokenText(await opts.llm.run(buildMindPrompt(ctx, ownerName)), MAX_SPOKEN_CHARS);
      usedLLM = text !== null;
    } catch (err) {
      log(`Mind briefing LLM failed, using template: ${err}`);
    }
  }
  const finalText = text ?? buildMindTemplate(ctx, ownerName);
  if (opts.remember !== false && usedLLM) rememberBriefing(finalText, now.getTime());
  return { text: finalText, usedLLM, observationCount: ctx.observationCount };
}
