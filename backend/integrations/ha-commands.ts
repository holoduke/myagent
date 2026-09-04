/**
 * Home Assistant command queue — how ARIA acts on the house.
 *
 * dispatchCommand() sends a service call straight to Home Assistant when the
 * agent can reach it, and otherwise queues it. Home Assistant polls
 * GET /homeassistant/commands (see ha-webhook.ts) and executes whatever is
 * queued, so the house never needs an inbound port for ARIA to act.
 *
 * Only a fixed allowlist of service domains may be queued: ARIA can switch
 * lights, play audio and speak, but never unlock doors or reload the house.
 */

import { randomUUID } from "crypto";
import { FileStore } from "../utils/file-store.js";
import { createLogger } from "../logger.js";
import { callService, isHAReachableConfigured, HAClientError } from "./ha-client.js";
import type { ServiceCall } from "./ha-client.js";
import { HA_DIR } from "./ha-events.js";

const log = createLogger("ha-commands");

const QUEUE_FILE = `${HA_DIR}/commands.json`;
const MAX_HISTORY = 100;
/** Queued commands older than this are stale by the time the house pulls them. */
export const COMMAND_TTL_MS = 30 * 60 * 1000;

export const ALLOWED_SERVICE_DOMAINS = [
  "light", "switch", "scene", "script", "media_player", "tts", "notify",
  "input_boolean", "input_number", "input_select", "automation", "climate", "cover", "fan", "vacuum",
] as const;

export type CommandSource = "brain" | "reflex" | "cli" | "api";
export type CommandStatus = "queued" | "pulled" | "sent" | "failed" | "expired";

export interface HACommand {
  id: string;
  createdAt: number;
  domain: string;
  service: string;
  entityId?: string | string[];
  data?: Record<string, unknown>;
  source: CommandSource;
  status: CommandStatus;
  /** Why the command exists — shown in the dashboard and pulled by HA for logging. */
  reason?: string;
  error?: string;
  updatedAt: number;
}

interface QueueState {
  commands: HACommand[];
}

const queueStore = new FileStore<QueueState>({ filePath: QUEUE_FILE, defaultValue: { commands: [] } });

export function isAllowedServiceDomain(domain: string): boolean {
  return (ALLOWED_SERVICE_DOMAINS as readonly string[]).includes(domain);
}

/** Validate a service call from an untrusted caller (CLI/API/brain). Throws on bad input. */
export function validateServiceCall(call: ServiceCall): void {
  if (!/^[a-z_]+$/.test(call.domain)) throw new Error(`invalid service domain "${call.domain}"`);
  if (!/^[a-z0-9_]+$/.test(call.service)) throw new Error(`invalid service name "${call.service}"`);
  if (!isAllowedServiceDomain(call.domain)) {
    throw new Error(`service domain "${call.domain}" is not allowed (allowed: ${ALLOWED_SERVICE_DOMAINS.join(", ")})`);
  }
  const ids = call.entityId === undefined ? [] : Array.isArray(call.entityId) ? call.entityId : [call.entityId];
  for (const id of ids) {
    if (typeof id !== "string" || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(id)) throw new Error(`invalid entity_id "${id}"`);
  }
  if (call.data !== undefined && (typeof call.data !== "object" || call.data === null || Array.isArray(call.data))) {
    throw new Error("data must be an object");
  }
  if (call.data && JSON.stringify(call.data).length > 4096) throw new Error("data exceeds 4096 bytes");
}

function trimHistory(commands: HACommand[]): HACommand[] {
  const open = commands.filter(c => c.status === "queued");
  const closed = commands.filter(c => c.status !== "queued").slice(-MAX_HISTORY);
  return [...closed, ...open].sort((a, b) => a.createdAt - b.createdAt);
}

function persist(command: HACommand): void {
  const state = queueStore.load();
  const others = state.commands.filter(c => c.id !== command.id);
  queueStore.save({ commands: trimHistory([...others, command]) });
}

export interface DispatchResult {
  mode: "direct" | "queued";
  command: HACommand;
}

/**
 * Execute a service call now if Home Assistant is reachable, otherwise queue
 * it for the house to pull. Validation errors throw; delivery errors are
 * recorded on the command and re-thrown so callers can report them.
 */
export async function dispatchCommand(
  call: ServiceCall,
  source: CommandSource,
  reason?: string,
  now: number = Date.now(),
): Promise<DispatchResult> {
  validateServiceCall(call);
  const base: HACommand = {
    id: `hac_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
    createdAt: now,
    updatedAt: now,
    domain: call.domain,
    service: call.service,
    entityId: call.entityId,
    data: call.data,
    source,
    reason,
    status: "queued",
  };

  if (!isHAReachableConfigured()) {
    persist(base);
    log(`Queued ${call.domain}.${call.service} (${source}) — house will pull it`);
    return { mode: "queued", command: base };
  }

  try {
    await callService(call);
    const sent = { ...base, status: "sent" as const, updatedAt: Date.now() };
    persist(sent);
    return { mode: "direct", command: sent };
  } catch (err) {
    const message = err instanceof HAClientError ? err.message : String(err);
    // Direct delivery failed (house unreachable right now) — queue as fallback.
    const queued = { ...base, error: message, updatedAt: Date.now() };
    persist(queued);
    log(`Direct call failed, queued instead: ${message}`);
    return { mode: "queued", command: queued };
  }
}

/** Wire shape Home Assistant receives when it pulls the queue. */
export interface PulledCommand {
  id: string;
  service: string;          // "light.turn_on"
  target?: { entity_id: string | string[] };
  data: Record<string, unknown>;
  reason?: string;
}

export function toPulledCommand(command: HACommand): PulledCommand {
  return {
    id: command.id,
    service: `${command.domain}.${command.service}`,
    target: command.entityId ? { entity_id: command.entityId } : undefined,
    data: command.data || {},
    reason: command.reason,
  };
}

/** Hand all queued commands to the house (at-most-once) and mark them pulled. Expires stale ones. */
export function pullQueuedCommands(now: number = Date.now()): PulledCommand[] {
  const state = queueStore.load();
  const pulled: PulledCommand[] = [];
  const updated = state.commands.map(c => {
    if (c.status !== "queued") return c;
    if (now - c.createdAt > COMMAND_TTL_MS) return { ...c, status: "expired" as const, updatedAt: now };
    pulled.push(toPulledCommand(c));
    return { ...c, status: "pulled" as const, updatedAt: now };
  });
  if (pulled.length > 0 || updated.some((c, i) => c !== state.commands[i])) {
    queueStore.save({ commands: trimHistory(updated) });
  }
  if (pulled.length > 0) log(`House pulled ${pulled.length} command(s)`);
  return pulled;
}

export function getCommandQueue(): HACommand[] {
  return [...queueStore.load().commands].sort((a, b) => b.createdAt - a.createdAt);
}

export function getQueuedCount(): number {
  return queueStore.load().commands.filter(c => c.status === "queued").length;
}
