/**
 * Trusted contact directive system.
 *
 * Directives define per-contact rules for specific action types (calendar, reminder,
 * shopping, task, etc.). Each directive specifies whether ARIA should auto-execute
 * the action or require owner confirmation first.
 *
 * Works alongside contact-whitelist.ts (which has coarse-grained category permissions)
 * to provide fine-grained, per-action-type control.
 *
 * Storage: /data/brain/directives.json
 */

import { randomUUID } from "crypto";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { createLogger } from "./logger.js";

const log = createLogger("directives");

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const DIRECTIVES_FILE = `${BRAIN_DIR}/directives.json`;

/** Action types that directives can govern */
export type DirectiveActionType =
  | "calendar"
  | "reminder"
  | "shopping"
  | "task"
  | "logistics"
  | "message_relay"
  | "information";

/** Whether to auto-execute or require confirmation */
export type DirectivePolicy = "auto-execute" | "require-confirmation";

export interface Directive {
  id: string;
  /** Which contact this directive applies to (JID) */
  contactJid: string;
  /** Human-readable contact name (for display) */
  contactName: string;
  /** The action type this directive governs */
  actionType: DirectiveActionType;
  /** Auto-execute or require owner confirmation */
  policy: DirectivePolicy;
  /** Whether this directive is active */
  enabled: boolean;
  /** When this directive was created */
  createdAt: number;
  /** Optional note explaining the directive */
  note?: string;
}

// ── Write-through cache ──

let cache: Directive[] | null = null;

function load(): Directive[] {
  if (cache) return cache;
  cache = safeReadJSON<Directive[]>(DIRECTIVES_FILE, []);
  return cache;
}

function save(directives: Directive[]): void {
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(DIRECTIVES_FILE, directives);
  cache = directives;
}

// ── CRUD ──

export function getDirectives(): Directive[] {
  return load();
}

export function getDirectivesForContact(contactJid: string): Directive[] {
  return load().filter(d => d.contactJid === contactJid);
}

export function getDirective(contactJid: string, actionType: DirectiveActionType): Directive | undefined {
  return load().find(d => d.contactJid === contactJid && d.actionType === actionType && d.enabled);
}

export function addDirective(
  contactJid: string,
  contactName: string,
  actionType: DirectiveActionType,
  policy: DirectivePolicy,
  note?: string,
): Directive {
  const directives = load();

  // Replace existing directive for same contact + action type
  const existingIdx = directives.findIndex(
    d => d.contactJid === contactJid && d.actionType === actionType,
  );
  if (existingIdx >= 0) {
    directives[existingIdx].policy = policy;
    directives[existingIdx].enabled = true;
    directives[existingIdx].note = note;
    save(directives);
    log(`Updated directive for ${contactName}: ${actionType} → ${policy}`);
    return directives[existingIdx];
  }

  const directive: Directive = {
    id: `dir_${randomUUID().slice(0, 8)}`,
    contactJid,
    contactName,
    actionType,
    policy,
    enabled: true,
    createdAt: Date.now(),
    note,
  };

  directives.push(directive);
  save(directives);
  log(`Added directive for ${contactName}: ${actionType} → ${policy}`);
  return directive;
}

export function updateDirective(id: string, updates: Partial<Pick<Directive, "policy" | "enabled" | "note">>): Directive | null {
  const directives = load();
  const directive = directives.find(d => d.id === id);
  if (!directive) return null;

  if (updates.policy !== undefined) directive.policy = updates.policy;
  if (updates.enabled !== undefined) directive.enabled = updates.enabled;
  if (updates.note !== undefined) directive.note = updates.note;

  save(directives);
  log(`Updated directive ${id}: ${JSON.stringify(updates)}`);
  return directive;
}

export function removeDirective(id: string): boolean {
  const directives = load();
  const filtered = directives.filter(d => d.id !== id);
  if (filtered.length === directives.length) return false;
  save(filtered);
  log(`Removed directive ${id}`);
  return true;
}

/**
 * Resolve the policy for a contact + action type.
 * Returns the directive policy if one exists, or null if no directive covers this case.
 */
export function resolvePolicy(contactJid: string, actionType: DirectiveActionType): DirectivePolicy | null {
  const directive = getDirective(contactJid, actionType);
  return directive?.policy ?? null;
}

/**
 * Format directives as human-readable text for injection into the brain prompt.
 */
export function formatDirectivesForPrompt(): string {
  const directives = load().filter(d => d.enabled);
  if (directives.length === 0) return "";

  // Group by contact
  const byContact = new Map<string, Directive[]>();
  for (const d of directives) {
    const existing = byContact.get(d.contactName) ?? [];
    existing.push(d);
    byContact.set(d.contactName, existing);
  }

  const lines: string[] = [];
  for (const [name, dirs] of byContact) {
    const autoTypes = dirs.filter(d => d.policy === "auto-execute").map(d => d.actionType);
    const confirmTypes = dirs.filter(d => d.policy === "require-confirmation").map(d => d.actionType);
    let line = `  • ${name}: `;
    if (autoTypes.length > 0) line += `Auto-execute: ${autoTypes.join(", ")}. `;
    if (confirmTypes.length > 0) line += `Require confirmation: ${confirmTypes.join(", ")}. `;
    lines.push(line.trim());
  }

  return `\n═══ CONTACT DIRECTIVES ═══\n\nPer-contact action rules:\n\n${lines.join("\n")}\n`;
}
