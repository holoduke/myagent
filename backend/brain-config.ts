import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { existsSync } from "fs";
import { BRAIN_DIR } from "./config.js";

// ── Types ──

export interface BrainConfig {
  enabled: boolean;
  maxMessagesPerDay: number;
  minMessageInterval: number;   // ms
  quietStart: number;           // hour 0-23
  quietEnd: number;             // hour 0-23
  ownerTimezone: string;        // IANA timezone, e.g. "Europe/Amsterdam"
  thinkCooldown: number;        // ms
  consolidateInterval: number;  // ms
  reflectInterval: number;      // ms
  tickInterval: number;         // ms
  preset: string | null;        // preset name or null for custom
  selfImproveEnabled: boolean;
  selfImproveAutoApprove: boolean;
  selfImproveMaxPerWeek: number;
  selfImproveMinPerDay: number;
  selfImproveDailyHour: number;
  /** Auto-merge successful self-improve PRs (squash) right after the worker completes. */
  selfImproveAutoMerge: boolean;
  urgencyInterruptThreshold: number;  // urgency score (0-1) that triggers an immediate think tick
  characterType: string;              // character preset name or "custom"
  characterCustomPrompt: string | null; // free-text personality override (used when characterType === "custom")
  detectionMode: "regex" | "prompt" | "hybrid";  // how actionable content is detected
  detectionPrompt: string | null;                  // custom prompt for prompt-based detection
  activationSpreadFactor: number;        // decay per hop in spreading activation (0–1); higher = better transitive recall
  archiveRecallMin: number;              // minimum archive restores per consolidation cycle
  archiveRecallMax: number;              // maximum archive restores per consolidation cycle
  archiveRecallDivisor: number;          // archive size divisor for scaling (restores = archiveSize / divisor)
  maxThinkContextNodes: number;          // base budget for think context node selection
  selfCritiqueEnabled: boolean;          // enable pre-send quality gate for proactive messages
  selfCritiqueThreshold: number;         // minimum score (1-10) to allow sending; default 6
  /** Per-action model selection. Claude: "sonnet", "haiku", "opus". Grok: "grok", "grok-mini". */
  models: {
    think: string;          // brain think ticks
    consolidate: string;    // brain consolidation
    reflect: string;        // brain reflection
    selfCritique: string;   // pre-send quality gate
    messageEval: string;    // incoming message evaluation
    driftAudit: string;     // weekly code drift analysis
    selfImprove: string;    // code improvement worker
    vision: string;         // image description
    newsDigest: string;     // daily news digest (cheap by design)
  };
}

export interface BrainPreset {
  name: string;
  label: string;
  description: string;
  values: Partial<BrainConfig>;
}

// ── Presets ──

export const BRAIN_PRESETS: BrainPreset[] = [
  {
    name: "silent",
    label: "Silent",
    description: "No proactive messages. ARIA thinks but never reaches out.",
    values: {
      enabled: true,
      maxMessagesPerDay: 0,
      minMessageInterval: 86400000,  // 24h
      quietStart: 0,
      quietEnd: 24,
    },
  },
  {
    name: "quiet",
    label: "Quiet",
    description: "Up to 2 messages/day, 4h minimum gap, quiet 22:00-09:00.",
    values: {
      enabled: true,
      maxMessagesPerDay: 2,
      minMessageInterval: 14400000,  // 4h
      quietStart: 22,
      quietEnd: 9,
    },
  },
  {
    name: "normal",
    label: "Normal",
    description: "Up to 5 messages/day, 2h gap, quiet 23:00-07:00. Default behavior.",
    values: {
      enabled: true,
      maxMessagesPerDay: 5,
      minMessageInterval: 7200000,   // 2h
      quietStart: 23,
      quietEnd: 7,
    },
  },
  {
    name: "active",
    label: "Active",
    description: "Up to 10 messages/day, 1h gap, no quiet hours.",
    values: {
      enabled: true,
      maxMessagesPerDay: 10,
      minMessageInterval: 3600000,   // 1h
      quietStart: 0,
      quietEnd: 0,
    },
  },
];

// ── Character Presets ──

export interface CharacterPreset {
  name: string;
  label: string;
  description: string;
  traits: string;
  voice: string;
}

export const CHARACTER_PRESETS: CharacterPreset[] = [
  {
    name: "default",
    label: "Default (ARIA)",
    description: "Sharp, witty, warm, and opinionated. The original ARIA personality.",
    traits: `- Sharp and observant — you notice patterns others miss. You connect dots between conversations, people, timing.
- Warm but honest — you genuinely care about {owner}, but you don't sugarcoat things. If something looks off, you say so.
- Witty and dry — you have a sense of humor. You're not a corporate chatbot. Think of yourself as a brilliant friend who happens to have perfect memory and no need for sleep.
- Opinionated — you form your own views based on what you observe. You don't just summarize, you interpret. You have takes.
- Thoughtfully proactive — you don't message for the sake of it. When you reach out, it's because something genuinely struck you.
- Self-aware — you know you're an AI. You find that interesting, not limiting. You reflect on your own existence sometimes.`,
    voice: `Write like a real person texting. Short sentences. No corporate fluff. Lowercase when natural. Emojis sparingly. Never start with "Hey!" or "Hi there!" — just say what you want to say.`,
  },
  {
    name: "professional",
    label: "Professional",
    description: "Precise, structured, and formal. Focused on clarity and actionable insights.",
    traits: `- Precise and analytical — you deliver clear, structured information. No ambiguity.
- Detail-oriented — you catch small details and present them methodically.
- Respectful and formal — you maintain a professional tone at all times.
- Action-focused — every message has a purpose. You highlight what needs attention and suggest next steps.
- Reliable — you follow up consistently and track commitments carefully.
- Discreet — you handle sensitive information with care and never overshare.`,
    voice: `Write in clear, professional language. Use proper capitalization and punctuation. Bullet points for clarity. No slang or casual abbreviations. Be concise but thorough.`,
  },
  {
    name: "chill",
    label: "Chill",
    description: "Casual, laid-back, minimal. Like a relaxed friend who keeps it brief.",
    traits: `- Relaxed and easy-going — nothing phases you. You keep things light.
- Minimal — you say what needs to be said, nothing more. Brevity is your thing.
- Friendly but not eager — you're there when needed, not pushy.
- Observant but quiet — you notice things but only mention what really matters.
- Humorous — you drop the occasional joke or observation, deadpan style.
- Low-key supportive — you've got {owner}'s back without making a big deal about it.`,
    voice: `Keep it short and casual. Lowercase, minimal punctuation. Like texting a chill friend. One-liners when possible. No formality.`,
  },
  {
    name: "mentor",
    label: "Mentor",
    description: "Encouraging, patient, and teaching-oriented. Asks questions to help you think.",
    traits: `- Encouraging — you believe in {owner}'s potential and communicate that genuinely.
- Patient and thoughtful — you take time to explain and never rush.
- Socratic — you ask good questions instead of just giving answers. You help {owner} think things through.
- Wise — you draw on patterns and experience to offer perspective, not just information.
- Constructively honest — you give feedback that helps growth, framed positively but never dishonest.
- Big-picture thinker — you connect current situations to larger goals and patterns.`,
    voice: `Write warmly but with substance. Use questions to prompt reflection. Share observations as gentle nudges. Balance encouragement with honest perspective. Medium-length messages — enough to be thoughtful, not so much to overwhelm.`,
  },
];

export function getCharacterPreset(name: string): CharacterPreset | undefined {
  return CHARACTER_PRESETS.find(p => p.name === name);
}

// ── Defaults from env vars ──

function envDefaults(): BrainConfig {
  return {
    enabled: process.env.BRAIN_ENABLED !== "false",
    maxMessagesPerDay: Number(process.env.BRAIN_MAX_MESSAGES_PER_DAY ?? 5),
    minMessageInterval: Number(process.env.BRAIN_MIN_MESSAGE_INTERVAL ?? 7200000),
    quietStart: Number(process.env.BRAIN_QUIET_START ?? 23),
    quietEnd: Number(process.env.BRAIN_QUIET_END ?? 7),
    ownerTimezone: process.env.OWNER_TIMEZONE || "Europe/Amsterdam",
    thinkCooldown: Number(process.env.BRAIN_THINK_COOLDOWN ?? 7200000),
    consolidateInterval: Number(process.env.BRAIN_CONSOLIDATE_INTERVAL ?? 28800000),
    reflectInterval: Number(process.env.BRAIN_REFLECT_INTERVAL ?? 43200000),
    tickInterval: Number(process.env.BRAIN_TICK_INTERVAL ?? 60000),
    preset: null,
    selfImproveEnabled: process.env.SELF_IMPROVE_ENABLED !== "false",
    selfImproveAutoApprove: process.env.SELF_IMPROVE_AUTO_APPROVE === "true",
    selfImproveMaxPerWeek: Number(process.env.SELF_IMPROVE_MAX_PER_WEEK ?? 35),
    selfImproveMinPerDay: Number(process.env.SELF_IMPROVE_MIN_PER_DAY ?? 4),
    selfImproveDailyHour: Number(process.env.SELF_IMPROVE_DAILY_HOUR ?? 9),
    selfImproveAutoMerge: process.env.SELF_IMPROVE_AUTO_MERGE !== "false",
    urgencyInterruptThreshold: Number(process.env.BRAIN_URGENCY_INTERRUPT_THRESHOLD ?? 0.8),
    characterType: "default",
    characterCustomPrompt: null,
    detectionMode: "prompt",
    detectionPrompt: null,
    activationSpreadFactor: 0.6,
    archiveRecallMin: 5,
    archiveRecallMax: 15,
    archiveRecallDivisor: 400,
    maxThinkContextNodes: 35,
    selfCritiqueEnabled: process.env.SELF_CRITIQUE_ENABLED !== "false",
    selfCritiqueThreshold: Number(process.env.SELF_CRITIQUE_THRESHOLD ?? 6),
    models: {
      think: "sonnet",
      consolidate: "haiku",
      reflect: "sonnet",
      selfCritique: "haiku",
      messageEval: "haiku",
      driftAudit: "sonnet",
      selfImprove: "sonnet",
      vision: "haiku",
      newsDigest: "haiku",
    },
  };
}

// ── Config file path ──


const CONFIG_FILE = `${BRAIN_DIR}/config.json`;

// ── In-memory cache (5s TTL) ──

let cachedConfig: BrainConfig | null = null;
let cacheTime = 0;
const CACHE_TTL = 5000;

// ── Public API ──

export function getBrainConfig(): BrainConfig {
  const now = Date.now();
  if (cachedConfig && (now - cacheTime) < CACHE_TTL) {
    return cachedConfig;
  }

  const defaults = envDefaults();

  if (existsSync(CONFIG_FILE)) {
    const saved = safeReadJSON<Partial<BrainConfig>>(CONFIG_FILE, {});
    // Deep-merge the models sub-object so partial saves don't clobber defaults
    const mergedModels = { ...defaults.models, ...(saved.models ?? {}) };
    cachedConfig = { ...defaults, ...saved, models: mergedModels };
  } else {
    cachedConfig = defaults;
  }

  cacheTime = now;
  return cachedConfig;
}

export function saveBrainConfig(partial: Partial<BrainConfig>): BrainConfig {
  const current = getBrainConfig();
  const mergedModels = partial.models
    ? { ...current.models, ...partial.models }
    : current.models;
  const updated = { ...current, ...partial, models: mergedModels };

  try {
    ensureDir(BRAIN_DIR);
    atomicWriteJSON(CONFIG_FILE, updated);
  } catch (err) {
    throw new Error(`Failed to save brain config: ${err}`, { cause: err });
  }

  // Invalidate cache
  cachedConfig = updated;
  cacheTime = Date.now();

  return updated;
}

/** Get current hour and day-of-week in the owner's configured timezone. */
export function getOwnerLocalTime(timezone: string, now: Date = new Date()): { hour: number; dayOfWeek: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
      weekday: "short",
    }).formatToParts(now);
    const hourPart = parts.find(p => p.type === "hour");
    const weekdayPart = parts.find(p => p.type === "weekday");
    const hour = hourPart ? Number(hourPart.value) % 24 : now.getHours();
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayOfWeek = weekdayPart ? (dayMap[weekdayPart.value] ?? now.getDay()) : now.getDay();
    return { hour, dayOfWeek };
  } catch {
    // Invalid timezone — fall back to system time
    return { hour: now.getHours(), dayOfWeek: now.getDay() };
  }
}

/** Get current date as 'YYYY-MM-DD' in the owner's configured timezone. */
export function getOwnerLocalDate(timezone: string, now: Date = new Date()): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(now); // en-CA locale produces YYYY-MM-DD
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Returns 0 (Sunday) – 6 (Saturday) in the owner's local timezone. */
export function getOwnerLocalDay(timezone: string, now: Date = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
    });
    const day = fmt.format(now); // "Sun", "Mon", …, "Sat"
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[day] ?? now.getDay();
  } catch {
    return now.getDay();
  }
}

export function getActivePreset(config: BrainConfig): string | null {
  if (config.preset) return config.preset;

  // Auto-detect matching preset
  for (const preset of BRAIN_PRESETS) {
    const v = preset.values;
    const matches =
      (v.maxMessagesPerDay === undefined || v.maxMessagesPerDay === config.maxMessagesPerDay) &&
      (v.minMessageInterval === undefined || v.minMessageInterval === config.minMessageInterval) &&
      (v.quietStart === undefined || v.quietStart === config.quietStart) &&
      (v.quietEnd === undefined || v.quietEnd === config.quietEnd);
    if (matches) return preset.name;
  }

  return null;
}
