import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { askClaude } from "./claude.js";
import type { SubAgentTask, SubAgentResult } from "./sub-agents.js";
import { createLogger } from "./logger.js";

const log = createLogger("sub-agent-worker");
const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";

function parseResult(raw: string, agentId: string): SubAgentResult {
  // Try to find a JSON block that has our expected result fields (summary/success)
  // Search from the END of the response since the result JSON comes last
  const jsonBlocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (raw[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        jsonBlocks.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }

  // Search blocks from last to first — result JSON is typically at the end
  for (let i = jsonBlocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(jsonBlocks[i]);
      if ("summary" in parsed || ("success" in parsed && ("details" in parsed || "error" in parsed))) {
        return {
          agentId,
          success: !!parsed.success,
          summary: parsed.summary || "",
          details: parsed.details || "",
          metrics: parsed.metrics || undefined,
          error: parsed.error || undefined,
          completedAt: Date.now(),
        };
      }
    } catch {}
  }

  // Fallback: treat the whole response as a successful run with raw text details
  // (the agent did work, it just didn't format the output as JSON)
  const hasActionWords = /upvot|comment|post|follow|check|notif/i.test(raw);
  return {
    agentId,
    success: hasActionWords,
    summary: hasActionWords ? "Completed (unstructured response)" : "Could not parse structured response",
    details: raw.slice(0, 2000),
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

  const prompt = `You are ARIA's sub-agent "${task.name}". You are a specialized autonomous worker.

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

  try {
    const result = await askClaude(prompt, {
      timeout: task.timeout || 300_000,
      allowedTools: task.tools,
      noSession: true,
    });

    const responseText = result.messages.join("\n");
    const parsed = parseResult(responseText, agentId);
    writeResult(agentId, parsed);
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

  // Clean up task file
  try { unlinkSync(taskFile); } catch {}
  log(`Worker for ${agentId} complete`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    log(`Worker fatal error: ${err}`);
    process.exit(1);
  });
