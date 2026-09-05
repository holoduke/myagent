import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { askClaudeStreaming } from "./claude.js";
import type { SubAgentTask, SubAgentResult } from "./sub-agents.js";
import { createLogger } from "./logger.js";
import { BRAIN_DIR } from "./config.js";
import { parseLastJsonObject } from "./utils/json-extract.js";
import { validateSubAgentTools, isValidSubAgentTimeout, SUB_AGENT_MAX_TIMEOUT_MS } from "./utils/worker-sandbox.js";

const log = createLogger("sub-agent-worker");

const DEFAULT_TIMEOUT_MS = 300_000;

/** Pure: the last JSON object with our result shape, else an explicit failure. Exported for tests. */
export function parseResult(raw: string, agentId: string): SubAgentResult {
  const parsed = parseLastJsonObject(raw, p =>
    "summary" in p || ("success" in p && ("details" in p || "error" in p)),
  );
  if (parsed) {
    return {
      agentId,
      success: !!parsed.success,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      details: typeof parsed.details === "string" ? parsed.details : "",
      metrics: (parsed.metrics as SubAgentResult["metrics"]) || undefined,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      completedAt: Date.now(),
    };
  }

  // Unstructured output is a failure: we cannot tell what (if anything) the
  // agent did, and guessing "success" from action words made bad runs look good.
  return {
    agentId,
    success: false,
    summary: "Could not parse structured response",
    details: raw.slice(0, 2000),
    error: "unparseable-output",
    completedAt: Date.now(),
  };
}

function writeResult(agentId: string, result: SubAgentResult): void {
  const resultFile = `${BRAIN_DIR}/sub-agent-result-${agentId}.json`;
  try {
    writeFileSync(resultFile, JSON.stringify(result, null, 2));
    log(`Result written for ${agentId}: success=${result.success}`);
  } catch (err) {
    log(`Failed to write result for ${agentId}: ${err}`);
  }
}

function buildPrompt(task: SubAgentTask): string {
  return `You are ARIA's sub-agent "${task.name}". You are a specialized autonomous worker.

Complete the following task and provide structured results.

═══ TASK ═══

${task.prompt}

═══ INSTRUCTIONS ═══

Output ONLY a JSON object with your results (no markdown code fences):
{
  "success": true/false,
  "summary": "One-line summary",
  "details": "Full detailed report",
  "metrics": { ... optional key-value metrics ... },
  "error": null or "error message if failed"
}`;
}

/** Enforce the tool allowlist and timeout bounds even if the task file was hand-edited. */
function resolveSandbox(task: SubAgentTask): { tools: string; timeout: number } | { error: string } {
  const tools = validateSubAgentTools(task.tools);
  if (!tools.ok) return { error: tools.reason };
  const requested = task.timeout ?? DEFAULT_TIMEOUT_MS;
  const timeout = isValidSubAgentTimeout(requested) ? requested : Math.min(DEFAULT_TIMEOUT_MS, SUB_AGENT_MAX_TIMEOUT_MS);
  return { tools: tools.tools, timeout };
}

async function run(): Promise<void> {
  const agentId = process.argv[2];
  if (!agentId) {
    log("No agent ID provided, exiting");
    process.exit(1);
  }

  const taskFile = `${BRAIN_DIR}/sub-agent-task-${agentId}.json`;
  log(`Starting worker for agent ${agentId}`);

  if (!existsSync(taskFile)) {
    log(`No task file found at ${taskFile}, exiting`);
    process.exit(1);
  }

  let task: SubAgentTask;
  try {
    task = JSON.parse(readFileSync(taskFile, "utf-8"));
  } catch (err) {
    log(`Failed to read task file: ${err}`);
    process.exit(1);
  }

  log(`Task: ${task.name}`);

  const sandbox = resolveSandbox(task);
  if ("error" in sandbox) {
    log(`Refusing to run ${agentId}: ${sandbox.error}`);
    writeResult(agentId, {
      agentId,
      success: false,
      summary: `Refused: ${sandbox.error}`,
      details: "Sub-agent tools must be within the allowlist; edit the agent configuration.",
      error: sandbox.error,
      completedAt: Date.now(),
    });
  } else {
    try {
      const result = await askClaudeStreaming(buildPrompt(task), (delta) => {
        process.stdout.write(delta);
      }, {
        timeout: sandbox.timeout,
        allowedTools: sandbox.tools,
        noSession: true,
      });
      writeResult(agentId, parseResult(result.messages.join("\n"), agentId));
    } catch (err) {
      log(`Worker error for ${agentId}: ${err}`);
      writeResult(agentId, {
        agentId,
        success: false,
        summary: `Worker error: ${err}`,
        details: `${err}`,
        completedAt: Date.now(),
        error: `${err}`,
      });
    }
  }

  // Clean up task file
  try { unlinkSync(taskFile); } catch { /* expected: file may not exist */ }
  log(`Worker for ${agentId} complete`);
}

const isEntrypoint = process.argv[1]?.endsWith("sub-agent-worker.ts") || process.argv[1]?.endsWith("sub-agent-worker.js");
if (isEntrypoint) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      log(`Worker fatal error: ${err}`);
      process.exit(1);
    });
}
