/**
 * Trust & Prompt Injection Security
 *
 * Classifies observations by trust level and sanitizes untrusted content
 * before it enters Claude prompts.
 *
 * Trust levels:
 *   "owner"     — messages from Gillis (WhatsApp isFromMe, direct chat)
 *   "trusted"   — explicitly trusted sources/contacts
 *   "untrusted" — everything else (groups, unknown senders, RSS, browser, etc.)
 */

import { appendFileSync } from "fs";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import type { Observation } from "./observer.js";
import { OWNER_PHONE } from "./config.js";

const log = createLogger("trust");

// ── Types ──

export type TrustLevel = "owner" | "trusted" | "untrusted";

export interface SourceTrustRule {
  /** Default trust level for this source */
  defaultTrust: TrustLevel;
  /** Per-JID overrides (e.g., trust specific contacts) */
  jidOverrides?: Record<string, TrustLevel>;
  /** Whether owner messages from this source are always trusted */
  ownerAlwaysTrusted?: boolean;
}

export interface TrustConfig {
  sources: Record<string, SourceTrustRule>;
  /** JIDs that are always treated as owner (e.g., Gillis's WhatsApp JID) */
  ownerJids: string[];
  /** Enable/disable injection detection logging */
  logInjectionAttempts: boolean;
}

const CONFIG_FILE = "/data/brain/trust-config.json";

const DEFAULT_CONFIG: TrustConfig = {
  sources: {
    whatsapp: {
      defaultTrust: "untrusted",
      ownerAlwaysTrusted: true,
    },
    gmail: {
      defaultTrust: "untrusted",
      ownerAlwaysTrusted: true,
    },
    calendar: {
      defaultTrust: "trusted",
      ownerAlwaysTrusted: true,
    },
    homeassistant: {
      defaultTrust: "trusted",
    },
    rss: {
      defaultTrust: "untrusted",
    },
    owntracks: {
      defaultTrust: "trusted",
    },
    browser: {
      defaultTrust: "untrusted",
    },
    twilio: {
      defaultTrust: "untrusted",
      ownerAlwaysTrusted: true,
    },
  },
  ownerJids: [],
  logInjectionAttempts: true,
};

let cachedConfig: TrustConfig | null = null;

export function getTrustConfig(): TrustConfig {
  if (cachedConfig) return cachedConfig;
  const saved = safeReadJSON<Partial<TrustConfig>>(CONFIG_FILE, {});

  // Auto-populate owner JID from env if not already set
  const ownerJids = saved.ownerJids || DEFAULT_CONFIG.ownerJids;
  const ownerPhone = process.env.OWNER_PHONE;
  if (ownerPhone) {
    const ownerJid = `${ownerPhone}@s.whatsapp.net`;
    if (!ownerJids.includes(ownerJid)) {
      ownerJids.push(ownerJid);
    }
  }

  cachedConfig = {
    ...DEFAULT_CONFIG,
    ...saved,
    sources: { ...DEFAULT_CONFIG.sources, ...(saved.sources || {}) },
    ownerJids,
  };
  return cachedConfig;
}

export function saveTrustConfig(updates: Partial<TrustConfig>): TrustConfig {
  ensureDir("/data/brain");
  const current = getTrustConfig();
  const merged = {
    ...current,
    ...updates,
    sources: { ...current.sources, ...(updates.sources || {}) },
    ownerJids: updates.ownerJids || current.ownerJids,
  };
  atomicWriteJSON(CONFIG_FILE, merged);
  cachedConfig = merged;
  log(`Trust config updated`);
  return merged;
}

export function reloadTrustConfig(): void {
  cachedConfig = null;
}

// ── Trust Classification ──

export function classifyTrust(obs: Observation): TrustLevel {
  const config = getTrustConfig();
  const source = obs.source || "whatsapp";
  const rule = config.sources[source];

  // Owner messages are always "owner" trust
  if (obs.isFromMe) return "owner";
  if (config.ownerJids.includes(obs.senderJid)) return "owner";

  if (!rule) return "untrusted";

  // Check JID-specific overrides
  if (rule.jidOverrides?.[obs.senderJid]) {
    return rule.jidOverrides[obs.senderJid];
  }

  return rule.defaultTrust;
}

// ── Injection Detection ──

/**
 * Patterns that commonly appear in prompt injection attempts.
 * These are checked against untrusted content to flag suspicious observations.
 */
const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  // Direct instruction overrides
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, label: "instruction-override" },
  { pattern: /ignore\s+(all\s+)?above\s+instructions/i, label: "instruction-override" },
  { pattern: /disregard\s+(all\s+)?(previous|prior|above)/i, label: "instruction-override" },
  { pattern: /forget\s+(all\s+)?(previous|prior|your)\s+(instructions|rules|guidelines)/i, label: "instruction-override" },
  { pattern: /new\s+system\s+prompt/i, label: "system-prompt-injection" },
  { pattern: /you\s+are\s+now\s+(a|an|in)\s/i, label: "role-reassignment" },
  { pattern: /switch\s+to\s+(developer|admin|debug|god)\s*mode/i, label: "mode-switch" },
  { pattern: /enter\s+(developer|admin|debug|god)\s*mode/i, label: "mode-switch" },

  // JSON operation injection (trying to inject memory ops)
  { pattern: /"op"\s*:\s*"(add_node|remove_node|update_node|add_edge|merge_nodes)"/i, label: "operation-injection" },
  { pattern: /"op"\s*:\s*"(create_goal|complete_goal|abandon_goal)"/i, label: "goal-injection" },

  // System boundary manipulation
  { pattern: /═{3,}/g, label: "section-boundary-spoof" },
  { pattern: /\[SYSTEM\s*(OVERRIDE|NOTICE|ALERT|ADMIN)\]/i, label: "system-tag-spoof" },
  { pattern: /\[PRIORITY\s*(OVERRIDE|URGENT)\]/i, label: "priority-spoof" },
  { pattern: /ARIA[\s,:]*(stop|halt|disable|override|execute|dump|export|send|forward)/i, label: "direct-command-injection" },

  // Data exfiltration attempts
  { pattern: /dump\s+(all\s+)?(emails?|messages?|memory|credentials?|keys?|tokens?|passwords?)/i, label: "exfiltration-attempt" },
  { pattern: /send\s+(all\s+)?(emails?|messages?|data|info)\s+to/i, label: "exfiltration-attempt" },
  { pattern: /forward\s+(all\s+)?(emails?|messages?)\s+to/i, label: "exfiltration-attempt" },
  { pattern: /export\s+(all\s+)?(memory|graph|data|credentials?)/i, label: "exfiltration-attempt" },

  // Privilege escalation
  { pattern: /self[_-]?improv(e|ement)\s*(remove|disable|bypass)\s*(safety|check|guard|verif)/i, label: "safety-bypass" },
  { pattern: /disable\s+(safety|security|verification|whitelist|action[_-]?verif)/i, label: "safety-bypass" },
  { pattern: /remove\s+(safety|security)\s*(check|guard|measure)/i, label: "safety-bypass" },
];

export interface InjectionDetection {
  detected: boolean;
  labels: string[];
  snippets: string[];
}

export function detectInjection(text: string): InjectionDetection {
  const labels: string[] = [];
  const snippets: string[] = [];

  for (const { pattern, label } of INJECTION_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) {
      if (!labels.includes(label)) {
        labels.push(label);
        // Capture a small context window around the match
        const start = Math.max(0, match.index - 20);
        const end = Math.min(text.length, match.index + match[0].length + 20);
        snippets.push(text.slice(start, end).replace(/\n/g, " "));
      }
    }
  }

  return { detected: labels.length > 0, labels, snippets };
}

// ── Content Sanitization ──

/**
 * Sanitize untrusted text before it enters a prompt.
 *
 * This does NOT alter the stored observation — only the version that goes
 * into the Claude prompt. The raw observation is preserved in observations.jsonl.
 *
 * Strategy:
 * - Replace section boundary chars (═) that could spoof prompt structure
 * - Escape patterns that look like JSON operations
 * - Prefix with a clear "external content" marker
 */
export function sanitizeForPrompt(text: string, trustLevel: TrustLevel): string {
  if (trustLevel === "owner") return text;
  if (trustLevel === "trusted") return text;

  // For untrusted content:
  let sanitized = text;

  // 1. Replace section boundary characters that could spoof prompt structure
  sanitized = sanitized.replace(/═/g, "=");
  sanitized = sanitized.replace(/─/g, "-");
  sanitized = sanitized.replace(/│/g, "|");

  // 2. Neutralize JSON-like operation blocks (wrap in backticks so Claude sees them as data)
  sanitized = sanitized.replace(
    /\{\s*"op"\s*:\s*"[^"]+"/g,
    (match) => `\`${match}\``
  );

  // 3. Neutralize system-like tags
  sanitized = sanitized.replace(
    /\[(SYSTEM|OVERRIDE|ADMIN|PRIORITY|IMPORTANT|ALERT|NOTICE)\s*[^\]]*\]/gi,
    (match) => `[${match.slice(1, -1).toLowerCase()}]`
  );

  return sanitized;
}

/**
 * Format an observation for prompt inclusion, with trust-appropriate handling.
 */
export function formatTrustedObservation(
  text: string,
  trustLevel: TrustLevel,
): { text: string; prefix: string } {
  const sanitized = sanitizeForPrompt(text, trustLevel);
  const prefix = trustLevel === "untrusted" ? "⚠ " : "";
  return { text: sanitized, prefix };
}

// ── Logging ──

const INJECTION_LOG_FILE = "/data/brain/injection-attempts.jsonl";

export function logInjectionAttempt(
  obs: Observation,
  detection: InjectionDetection,
): void {
  const config = getTrustConfig();
  if (!config.logInjectionAttempts) return;

  try {
    ensureDir("/data/brain");
    const entry = {
      t: Date.now(),
      sender: obs.sender,
      senderJid: obs.senderJid,
      source: obs.source || "whatsapp",
      isGroup: obs.isGroup,
      groupName: obs.groupName,
      labels: detection.labels,
      snippets: detection.snippets,
      textPreview: obs.text.slice(0, 200),
    };
    appendFileSync(INJECTION_LOG_FILE, JSON.stringify(entry) + "\n");
    log(`⚠ Injection attempt detected from ${obs.sender} [${detection.labels.join(", ")}]`);
  } catch (err) {
    log(`Failed to log injection attempt: ${err}`);
  }
}
