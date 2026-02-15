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

export interface ClaudeResult {
  messages: string[];
  sessionId?: string;
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
  const allowedTools = options.allowedTools ?? process.env.CLAUDE_ALLOWED_TOOLS ?? "Bash,Read,Edit,Glob,Grep";

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
