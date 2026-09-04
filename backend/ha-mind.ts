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
import type { BrainState, WorkingMemory } from "./memory/types.js";
import { greetingForHour, sanitizeSpokenText } from "./ha-weather.js";
import { createLogger } from "./logger.js";

const log = createLogger("ha-mind");

const MAX_OBSERVATIONS = 40;
const MAX_OBS_CHARS = 140;
const MAX_CONSCIOUSNESS_CHARS = 1500;
const MAX_TRACKING = 8;
const MAX_FOLLOWUPS = 6;
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

/** Collect today's brain context (pure reads; never throws). */
export function gatherMindContext(now: Date = new Date(), ownerName: string = OWNER_NAME, wmOverride?: WorkingMemory): MindContext {
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
- Kies wat echt de moeite waard is: iets dat je vandaag opviel, iets waar je mee bezig bent of over nadenkt, een open vraag of iets dat ${ownerName} nog moet doen. Eén eigen observatie of mening mag.
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
  return { text: text ?? buildMindTemplate(ctx, ownerName), usedLLM, observationCount: ctx.observationCount };
}
