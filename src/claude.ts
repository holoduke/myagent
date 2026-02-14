import { spawn } from "child_process";
import { getSystemPrompt } from "./system-prompt.js";

const MAX_WHATSAPP_LENGTH = 4096;

interface ClaudeResponse {
  result: string;
  is_error: boolean;
}

export async function askClaude(
  message: string,
  options: {
    timeout?: number;
    allowedTools?: string;
    conversationId?: string;
  } = {}
): Promise<string[]> {
  const timeout = options.timeout ?? Number(process.env.CLAUDE_TIMEOUT) ?? 300_000;
  const allowedTools = options.allowedTools ?? process.env.CLAUDE_ALLOWED_TOOLS ?? "Bash,Read,Edit,Glob,Grep";

  const prompt = `${getSystemPrompt()}\n\nUser message:\n${message}`;

  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--allowedTools", allowedTools,
    "--verbose",
  ];

  if (options.conversationId) {
    args.push("--resume", options.conversationId);
  }

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "", // force subscription mode
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

      if (code !== 0 && !stdout.trim()) {
        console.error("[claude] stderr:", stderr);
        reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      try {
        const response = JSON.parse(stdout) as ClaudeResponse;
        const text = response.result || "No response from Claude.";
        resolve(splitMessage(text));
      } catch {
        // If JSON parsing fails, try to use raw stdout
        const text = stdout.trim() || "No response from Claude.";
        resolve(splitMessage(text));
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
