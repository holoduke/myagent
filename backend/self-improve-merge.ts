/**
 * Verified auto-merge for self-improve PRs.
 *
 * Every merge to main redeploys the production container (and drops the
 * WhatsApp session for a minute), and there is no CI. So before `gh pr merge`
 * we: validate the PR URL/branch, audit the REAL changed-file list against the
 * worker denylist, and run `tsc --noEmit` + `vitest run` in a throwaway
 * worktree of the PR head. Merge only when everything passes.
 *
 * Pure decision helpers live at the top and are unit-tested; the process
 * orchestration below is intentionally thin.
 */

import { spawn } from "child_process";
import { existsSync, symlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { BrainConfig } from "./brain-config.js";
import { GITHUB_REPO } from "./config.js";
import { createLogger } from "./logger.js";
import { scrubWorkerEnv, findDenylistViolations, killProcessGroup } from "./utils/worker-sandbox.js";

const log = createLogger("improve-merge");

const APP_DIR = process.env.APP_DIR || "/app";
export const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;   // hard cap for tsc + vitest together
const GH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 120_000;
export const MAX_MERGE_ATTEMPTS = 3;              // 1 initial + 2 retries
const OUTPUT_TAIL_CHARS = 1500;

// ── Pure helpers ──

/** Parse the PR number out of a URL that must point at OUR repo. */
export function parsePrNumber(prUrl: string, repo: string = GITHUB_REPO): number | null {
  if (!repo) return null;
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = prUrl.match(new RegExp(`^https://github\\.com/${escaped}/pull/(\\d+)$`));
  return match ? Number(match[1]) : null;
}

export function isAriaBranch(headRefName: string): boolean {
  return /^aria\/[A-Za-z0-9._\-/]+$/.test(headRefName);
}

/** Backoff before merge attempt `attempt` (1-based: attempt 2 waits 15 min, attempt 3 waits 60 min). */
export function mergeBackoffMs(attempt: number): number {
  const schedule = [0, 15 * 60 * 1000, 60 * 60 * 1000];
  return schedule[Math.min(Math.max(attempt - 1, 0), schedule.length - 1)];
}

export interface MergeGateInput {
  cfg: Pick<BrainConfig, "selfImproveAutoMerge" | "selfImproveMaxPerDay" | "selfImproveMinMergeIntervalMs" | "quietStart" | "quietEnd">;
  ownerHour: number;
  dailyAttempts: number;
  lastMergeAt: number;
  now: number;
  /** Recovery reverts bypass budget/quiet gates (they fix a crashing main). */
  isRecovery?: boolean;
}

export type MergeGate = { allowed: true } | { allowed: false; reason: string };

/** Decide whether a merge may happen right now. Pure. */
export function evaluateMergeGates(input: MergeGateInput): MergeGate {
  const { cfg, ownerHour, dailyAttempts, lastMergeAt, now, isRecovery } = input;
  if (!cfg.selfImproveAutoMerge) return { allowed: false, reason: "auto-merge disabled" };
  if (isRecovery) return { allowed: true };
  if (isQuietHour(ownerHour, cfg.quietStart, cfg.quietEnd)) {
    return { allowed: false, reason: `quiet hours (${cfg.quietStart}-${cfg.quietEnd}, now ${ownerHour}h)` };
  }
  if (dailyAttempts >= cfg.selfImproveMaxPerDay) {
    return { allowed: false, reason: `daily budget reached (${dailyAttempts}/${cfg.selfImproveMaxPerDay})` };
  }
  const sinceLast = now - lastMergeAt;
  if (lastMergeAt > 0 && sinceLast < cfg.selfImproveMinMergeIntervalMs) {
    const waitMin = Math.ceil((cfg.selfImproveMinMergeIntervalMs - sinceLast) / 60000);
    return { allowed: false, reason: `last merge ${Math.round(sinceLast / 60000)}m ago — wait ${waitMin}m` };
  }
  return { allowed: true };
}

/**
 * Same semantics as brain-delivery's isQuietHour, duplicated here so the
 * recovery worker (a separate process) does not import the WhatsApp stack.
 */
export function isQuietHour(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  return quietStart > quietEnd
    ? (hour >= quietStart || hour < quietEnd)
    : (hour >= quietStart && hour < quietEnd);
}

export function outputTail(text: string, chars: number = OUTPUT_TAIL_CHARS): string {
  return text.length > chars ? `…${text.slice(-chars)}` : text;
}

// ── Process helper ──

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/**
 * Run a command in its own process group with a hard timeout. Never rejects:
 * spawn errors surface as code=null + stderr.
 */
function runCommand(command: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: scrubWorkerEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessGroup(child.pid);
    }, Math.max(opts.timeoutMs, 1));
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => finish({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

/** `gh` against GITHUB_REPO with a scrubbed env. */
export function runGh(args: string[], timeoutMs: number = GH_TIMEOUT_MS): Promise<RunResult> {
  return runCommand("gh", [...args, "--repo", GITHUB_REPO], { cwd: APP_DIR, timeoutMs });
}

/** `git` in the app checkout (or `cwd`) with a scrubbed env. */
export function runGit(args: string[], cwd: string = APP_DIR, timeoutMs: number = GIT_TIMEOUT_MS): Promise<RunResult> {
  return runCommand("git", args, { cwd, timeoutMs });
}

const gh = runGh;
const git = runGit;

function describeFailure(step: string, r: RunResult): string {
  const why = r.timedOut ? "timed out" : `exit ${r.code}`;
  return `${step} ${why}:\n${outputTail(`${r.stdout}\n${r.stderr}`.trim())}`;
}

// ── PR inspection ──

export interface PrInfo { number: number; headRefName: string; state: string; files: string[] }

async function inspectPr(prNumber: number): Promise<{ ok: true; pr: PrInfo } | { ok: false; error: string }> {
  const view = await gh(["pr", "view", String(prNumber), "--json", "headRefName,state"]);
  if (view.code !== 0) return { ok: false, error: describeFailure("gh pr view", view) };
  let parsed: { headRefName?: string; state?: string };
  try {
    parsed = JSON.parse(view.stdout);
  } catch (err) {
    return { ok: false, error: `gh pr view returned unparseable JSON: ${err}` };
  }
  const headRefName = parsed.headRefName ?? "";
  const state = parsed.state ?? "";
  if (state !== "OPEN") return { ok: false, error: `PR #${prNumber} is ${state || "unknown"}, not OPEN` };
  if (!isAriaBranch(headRefName)) return { ok: false, error: `PR #${prNumber} head branch "${headRefName}" is not an aria/* branch` };

  const diff = await gh(["pr", "diff", String(prNumber), "--name-only"]);
  if (diff.code !== 0) return { ok: false, error: describeFailure("gh pr diff --name-only", diff) };
  const files = diff.stdout.split("\n").map(f => f.trim()).filter(f => f.length > 0);
  return { ok: true, pr: { number: prNumber, headRefName, state, files } };
}

// ── Worktree verification ──

async function removeWorktree(dir: string): Promise<void> {
  const rm = await git(["worktree", "remove", "--force", dir]);
  if (rm.code !== 0 && existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch (err) { log(`Failed to rm ${dir}: ${err}`); }
  }
  const prune = await git(["worktree", "prune"]);
  if (prune.code !== 0) log(`git worktree prune failed: ${outputTail(prune.stderr, 200)}`);
}

async function runChecks(dir: string, deadline: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const remaining = () => deadline - Date.now();
  if (remaining() <= 0) return { ok: false, error: "verification budget exhausted before checks started" };

  const tsc = await runCommand("npx", ["tsc", "--noEmit"], { cwd: dir, timeoutMs: remaining() });
  if (tsc.code !== 0) return { ok: false, error: describeFailure("tsc --noEmit", tsc) };

  if (remaining() <= 0) return { ok: false, error: "verification budget exhausted after tsc" };
  const vitest = await runCommand("npx", ["vitest", "run"], { cwd: dir, timeoutMs: remaining() });
  if (vitest.code !== 0) return { ok: false, error: describeFailure("vitest run", vitest) };
  return { ok: true };
}

/**
 * Check out the PR head into a clean worktree, reuse the app's node_modules,
 * and run tsc + vitest under a single deadline. Always cleans the worktree up.
 */
export async function verifyBranchInWorktree(
  branch: string,
  prNumber: number,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const dir = join(tmpdir(), `aria-verify-${prNumber}`);
  const deadline = Date.now() + timeoutMs;

  const fetch = await git(["fetch", "origin", branch]);
  if (fetch.code !== 0) return { ok: false, error: describeFailure("git fetch", fetch) };

  if (existsSync(dir)) await removeWorktree(dir);
  const add = await git(["worktree", "add", "--detach", dir, `origin/${branch}`]);
  if (add.code !== 0) return { ok: false, error: describeFailure("git worktree add", add) };

  try {
    const modules = join(APP_DIR, "node_modules");
    if (!existsSync(join(dir, "node_modules")) && existsSync(modules)) {
      symlinkSync(modules, join(dir, "node_modules"), "dir");
    }
    return await runChecks(dir, deadline);
  } catch (err) {
    return { ok: false, error: `verification setup failed: ${err}` };
  } finally {
    await removeWorktree(dir);
  }
}

// ── PR actions ──

export async function commentOnPr(prNumber: number, body: string): Promise<void> {
  const r = await gh(["pr", "comment", String(prNumber), "--body", body]);
  if (r.code !== 0) log(`gh pr comment #${prNumber} failed: ${outputTail(r.stderr, 300)}`);
}

export async function closePr(prNumber: number, comment: string): Promise<void> {
  const r = await gh(["pr", "close", String(prNumber), "--comment", comment, "--delete-branch"]);
  if (r.code !== 0) log(`gh pr close #${prNumber} failed: ${outputTail(r.stderr, 300)}`);
}

async function squashMerge(prNumber: number): Promise<{ ok: true; mergeSha: string } | { ok: false; error: string }> {
  const merge = await gh(["pr", "merge", String(prNumber), "--squash", "--delete-branch"]);
  if (merge.code !== 0) return { ok: false, error: describeFailure("gh pr merge", merge) };
  const view = await gh(["pr", "view", String(prNumber), "--json", "mergeCommit"]);
  let mergeSha = "";
  try {
    mergeSha = (JSON.parse(view.stdout) as { mergeCommit?: { oid?: string } }).mergeCommit?.oid ?? "";
  } catch (err) {
    log(`Could not read merge commit for #${prNumber}: ${err}`);
  }
  return { ok: true, mergeSha };
}

// ── Full verified path ──

export type MergeOutcome =
  | { ok: true; prNumber: number; mergeSha: string; mergedAt: number }
  | { ok: false; prNumber: number | null; error: string };

export interface VerifiedMergeOptions {
  /** Hook between verification and merge: return false to abort (e.g. item deleted meanwhile). */
  stillWanted?: () => boolean;
  verifyTimeoutMs?: number;
}

/**
 * Validate → audit → verify → merge. Failures are commented on the PR and
 * returned; the caller decides about retries/closing.
 */
export async function verifyAndMergePr(prUrl: string, opts: VerifiedMergeOptions = {}): Promise<MergeOutcome> {
  const prNumber = parsePrNumber(prUrl);
  if (prNumber === null) {
    return { ok: false, prNumber: null, error: `PR URL does not point at ${GITHUB_REPO || "(GITHUB_REPO unset)"}: ${prUrl}` };
  }

  const inspected = await inspectPr(prNumber);
  if (!inspected.ok) return { ok: false, prNumber, error: inspected.error };

  const violations = findDenylistViolations(inspected.pr.files);
  if (violations.length > 0) {
    const error = `PR touches protected files: ${violations.join(", ")}`;
    await commentOnPr(prNumber, `ARIA auto-merge refused — ${error}`);
    return { ok: false, prNumber, error };
  }

  log(`Verifying PR #${prNumber} (${inspected.pr.headRefName}, ${inspected.pr.files.length} files) in a worktree`);
  const verified = await verifyBranchInWorktree(inspected.pr.headRefName, prNumber, opts.verifyTimeoutMs);
  if (!verified.ok) {
    await commentOnPr(prNumber, `ARIA auto-merge blocked — verification failed:\n\n\`\`\`\n${verified.error}\n\`\`\``);
    return { ok: false, prNumber, error: verified.error };
  }

  if (opts.stillWanted && !opts.stillWanted()) {
    return { ok: false, prNumber, error: "merge cancelled: queue item no longer present" };
  }

  const merged = await squashMerge(prNumber);
  if (!merged.ok) {
    await commentOnPr(prNumber, `ARIA auto-merge failed:\n\n\`\`\`\n${merged.error}\n\`\`\``);
    return { ok: false, prNumber, error: merged.error };
  }
  log(`Merged PR #${prNumber} (${merged.mergeSha || "sha unknown"}) — Coolify will deploy`);
  return { ok: true, prNumber, mergeSha: merged.mergeSha, mergedAt: Date.now() };
}
