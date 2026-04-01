/**
 * Action Verifier — pre-action safety gate for all outgoing actions.
 *
 * Every action (message send, scheduled message, memory operation, etc.)
 * passes through verify() before execution. Actions can be ALLOWED, BLOCKED,
 * or FLAGGED (allowed but logged for review).
 *
 * Designed to prevent:
 * - Sending messages to wrong contacts (Marvin Fles incident)
 * - Runaway memory graph growth
 * - Unsafe scheduled message payloads
 * - Rate limit circumvention
 */

import { readFileSync, existsSync, appendFileSync } from "fs";
import { ensureDir, atomicWriteFile } from "./utils/file-store.js";
import { isWhitelisted } from "./contact-whitelist.js";
import { createLogger } from "./logger.js";
import { BRAIN_DIR } from "./config.js";

const log = createLogger("verifier");


const AUDIT_LOG_FILE = `${BRAIN_DIR}/action-audit.jsonl`;
const MAX_AUDIT_LINES = 5000;

// ── Types ──

export type ActionType =
  | "send_message"        // WhatsApp message via brain tick
  | "send_scheduled"      // Scheduled message delivery
  | "send_recurring"      // Recurring task message
  | "memory_ops"          // Batch memory operations
  | "self_improve"        // Self-improvement proposal enqueue
  | "send_email";         // Email via Gmail integration

export type Verdict = "allowed" | "blocked" | "flagged";

export interface ActionContext {
  type: ActionType;
  source: string;           // "think" | "reflect" | "consolidate" | "scheduled" | "recurring" | "chat"
  targetJid?: string;       // For message actions
  messageText?: string;     // For message actions
  operationCount?: number;  // For memory_ops
  operationTypes?: string[];// For memory_ops — e.g. ["add_node", "remove_node"]
  proposalDescription?: string; // For self_improve
  metadata?: Record<string, unknown>;
}

export interface VerifyResult {
  verdict: Verdict;
  reasons: string[];
  action: ActionContext;
  timestamp: number;
}

// ── Configuration ──

interface VerifierConfig {
  /** Max memory operations in a single tick */
  maxOpsPerTick: number;
  /** Max remove_node operations in a single tick (prevent mass deletion) */
  maxRemovesPerTick: number;
  /** Max message length (chars) for proactive messages */
  maxProactiveMessageLength: number;
  /** Block messages containing these patterns (regex) */
  blockedMessagePatterns: RegExp[];
  /** Flag (but allow) messages matching these patterns */
  flaggedMessagePatterns: RegExp[];
  /** Whether to enforce whitelist checks (should always be true in prod) */
  enforceWhitelist: boolean;
  /** Max self-improve proposals per reflect tick */
  maxProposalsPerReflect: number;
}

const DEFAULT_CONFIG: VerifierConfig = {
  maxOpsPerTick: 100,
  maxRemovesPerTick: 20,
  maxProactiveMessageLength: 4000,
  blockedMessagePatterns: [],
  flaggedMessagePatterns: [
    /api[_-]?key/i,
    /password/i,
    /secret/i,
    /token/i,
    /bearer\s/i,
  ],
  enforceWhitelist: true,
  maxProposalsPerReflect: 5,
};

let config: VerifierConfig = { ...DEFAULT_CONFIG };

export function configureVerifier(overrides: Partial<VerifierConfig>): void {
  config = { ...config, ...overrides };
  log(`Verifier config updated: ${JSON.stringify(overrides)}`);
}

// ── Verification ──

export function verify(action: ActionContext): VerifyResult {
  const reasons: string[] = [];
  let verdict: Verdict = "allowed";

  switch (action.type) {
    case "send_message":
    case "send_scheduled":
    case "send_recurring":
    case "send_email":
      verifyMessage(action, reasons);
      break;
    case "memory_ops":
      verifyMemoryOps(action, reasons);
      break;
    case "self_improve":
      verifySelfImprove(action, reasons);
      break;
  }

  // Determine verdict from reasons
  if (reasons.some(r => r.startsWith("BLOCK:"))) {
    verdict = "blocked";
  } else if (reasons.some(r => r.startsWith("FLAG:"))) {
    verdict = "flagged";
  }

  const result: VerifyResult = {
    verdict,
    reasons,
    action,
    timestamp: Date.now(),
  };

  // Log to audit trail
  auditLog(result);

  if (verdict === "blocked") {
    log(`BLOCKED ${action.type} [${action.source}]: ${reasons.filter(r => r.startsWith("BLOCK:")).join("; ")}`);
  } else if (verdict === "flagged") {
    log(`FLAGGED ${action.type} [${action.source}]: ${reasons.filter(r => r.startsWith("FLAG:")).join("; ")}`);
  }

  return result;
}

// ── Message Verification ──

function verifyMessage(action: ActionContext, reasons: string[]): void {
  const jid = action.targetJid;
  const text = action.messageText || "";
  const isEmail = action.type === "send_email";

  // 1. Whitelist / recipient check
  if (isEmail) {
    // For emails: allow owner email, block unknown recipients.
    // Owner email comes from OWNER_EMAIL env, or the gmail account itself.
    const ownerEmail = process.env.OWNER_EMAIL;
    const emailAddress = jid?.replace(/^gmail:/, "") || "";
    const isOwnerEmail = ownerEmail ? emailAddress.toLowerCase() === ownerEmail.toLowerCase() : false;
    if (config.enforceWhitelist && emailAddress && !isOwnerEmail) {
      reasons.push(`BLOCK: email recipient ${emailAddress} not authorized (set OWNER_EMAIL or send to owner)`);
      return;
    }
  } else if (config.enforceWhitelist && jid && !isWhitelisted(jid)) {
    reasons.push(`BLOCK: target JID ${jid} not on whitelist`);
    return; // No need to check further
  }

  // 2. Empty message check
  if (!text.trim()) {
    reasons.push("BLOCK: empty message body");
    return;
  }

  // 3. Message length check (proactive/scheduled only, not chat responses)
  if (action.source !== "chat" && text.length > config.maxProactiveMessageLength) {
    reasons.push(`FLAG: message length ${text.length} exceeds ${config.maxProactiveMessageLength} chars`);
  }

  // 4. Blocked patterns
  for (const pattern of config.blockedMessagePatterns) {
    if (pattern.test(text)) {
      reasons.push(`BLOCK: message matches blocked pattern: ${pattern.source}`);
    }
  }

  // 5. Flagged patterns (potential secret leak)
  for (const pattern of config.flaggedMessagePatterns) {
    if (pattern.test(text)) {
      reasons.push(`FLAG: message may contain sensitive content (${pattern.source})`);
    }
  }

  // 6. JID format sanity check (skip for email actions which use gmail: prefix)
  if (!isEmail && jid && !jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@g.us")) {
    reasons.push(`BLOCK: invalid JID format: ${jid}`);
  }
}

// ── Memory Operations Verification ──

function verifyMemoryOps(action: ActionContext, reasons: string[]): void {
  const count = action.operationCount || 0;
  const types = action.operationTypes || [];

  // 1. Total operation count
  if (count > config.maxOpsPerTick) {
    reasons.push(`BLOCK: ${count} operations exceeds max ${config.maxOpsPerTick} per tick`);
  }

  // 2. Mass deletion guard
  const removeCount = types.filter(t => t === "remove_node").length;
  if (removeCount > config.maxRemovesPerTick) {
    reasons.push(`BLOCK: ${removeCount} remove_node operations exceeds max ${config.maxRemovesPerTick} per tick`);
  }

  // 3. Flag large batches even if under limit
  if (count > 50) {
    reasons.push(`FLAG: large operation batch (${count} ops)`);
  }
}

// ── Self-Improve Verification ──

function verifySelfImprove(action: ActionContext, reasons: string[]): void {
  const desc = action.proposalDescription || "";

  // 1. Empty description
  if (!desc.trim()) {
    reasons.push("BLOCK: empty improvement proposal description");
  }

  // 2. Flag proposals that touch sensitive files
  const sensitivePatterns = [
    /action-verifier/i,
    /contact-whitelist/i,
    /auth/i,
  ];
  for (const pattern of sensitivePatterns) {
    if (pattern.test(desc)) {
      reasons.push(`FLAG: improvement proposal references sensitive area (${pattern.source})`);
    }
  }
}

// ── Audit Log ──

function auditLog(result: VerifyResult): void {
  try {
    ensureDir(BRAIN_DIR);

    // Compact log entry — omit full message text for privacy, keep snippet
    const entry = {
      t: result.timestamp,
      type: result.action.type,
      src: result.action.source,
      v: result.verdict,
      jid: result.action.targetJid || undefined,
      ops: result.action.operationCount || undefined,
      reasons: result.reasons.length > 0 ? result.reasons : undefined,
      msgLen: result.action.messageText?.length || undefined,
    };

    appendFileSync(AUDIT_LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    log(`Failed to write audit log: ${err}`);
  }
}

/** Rotate audit log if it gets too large. Called during consolidation. */
export function rotateAuditLog(): void {
  try {
    if (!existsSync(AUDIT_LOG_FILE)) return;
    const content = readFileSync(AUDIT_LOG_FILE, "utf-8");
    const lines = content.trim().split("\n");
    if (lines.length <= MAX_AUDIT_LINES) return;

    // Keep the most recent half
    const keep = lines.slice(-Math.floor(MAX_AUDIT_LINES / 2));
    atomicWriteFile(AUDIT_LOG_FILE, keep.join("\n") + "\n");
    log(`Rotated audit log: ${lines.length} → ${keep.length} entries`);
  } catch (err) {
    log(`Failed to rotate audit log: ${err}`);
  }
}

/** Get recent audit entries (for dashboard/debugging). */
export function getRecentAuditEntries(limit = 50): unknown[] {
  try {
    if (!existsSync(AUDIT_LOG_FILE)) return [];
    const content = readFileSync(AUDIT_LOG_FILE, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}
