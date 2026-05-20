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
