/**
 * Cognitive Health Monitoring (Research Improvement #13)
 *
 * Monitors the health of ARIA's cognitive systems: memory graph integrity,
 * response quality, API reliability. Implements circuit breakers and
 * degradation detection.
 */

import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { BRAIN_DIR } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("health");

const HEALTH_FILE = `${BRAIN_DIR}/health-state.json`;
const MAX_HISTORY = 100;

// ── Types ──

export interface HealthProbe {
  name: string;
  status: "healthy" | "degraded" | "critical";
  lastChecked: number;
  message?: string;
  value?: number;
}

export interface HealthState {
  probes: Record<string, HealthProbe>;
  circuitBreakers: Record<string, CircuitBreaker>;
  overallStatus: "healthy" | "degraded" | "critical";
  lastUpdated: number;
}

export interface CircuitBreaker {
  name: string;
  state: "closed" | "open" | "half-open";
  failureCount: number;
  lastFailure: number;
  lastSuccess: number;
  /** When in open state, don't retry until this time */
  cooldownUntil: number;
}

// ── Constants ──

const CIRCUIT_OPEN_THRESHOLD = 3;     // consecutive failures to open
const CIRCUIT_COOLDOWN_MS = 5 * 60_000; // 5 min cooldown before half-open

// ── State ──

let healthState: HealthState | null = null;

function loadHealth(): HealthState {
  if (healthState) return healthState;
  healthState = safeReadJSON<HealthState>(HEALTH_FILE, {
    probes: {},
    circuitBreakers: {},
    overallStatus: "healthy",
    lastUpdated: Date.now(),
  });
  return healthState;
}

function saveHealth(): void {
  if (!healthState) return;
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(HEALTH_FILE, healthState);
}

// ── Probes ──

/**
 * Record a health probe result.
 */
export function recordProbe(name: string, status: HealthProbe["status"], message?: string, value?: number): void {
  const h = loadHealth();
  h.probes[name] = {
    name,
    status,
    lastChecked: Date.now(),
    message,
    value,
  };
  updateOverallStatus(h);
  saveHealth();
}

/**
 * Run standard health probes on the memory graph.
 */
export function probeMemoryHealth(
  nodeCount: number,
  edgeCount: number,
  archiveCount: number,
  avgStrength: number,
): HealthProbe[] {
  const probes: HealthProbe[] = [];

  // Graph size probe (check critical first — higher threshold)
  if (nodeCount > 1800) {
    probes.push({ name: "graph_size", status: "critical", lastChecked: Date.now(), message: `${nodeCount} nodes (critical)`, value: nodeCount });
  } else if (nodeCount > 1500) {
    probes.push({ name: "graph_size", status: "degraded", lastChecked: Date.now(), message: `${nodeCount} nodes (high)`, value: nodeCount });
  } else {
    probes.push({ name: "graph_size", status: "healthy", lastChecked: Date.now(), value: nodeCount });
  }

  // Average strength probe
  if (avgStrength < 0.2) {
    probes.push({ name: "avg_strength", status: "degraded", lastChecked: Date.now(), message: `avg strength ${avgStrength.toFixed(2)} (low)`, value: avgStrength });
  } else {
    probes.push({ name: "avg_strength", status: "healthy", lastChecked: Date.now(), value: avgStrength });
  }

  // Edge-to-node ratio
  const ratio = nodeCount > 0 ? edgeCount / nodeCount : 0;
  if (ratio < 0.5) {
    probes.push({ name: "connectivity", status: "degraded", lastChecked: Date.now(), message: `Low connectivity: ${ratio.toFixed(2)} edges/node`, value: ratio });
  } else {
    probes.push({ name: "connectivity", status: "healthy", lastChecked: Date.now(), value: ratio });
  }

  // Record all probes
  const h = loadHealth();
  for (const probe of probes) {
    h.probes[probe.name] = probe;
  }
  updateOverallStatus(h);
  saveHealth();

  return probes;
}

// ── Circuit Breakers ──

export type BreakerTransition = "opened" | "closed";
type BreakerTransitionListener = (name: string, transition: BreakerTransition, at: number) => void;

const transitionListeners: BreakerTransitionListener[] = [];

/**
 * Register a listener for circuit breaker state transitions. Fires on edges
 * only: any state → open ("opened"), and open/half-open → closed ("closed")
 * — not on every success/failure. The downtime tracker uses this to record
 * degraded-service windows with exact boundaries.
 */
export function onBreakerTransition(listener: BreakerTransitionListener): void {
  transitionListeners.push(listener);
}

function emitBreakerTransition(name: string, transition: BreakerTransition): void {
  const at = Date.now();
  for (const listener of transitionListeners) {
    try {
      listener(name, transition, at);
    } catch (err) {
      log(`Breaker transition listener error (${name} ${transition}): ${err}`);
    }
  }
}

/**
 * Check if a circuit breaker allows an operation.
 */
export function isCircuitClosed(name: string): boolean {
  const h = loadHealth();
  const cb = h.circuitBreakers[name];
  if (!cb) return true; // No breaker = closed (allow)

  if (cb.state === "closed") return true;

  if (cb.state === "open" && Date.now() > cb.cooldownUntil) {
    // Transition to half-open: allow one attempt
    cb.state = "half-open";
    saveHealth();
    return true;
  }

  return cb.state === "half-open"; // half-open allows one try
}

/**
 * Read-only check whether a circuit breaker is currently in the open state.
 * Unlike isCircuitClosed(), this never transitions open → half-open, so it's
 * safe to call from passive observers (e.g. the downtime tracker heartbeat).
 */
export function isCircuitOpen(name: string): boolean {
  const cb = loadHealth().circuitBreakers[name];
  return !!cb && cb.state === "open";
}

/**
 * Record a success for a circuit breaker (resets to closed).
 */
export function circuitSuccess(name: string): void {
  const h = loadHealth();
  const cb = h.circuitBreakers[name] ?? createBreaker(name);
  const wasDegraded = cb.state !== "closed";
  cb.state = "closed";
  cb.failureCount = 0;
  cb.lastSuccess = Date.now();
  h.circuitBreakers[name] = cb;
  saveHealth();
  if (wasDegraded) emitBreakerTransition(name, "closed");
}

/**
 * Record a failure for a circuit breaker.
 */
export function circuitFailure(name: string): void {
  const h = loadHealth();
  const cb = h.circuitBreakers[name] ?? createBreaker(name);
  const wasOpen = cb.state === "open";
  cb.failureCount++;
  cb.lastFailure = Date.now();

  if (cb.failureCount >= CIRCUIT_OPEN_THRESHOLD) {
    cb.state = "open";
    cb.cooldownUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    log(`Circuit breaker OPEN: ${name} (${cb.failureCount} consecutive failures)`);
  }

  h.circuitBreakers[name] = cb;
  saveHealth();
  if (!wasOpen && cb.state === "open") emitBreakerTransition(name, "opened");
}

function createBreaker(name: string): CircuitBreaker {
  return {
    name,
    state: "closed",
    failureCount: 0,
    lastFailure: 0,
    lastSuccess: Date.now(),
    cooldownUntil: 0,
  };
}

// ── Overall Status ──

function updateOverallStatus(h: HealthState): void {
  const probeStatuses = Object.values(h.probes).map(p => p.status);
  const breakerStatuses = Object.values(h.circuitBreakers).map(b => b.state);

  if (probeStatuses.includes("critical") || breakerStatuses.filter(s => s === "open").length >= 2) {
    h.overallStatus = "critical";
  } else if (probeStatuses.includes("degraded") || breakerStatuses.includes("open")) {
    h.overallStatus = "degraded";
  } else {
    h.overallStatus = "healthy";
  }
  h.lastUpdated = Date.now();
}

// ── Prompt Summary ──

/**
 * Generate health status summary for the brain prompt.
 */
export function getHealthSummary(): string {
  const h = loadHealth();
  const parts: string[] = [`System: ${h.overallStatus}`];

  const degraded = Object.values(h.probes).filter(p => p.status !== "healthy");
  if (degraded.length > 0) {
    parts.push(`Issues: ${degraded.map(p => `${p.name}(${p.status}${p.message ? `: ${p.message}` : ""})`).join(", ")}`);
  }

  const openBreakers = Object.values(h.circuitBreakers).filter(b => b.state !== "closed");
  if (openBreakers.length > 0) {
    parts.push(`Circuit breakers: ${openBreakers.map(b => `${b.name}(${b.state})`).join(", ")}`);
  }

  return parts.join(" | ");
}

/**
 * Get the overall health status.
 */
export function getOverallStatus(): "healthy" | "degraded" | "critical" {
  return loadHealth().overallStatus;
}

/**
 * Reset health state (for testing).
 */
export function resetHealthState(): void {
  healthState = null;
}
