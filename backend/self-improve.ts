import { randomUUID } from "crypto";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { safeReadJSON, atomicWriteJSON } from "./utils/file-store.js";
import { askClaudeStreaming } from "./claude.js";
import { getBrainConfig } from "./brain-config.js";
import { MemoryGraph } from "./memory/graph.js";
import { appendGraphOps } from "./memory/graph-inbox.js";
import { buildImprovementPrompt } from "./self-improve-prompt.js";
import type { ImprovementTask } from "./self-improve-prompt.js";
import { normalizeIntentTokens, hashIntent } from "./utils/intent-hash.js";
import { createLogger } from "./logger.js";
import { BRAIN_DIR, GITHUB_REPO } from "./config.js";
import { isValidCommitSha } from "./utils/worker-sandbox.js";
import { parseLastJsonObject } from "./utils/json-extract.js";
import { runGit, runGh, verifyAndMergePr, outputTail } from "./self-improve-merge.js";
import { getLastMerge, markShaReverted, wasShaReverted } from "./self-improve-state.js";

const log = createLogger("self-improve");

const TASK_FILE = `${BRAIN_DIR}/improve-task.json`;
const RESULT_FILE = `${BRAIN_DIR}/improve-result.json`;
const WORKER_TOOLS = "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch";

/** Whole recovery run must fit inside entrypoint.sh's `timeout` (900 s) with margin. */
const RECOVERY_BUDGET_MS = 840_000;
const RECOVERY_GIT_TIMEOUT_MS = 90_000;
const RECOVERY_LOG_SCAN = 30;

// ── Result types ──

interface ImproveResult {
  success: boolean;
  description: string;
  branch: string | null;
  prUrl: string | null;
  filesModified: string[];
  metaNodeContent: string;
  completedAt: number;
  wasRollback?: boolean;
  intent?: { summary: string; tokens: string[]; hash: string };
}

function parseIntent(raw: unknown): ImproveResult["intent"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const intent = raw as { summary?: unknown; tokens?: unknown };
  if (typeof intent.summary !== "string" || !intent.summary.trim()) return undefined;
  const rawTokens = Array.isArray(intent.tokens) ? intent.tokens : intent.summary;
  const tokens = normalizeIntentTokens(rawTokens);
  return { summary: intent.summary, tokens, hash: hashIntent(tokens) };
}

/** Pick the last balanced JSON object carrying a `success` field. Exported for tests. */
export function parseResult(raw: string): ImproveResult | null {
  const parsed = parseLastJsonObject(raw, p => "success" in p);
  if (!parsed) return null;
  const intent = parseIntent(parsed.intent);
  return {
    success: !!parsed.success,
    description: typeof parsed.description === "string" ? parsed.description : "",
    branch: typeof parsed.branch === "string" ? parsed.branch : null,
    prUrl: typeof parsed.prUrl === "string" ? parsed.prUrl : null,
    filesModified: Array.isArray(parsed.filesModified) ? parsed.filesModified.filter((f): f is string => typeof f === "string") : [],
    metaNodeContent: typeof parsed.metaNodeContent === "string" ? parsed.metaNodeContent : "",
    completedAt: Date.now(),
    wasRollback: !!parsed.wasRollback,
    ...(intent ? { intent } : {}),
  };
}

function writeResult(result: ImproveResult): void {
  try {
    atomicWriteJSON(RESULT_FILE, result);
    log(`Result written: success=${result.success}`);
  } catch (err) {
    log(`Failed to write result: ${err}`);
  }
}

function failureResult(description: string, metaNodeContent: string, wasRollback = false): ImproveResult {
  return {
    success: false,
    description,
    branch: null,
    prUrl: null,
    filesModified: [],
    metaNodeContent,
    completedAt: Date.now(),
    wasRollback,
  };
}

/**
 * The worker is not the graph's owner: it queues the meta node in the graph
 * inbox and the brain applies it at its next tick (a direct save here would be
 * refused by the generation guard whenever the brain saved in between).
 */
function addMetaNode(_graph: MemoryGraph, content: string, tags: string[]): void {
  const id = `n_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  appendGraphOps([{
    op: "add_node",
    id,
    type: "meta",
    content,
    tags: ["self-improvement", ...tags],
    strength: 0.9,
  }], "self-improve-worker");
  log(`Queued meta node ${id} for the brain`);
}

// ── Improve Mode ──

async function runImprove(): Promise<void> {
  log("Starting improve mode");

  if (!existsSync(TASK_FILE)) {
    log("No task file found, exiting");
    return;
  }

  let task: ImprovementTask | null;
  try {
    task = safeReadJSON<ImprovementTask | null>(TASK_FILE, null);
    if (!task) {
      log("Failed to read task file");
      return;
    }
  } catch (err) {
    log(`Failed to read task file: ${err}`);
    return;
  }

  log(`Task: ${task.description}`);

  // Load memory context
  const graph = new MemoryGraph();
  graph.load();
  const memoryNodes = task.memoryContext
    .map(id => graph.getNode(id))
    .filter((n): n is NonNullable<typeof n> => n !== null && n !== undefined);

  const prompt = buildImprovementPrompt(task, memoryNodes);

  try {
    const result = await askClaudeStreaming(prompt, (delta) => {
      process.stdout.write(delta);
    }, {
      timeout: 600_000,
      allowedTools: WORKER_TOOLS,
      noSession: true,
      model: getBrainConfig().models?.selfImprove,
    });

    const responseText = result.messages.join("\n");
    const parsed = parseResult(responseText);

    if (parsed) {
      writeResult(parsed);
      if (parsed.metaNodeContent) {
        addMetaNode(graph, parsed.metaNodeContent, ["improvement", parsed.success ? "success" : "failed"]);
      }
    } else {
      log("Could not parse improvement result");
      writeResult(failureResult("Failed to parse Claude response", "Self-improvement attempted but response was unparseable"));
    }
  } catch (err) {
    log(`Improve failed: ${err}`);
    writeResult(failureResult(`Error: ${err}`, `Self-improvement error: ${err}`));
  }

  // Clean up task file
  try { unlinkSync(TASK_FILE); } catch { /* expected: file may not exist */ }
  log("Improve mode complete");
}

// ── Recover Mode ──
//
// Deterministic: the container is boot-looping after a self-improve merge, so
// we revert that merge on a branch, open a PR, and push it through the same
// verified merge path. No LLM, no in-place edits of the running checkout.

/** Pure: first commit whose subject looks like a self-improve squash ("ARIA: … (#N)"). */
export function findLastSelfImproveCommit(logLines: string): { sha: string; subject: string } | null {
  for (const line of logLines.split("\n")) {
    const [sha, ...rest] = line.split("\t");
    const subject = rest.join("\t").trim();
    if (!sha || !isValidCommitSha(sha.trim())) continue;
    if (/^ARIA\b/i.test(subject)) return { sha: sha.trim(), subject };
  }
  return null;
}

/** Pure: pull the PR URL out of `gh pr create` stdout. */
export function extractPrUrl(stdout: string, repo: string = GITHUB_REPO): string | null {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stdout.match(new RegExp(`https://github\\.com/${escaped}/pull/\\d+`));
  return match ? match[0] : null;
}

async function resolveRevertTarget(): Promise<{ sha: string; label: string } | null> {
  const recorded = getLastMerge();
  if (recorded && isValidCommitSha(recorded.mergeSha)) {
    return { sha: recorded.mergeSha, label: `PR #${recorded.prNumber}` };
  }
  const fetch = await runGit(["fetch", "origin", "main"], undefined, RECOVERY_GIT_TIMEOUT_MS);
  if (fetch.code !== 0) {
    log(`git fetch failed: ${outputTail(fetch.stderr, 300)}`);
    return null;
  }
  const gitLog = await runGit(["log", "origin/main", "--format=%H%x09%s", `-n${RECOVERY_LOG_SCAN}`]);
  if (gitLog.code !== 0) {
    log(`git log failed: ${outputTail(gitLog.stderr, 300)}`);
    return null;
  }
  const found = findLastSelfImproveCommit(gitLog.stdout);
  return found ? { sha: found.sha, label: found.subject.slice(0, 80) } : null;
}

async function createRevertPr(sha: string, label: string): Promise<{ ok: true; prUrl: string; branch: string } | { ok: false; error: string }> {
  const short = sha.slice(0, 8);
  const branch = `aria/revert-${short}`;
  const dir = join(tmpdir(), `aria-recover-${short}`);
  const authorArgs = ["-c", "user.name=ARIA Recovery", "-c", "user.email=aria-recovery@users.noreply.github.com"];

  const fetch = await runGit(["fetch", "origin", "main"], undefined, RECOVERY_GIT_TIMEOUT_MS);
  if (fetch.code !== 0) return { ok: false, error: `git fetch: ${outputTail(fetch.stderr, 300)}` };

  await runGit(["worktree", "remove", "--force", dir]);
  const add = await runGit(["worktree", "add", "--detach", dir, "origin/main"]);
  if (add.code !== 0) return { ok: false, error: `git worktree add: ${outputTail(add.stderr, 300)}` };

  try {
    const steps: Array<[string, string[]]> = [
      ["git checkout -b", ["checkout", "-b", branch]],
      ["git revert", [...authorArgs, "revert", "--no-edit", sha]],
      ["git push", ["push", "--force-with-lease", "origin", branch]],
    ];
    for (const [name, args] of steps) {
      const r = await runGit(args, dir, RECOVERY_GIT_TIMEOUT_MS);
      if (r.code !== 0) return { ok: false, error: `${name}: ${outputTail(`${r.stdout}\n${r.stderr}`, 300)}` };
    }
    const pr = await runGh([
      "pr", "create",
      "--head", branch,
      "--title", `ARIA: revert ${label} (crash recovery)`,
      "--body", `Automatic crash recovery: the container boot-looped after this self-improve merge, so ARIA is reverting ${sha}.\n\nThis PR goes through the same verified merge path (tsc + vitest in a clean worktree).`,
    ]);
    const prUrl = extractPrUrl(`${pr.stdout}\n${pr.stderr}`);
    if (pr.code !== 0 || !prUrl) return { ok: false, error: `gh pr create: ${outputTail(`${pr.stdout}\n${pr.stderr}`, 300)}` };
    return { ok: true, prUrl, branch };
  } finally {
    await runGit(["worktree", "remove", "--force", dir]);
    await runGit(["worktree", "prune"]);
  }
}

async function runRecover(): Promise<void> {
  log("Starting recovery mode (deterministic revert)");
  const deadline = Date.now() + RECOVERY_BUDGET_MS;

  if (!GITHUB_REPO) {
    writeResult(failureResult("Recovery skipped: GITHUB_REPO not configured", "Crash recovery skipped: no GitHub repo configured, manual intervention needed", true));
    return;
  }

  const target = await resolveRevertTarget();
  if (!target) {
    writeResult(failureResult("Recovery found no self-improve merge to revert", "Crash recovery: no recent self-improve merge found on main, manual intervention needed", true));
    return;
  }
  if (wasShaReverted(target.sha)) {
    log(`Commit ${target.sha} already reverted by an earlier recovery run — waiting for deploy`);
    writeResult(failureResult(`Revert of ${target.sha} already in flight`, `Crash recovery: revert PR for ${target.sha.slice(0, 8)} already opened, waiting for it to deploy`, true));
    return;
  }

  log(`Reverting ${target.sha} (${target.label})`);
  const pr = await createRevertPr(target.sha, target.label);
  if (!pr.ok) {
    log(`Revert PR creation failed: ${pr.error}`);
    writeResult(failureResult(`Recovery could not open a revert PR: ${pr.error}`, "Crash recovery failed to open a revert PR, manual intervention needed", true));
    return;
  }
  markShaReverted(target.sha);
  log(`Revert PR opened: ${pr.prUrl}`);

  const remaining = deadline - Date.now();
  const merged = await verifyAndMergePr(pr.prUrl, { verifyTimeoutMs: Math.max(remaining, 60_000) });
  const base = {
    branch: pr.branch,
    prUrl: pr.prUrl,
    filesModified: [] as string[],
    completedAt: Date.now(),
    wasRollback: true,
  };
  if (merged.ok) {
    writeResult({
      ...base,
      success: true,
      description: `Reverted ${target.label} (${target.sha.slice(0, 8)}) via ${pr.prUrl}`,
      metaNodeContent: `Crash recovery: reverted self-improve merge ${target.sha.slice(0, 8)} (${target.label}); Coolify redeploys the revert`,
    });
  } else {
    writeResult({
      ...base,
      success: false,
      description: `Revert PR opened but not merged: ${merged.error.slice(0, 300)}`,
      metaNodeContent: `Crash recovery: revert PR ${pr.prUrl} needs manual merge (${merged.error.slice(0, 120)})`,
    });
  }
  log("Recovery mode complete");
}

// ── Main ──

const isEntrypoint = process.argv[1]?.endsWith("self-improve.ts") || process.argv[1]?.endsWith("self-improve.js");
if (isEntrypoint) {
  const mode = process.argv.includes("--recover") ? "recover" : "improve";
  log(`Worker started in ${mode} mode`);

  const run = mode === "recover" ? runRecover : runImprove;
  run()
    .then(() => {
      log("Worker exiting normally");
      process.exit(0);
    })
    .catch((err) => {
      log(`Worker fatal error: ${err}`);
      process.exit(1);
    });
}
