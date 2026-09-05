/**
 * Worker sandbox utilities — containment for the self-improve / sub-agent workers.
 *
 * Rationale: the workers run Claude with Bash/Write/Edit tools and full git access.
 * The prompt contains safety rules, but prompts are advice, not gates. These helpers
 * provide three real layers of protection:
 *
 *  1. Env scrubbing — strip secrets from the child process env before spawning.
 *  2. Input validation — strict SHA validation before interpolating into shell commands.
 *  3. Post-hoc audit — a denylist of paths the worker must never modify. Called on
 *     `filesModified` reported by the worker AND verifiable against the resulting git diff.
 */

/**
 * Paths the self-improve worker must never modify.
 * These are the containment boundary: lifeline files, auth, secrets, deploy config,
 * and the sandbox itself. Patterns match paths relative to the repo root.
 */
export const WORKER_DENYLIST_PATTERNS: RegExp[] = [
  /^backend\/self-improve(-[a-z-]+)?\.ts$/,
  /^backend\/brain-workers\.ts$/,
  /^backend\/sub-agent-worker\.ts$/,
  /^backend\/utils\/worker-sandbox\.ts$/,
  /^backend\/web\/auth\.ts$/,
  /^backend\/memory\/backup\.ts$/,
  /^entrypoint\.sh$/,
  /^Dockerfile$/,
  /^\.env(\..+)?$/,
  /^\.github\/workflows\/.+$/,
];

/**
 * Env keys whose values are stripped before spawning a worker.
 * GH_TOKEN is intentionally kept so `gh pr create` works. GITHUB_REPO is public.
 */
export const WORKER_SECRET_ENV_KEYS: readonly string[] = [
  "OPENAI_API_KEY",
  "GROK_API_KEY",
  "XAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "WEB_PASSWORD",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY",
  "TWILIO_API_SECRET",
  "HOMEASSISTANT_TOKEN",
  "COOLIFY_TOKEN",
  "OWNTRACKS_PASSWORD",
];

/**
 * Return a copy of the env with secret keys removed. Does not mutate input.
 */
export function scrubWorkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of WORKER_SECRET_ENV_KEYS) {
    delete scrubbed[key];
  }
  return scrubbed;
}

/**
 * Validate a git commit SHA. Accepts 7-40 lowercase hex chars.
 * Rejects anything that could be shell-interpolated (spaces, quotes, `$`, `;`, etc.).
 */
export function isValidCommitSha(sha: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(sha);
}

/**
 * Return the subset of `files` that match the worker denylist.
 * Input paths are normalized by stripping a leading "./" but are otherwise taken as-is.
 */
export function findDenylistViolations(files: readonly string[]): string[] {
  const violations: string[] = [];
  for (const raw of files) {
    const path = raw.replace(/^\.\//, "").trim();
    if (!path) continue;
    if (WORKER_DENYLIST_PATTERNS.some(p => p.test(path))) {
      violations.push(path);
    }
  }
  return violations;
}

// ── Sub-agent tool / timeout validation ──

/** Tools a sub-agent may be granted. Anything else is rejected at the API boundary. */
export const SUB_AGENT_ALLOWED_TOOLS: readonly string[] = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch",
];

export const SUB_AGENT_MIN_TIMEOUT_MS = 30_000;          // 30 s
export const SUB_AGENT_MAX_TIMEOUT_MS = 30 * 60 * 1000;  // 30 min

export type ToolsValidation =
  | { ok: true; tools: string }
  | { ok: false; reason: string };

/**
 * Validate a comma/space-separated tool list against the allowlist.
 * Returns the normalized comma-joined list on success.
 */
export function validateSubAgentTools(tools: unknown): ToolsValidation {
  if (typeof tools !== "string") return { ok: false, reason: "tools must be a string" };
  const names = tools.split(/[\s,]+/).map(t => t.trim()).filter(t => t.length > 0);
  if (names.length === 0) return { ok: false, reason: "tools must name at least one tool" };
  const bad = names.filter(n => !SUB_AGENT_ALLOWED_TOOLS.includes(n));
  if (bad.length > 0) return { ok: false, reason: `tools not allowed: ${bad.join(", ")}` };
  return { ok: true, tools: Array.from(new Set(names)).join(",") };
}

/** True when `timeout` is a finite integer within the sub-agent bounds. */
export function isValidSubAgentTimeout(timeout: unknown): timeout is number {
  return typeof timeout === "number"
    && Number.isFinite(timeout)
    && timeout >= SUB_AGENT_MIN_TIMEOUT_MS
    && timeout <= SUB_AGENT_MAX_TIMEOUT_MS;
}

// ── Process helpers ──

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate a detached worker and everything it spawned: SIGTERM the process
 * group, then SIGKILL whatever is still alive after `graceMs`.
 * Falls back to signalling the single pid when the group is unreachable.
 * Never throws — a dead process is the desired end state.
 */
export function killProcessGroup(pid: number, graceMs = 5000): void {
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try { process.kill(pid, sig); } catch { /* already gone */ }
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => {
    if (isPidAlive(pid)) signal("SIGKILL");
  }, graceMs);
  timer.unref();
}
