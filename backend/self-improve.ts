import { randomUUID } from "crypto";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { safeReadJSON, atomicWriteJSON } from "./utils/file-store.js";
import { execSync } from "child_process";
import { askClaude } from "./claude.js";
import { MemoryGraph } from "./memory/graph.js";
import { buildImprovementPrompt, buildRecoveryPrompt } from "./self-improve-prompt.js";
import type { ImprovementTask } from "./self-improve-prompt.js";
import { createLogger } from "./logger.js";

const log = createLogger("self-improve");

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const TASK_FILE = `${BRAIN_DIR}/improve-task.json`;
const RESULT_FILE = `${BRAIN_DIR}/improve-result.json`;
const SELF_MOD_MARKER = `${BRAIN_DIR}/self-mod-marker.json`;
const LAST_GOOD_COMMIT_FILE = `${BRAIN_DIR}/last-good-commit`;
const WORKER_TOOLS = "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch";
const MAX_RECOVERY_ATTEMPTS = 3;

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
}

function parseResult(raw: string): ImproveResult | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return {
      success: !!parsed.success,
      description: parsed.description || "",
      branch: parsed.branch || null,
      prUrl: parsed.prUrl || null,
      filesModified: Array.isArray(parsed.filesModified) ? parsed.filesModified : [],
      metaNodeContent: parsed.metaNodeContent || "",
      completedAt: Date.now(),
      wasRollback: !!parsed.wasRollback,
    };
  } catch {
    return null;
  }
}

function writeResult(result: ImproveResult): void {
  try {
    atomicWriteJSON(RESULT_FILE, result);
    log(`Result written: success=${result.success}`);
  } catch (err) {
    log(`Failed to write result: ${err}`);
  }
}

function addMetaNode(graph: MemoryGraph, content: string, tags: string[]): void {
  const id = `n_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  graph.addNode({
    id,
    type: "meta",
    content,
    tags: ["self-improvement", ...tags],
    strength: 0.9,
    pinned: false,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 1,
  });
  graph.save();
  log(`Added meta node: ${id}`);
}

// ── Improve Mode ──

async function runImprove(): Promise<void> {
  log("Starting improve mode");

  if (!existsSync(TASK_FILE)) {
    log("No task file found, exiting");
    return;
  }

  let task: ImprovementTask;
  try {
    task = safeReadJSON<ImprovementTask>(TASK_FILE, null as unknown as ImprovementTask);
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
    const result = await askClaude(prompt, {
      timeout: 600_000,
      allowedTools: WORKER_TOOLS,
      noSession: true,
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
      writeResult({
        success: false,
        description: "Failed to parse Claude response",
        branch: null,
        prUrl: null,
        filesModified: [],
        metaNodeContent: "Self-improvement attempted but response was unparseable",
        completedAt: Date.now(),
      });
    }
  } catch (err) {
    log(`Improve failed: ${err}`);
    writeResult({
      success: false,
      description: `Error: ${err}`,
      branch: null,
      prUrl: null,
      filesModified: [],
      metaNodeContent: `Self-improvement error: ${err}`,
      completedAt: Date.now(),
    });
  }

  // Clean up task file
  try { unlinkSync(TASK_FILE); } catch { /* expected: file may not exist */ }
  log("Improve mode complete");
}

// ── Recover Mode ──

async function runRecover(): Promise<void> {
  log("Starting recovery mode");

  // Read last 200 lines of log
  let logs: string;
  try {
    const fullLog = readFileSync(LOG_FILE, "utf-8");
    const lines = fullLog.split("\n");
    logs = lines.slice(-200).join("\n");
  } catch {
    logs = "(no logs available)";
  }

  // Read self-mod marker if exists
  let recentChanges: string | null = null;
  try {
    if (existsSync(SELF_MOD_MARKER)) {
      recentChanges = readFileSync(SELF_MOD_MARKER, "utf-8");
    }
  } catch { /* expected: marker file may not exist */ }

  // Read last good commit
  let lastGoodCommit: string | null = null;
  try {
    if (existsSync(LAST_GOOD_COMMIT_FILE)) {
      lastGoodCommit = readFileSync(LAST_GOOD_COMMIT_FILE, "utf-8").trim();
    }
  } catch { /* expected: commit file may not exist */ }

  for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
    log(`Recovery attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS}`);

    const prompt = buildRecoveryPrompt(logs, recentChanges, lastGoodCommit);

    try {
      const result = await askClaude(prompt, {
        timeout: 600_000,
        allowedTools: WORKER_TOOLS,
        noSession: true,
      });

      const responseText = result.messages.join("\n");
      const parsed = parseResult(responseText);

      if (parsed?.success) {
        writeResult(parsed);
        const graph = new MemoryGraph();
        graph.load();
        if (parsed.metaNodeContent) {
          addMetaNode(graph, parsed.metaNodeContent, ["recovery", "crash-fix"]);
        }
        log("Recovery successful");
        return;
      }

      // Check if compile works after the attempt
      try {
        execSync("npx tsc --noEmit", { cwd: "/app", timeout: 60_000, stdio: "pipe" });
        log("Compile check passed after recovery attempt");
        if (parsed) {
          writeResult({ ...parsed, success: true });
        }
        return;
      } catch {
        log(`Compile still failing after attempt ${attempt}`);
      }
    } catch (err) {
      log(`Recovery attempt ${attempt} error: ${err}`);
    }
  }

  // All attempts failed — rollback if possible
  if (lastGoodCommit) {
    log(`All recovery attempts failed, rolling back to ${lastGoodCommit}`);
    try {
      execSync(`git checkout ${lastGoodCommit} -- backend/ frontend/`, { cwd: "/app", timeout: 30_000, stdio: "pipe" });
      writeResult({
        success: true,
        description: `Rolled back to ${lastGoodCommit} after ${MAX_RECOVERY_ATTEMPTS} failed fix attempts`,
        branch: null,
        prUrl: null,
        filesModified: [],
        metaNodeContent: `Crash recovery: rolled back to ${lastGoodCommit} after failed fix attempts`,
        completedAt: Date.now(),
        wasRollback: true,
      });
    } catch (err) {
      log(`Rollback failed: ${err}`);
      writeResult({
        success: false,
        description: `All recovery attempts and rollback failed: ${err}`,
        branch: null,
        prUrl: null,
        filesModified: [],
        metaNodeContent: "Crash recovery completely failed, manual intervention needed",
        completedAt: Date.now(),
      });
    }
  } else {
    writeResult({
      success: false,
      description: "All recovery attempts failed, no last good commit to rollback to",
      branch: null,
      prUrl: null,
      filesModified: [],
      metaNodeContent: "Crash recovery failed: no rollback available, manual intervention needed",
      completedAt: Date.now(),
    });
  }

  log("Recovery mode complete");
}

// ── Main ──

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
