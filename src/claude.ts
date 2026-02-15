import { spawn } from "child_process";
import { appendFileSync } from "fs";
import { getSystemPrompt } from "./system-prompt.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [claude] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const MAX_WHATSAPP_LENGTH = 4096;

interface ClaudeResponse {
  result: string;
  is_error: boolean;
  session_id?: string;
}

export interface ClaudeStats {
  durationMs: number;
  apiDurationMs: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number;
}

export interface ClaudeResult {
  messages: string[];
  sessionId?: string;
  stats?: ClaudeStats;
}

// Track the current conversation session
let currentSessionId: string | null = null;

export function resetSession() {
  currentSessionId = null;
  log("Session reset");
}

export async function askClaude(
  message: string,
  options: {
    timeout?: number;
    allowedTools?: string;
  } = {}
): Promise<ClaudeResult> {
  const timeout = options.timeout ?? Number(process.env.CLAUDE_TIMEOUT) ?? 300_000;
  const allowedTools = options.allowedTools ?? process.env.CLAUDE_ALLOWED_TOOLS ?? "Bash,Read,Write,Edit,Glob,Grep,Task,WebFetch,WebSearch,NotebookEdit";

  // Retry once on auth errors (CLI auto-refreshes tokens on second attempt)
  const result = await runClaude(message, { timeout, allowedTools });
  if (result.isAuthError) {
    log("Auth error detected, retrying (CLI should auto-refresh token)...");
    const retry = await runClaude(message, { timeout, allowedTools });
    if (retry.isAuthError) {
      throw new Error("Authentication failed after retry. OAuth tokens may need manual refresh.");
    }
    return retry;
  }
  return result;
}

function runClaude(
  message: string,
  options: { timeout: number; allowedTools: string },
): Promise<ClaudeResult & { isAuthError?: boolean }> {
  const { timeout, allowedTools } = options;

  // On first message, include system prompt. On resume, just send the user message.
  const prompt = currentSessionId
    ? message
    : `${getSystemPrompt()}\n\nUser message:\n${message}`;

  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--allowedTools", allowedTools,
  ];

  if (currentSessionId) {
    args.push("--resume", currentSessionId);
    log(`Resuming session: ${currentSessionId}`);
  }

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "",  // force subscription mode
      CLAUDECODE: "",         // allow nested session
      HOME: process.env.CLAUDE_HOME || process.env.HOME || "/root",
    };

    const child = spawn("claude", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude timed out after ${timeout / 1000}s`));
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      log(`Exit code: ${code}`);
      log(`stdout (${stdout.length} chars): ${stdout.slice(0, 500)}`);
      if (stderr) log(`stderr: ${stderr.slice(0, 500)}`);

      if (code !== 0 && !stdout.trim()) {
        // If resume failed, reset session and let next message start fresh
        if (currentSessionId) {
          log("Resume failed, resetting session");
          currentSessionId = null;
        }
        reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      try {
        const response = JSON.parse(stdout) as ClaudeResponse;
        const text = response.result || "No response from Claude.";

        // Detect auth errors - don't store session and signal for retry
        if (response.is_error && text.includes("authentication_error")) {
          log("Authentication error detected in response");
          resolve({ messages: [text], isAuthError: true });
          return;
        }

        // Only store session ID from successful responses
        if (!response.is_error && response.session_id) {
          currentSessionId = response.session_id;
          log(`Session ID: ${currentSessionId}`);
        } else if (response.is_error) {
          log(`Error response, not storing session ID`);
        }

        log(`Parsed result: ${text.slice(0, 200)}`);
        resolve({ messages: splitMessage(text), sessionId: response.session_id });
      } catch {
        const text = stdout.trim() || "No response from Claude.";
        log(`JSON parse failed, using raw: ${text.slice(0, 200)}`);
        resolve({ messages: splitMessage(text) });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.end();
  });
}

export async function askClaudeStreaming(
  message: string,
  onDelta: (text: string) => void,
  options: {
    timeout?: number;
    allowedTools?: string;
  } = {}
): Promise<ClaudeResult> {
  const timeout = options.timeout ?? Number(process.env.CLAUDE_TIMEOUT) ?? 300_000;
  const allowedTools = options.allowedTools ?? process.env.CLAUDE_ALLOWED_TOOLS ?? "Bash,Read,Write,Edit,Glob,Grep,Task,WebFetch,WebSearch,NotebookEdit";

  const result = await runClaudeStreaming(message, onDelta, { timeout, allowedTools });
  if (result.isAuthError) {
    log("Auth error in streaming, retrying...");
    const retry = await runClaudeStreaming(message, onDelta, { timeout, allowedTools });
    if (retry.isAuthError) {
      throw new Error("Authentication failed after retry. OAuth tokens may need manual refresh.");
    }
    return retry;
  }
  return result;
}

function runClaudeStreaming(
  message: string,
  onDelta: (text: string) => void,
  options: { timeout: number; allowedTools: string },
): Promise<ClaudeResult & { isAuthError?: boolean }> {
  const { timeout, allowedTools } = options;

  const prompt = currentSessionId
    ? message
    : `${getSystemPrompt()}\n\nUser message:\n${message}`;

  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--allowedTools", allowedTools,
  ];

  if (currentSessionId) {
    args.push("--resume", currentSessionId);
    log(`Resuming session (streaming): ${currentSessionId}`);
  }

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      CLAUDECODE: "",
      HOME: process.env.CLAUDE_HOME || process.env.HOME || "/root",
    };

    const child = spawn("claude", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let fullText = "";
    let sessionId: string | undefined;
    let isAuthError = false;
    let stats: ClaudeStats | undefined;
    let buffer = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text" && block.text && !fullText) {
                fullText = block.text;
                onDelta(block.text);
              }
            }
          } else if (event.type === "result") {
            sessionId = event.session_id;
            const resultText = event.result || "";
            if (event.is_error && resultText.includes("authentication_error")) {
              isAuthError = true;
            } else if (!event.is_error && sessionId) {
              currentSessionId = sessionId;
              log(`Session ID (streaming): ${currentSessionId}`);
            }
            if (!fullText && resultText) {
              fullText = resultText;
              onDelta(resultText);
            }
            // Capture stats
            const u = event.usage || {};
            stats = {
              durationMs: event.duration_ms || 0,
              apiDurationMs: event.duration_api_ms || 0,
              totalCostUsd: event.total_cost_usd || 0,
              inputTokens: u.input_tokens || 0,
              outputTokens: u.output_tokens || 0,
              cacheReadTokens: u.cache_read_input_tokens || 0,
              cacheCreationTokens: u.cache_creation_input_tokens || 0,
              numTurns: event.num_turns || 0,
            };
          }
        } catch {
          // Skip unparseable lines
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude timed out after ${timeout / 1000}s`));
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      log(`Streaming exit code: ${code}`);
      if (stderr) log(`Streaming stderr: ${stderr.slice(0, 500)}`);

      if (isAuthError) {
        resolve({ messages: [], isAuthError: true });
        return;
      }

      if (!fullText && code !== 0) {
        if (currentSessionId) {
          log("Streaming resume failed, resetting session");
          currentSessionId = null;
        }
        reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      const text = fullText || "No response from Claude.";
      log(`Streaming result: ${text.slice(0, 200)}`);
      if (stats) log(`Stats: ${stats.durationMs}ms, $${stats.totalCostUsd.toFixed(4)}, ${stats.inputTokens}in/${stats.outputTokens}out`);
      resolve({ messages: splitMessage(text), sessionId, stats });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.end();
  });
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_WHATSAPP_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_WHATSAPP_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", MAX_WHATSAPP_LENGTH);
    if (splitIdx === -1 || splitIdx < MAX_WHATSAPP_LENGTH / 2) {
      // Fall back to splitting at a space
      splitIdx = remaining.lastIndexOf(" ", MAX_WHATSAPP_LENGTH);
    }
    if (splitIdx === -1 || splitIdx < MAX_WHATSAPP_LENGTH / 2) {
      // Hard split
      splitIdx = MAX_WHATSAPP_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}
