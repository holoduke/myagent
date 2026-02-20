import { spawn } from "child_process";
import { appendFileSync } from "fs";
import type { AIProvider, AgentResult, AgentStats, ProviderAskOptions, GrokConfig } from "./types.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [grok-provider] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const MAX_WHATSAPP_LENGTH = 4096;

// Keep recent messages for context (Grok has no session support)
interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export class GrokProvider implements AIProvider {
  readonly name = "grok";
  readonly supportsStreaming = false;
  readonly supportsSessions = false;

  private config: GrokConfig;
  private history: HistoryEntry[] = [];
  private readonly maxHistory = 10;

  constructor(config: GrokConfig = {}) {
    this.config = config;
  }

  resetSession(): void {
    this.history = [];
    log("History cleared");
  }

  async ask(message: string, options: ProviderAskOptions = {}): Promise<AgentResult> {
    const timeout = options.timeout ?? this.config.timeout ?? 300_000;
    return this.runGrok(message, timeout);
  }

  async askStreaming(
    message: string,
    onDelta: (text: string) => void,
    options: ProviderAskOptions = {},
  ): Promise<AgentResult> {
    // Grok doesn't support streaming — run blocking and emit full text
    const result = await this.ask(message, options);
    const fullText = result.messages.join("\n");
    onDelta(fullText);
    return result;
  }

  private runGrok(message: string, timeout: number): Promise<AgentResult> {
    const model = this.config.model || "grok-4-latest";
    const apiKey = this.config.apiKey;

    if (!apiKey) {
      return Promise.reject(new Error("Grok API key is required. Configure it in the agent profile."));
    }

    // Prepend recent history for context
    let prompt = message;
    if (this.history.length > 0) {
      const context = this.history
        .map(h => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
        .join("\n\n");
      prompt = `Previous conversation:\n${context}\n\nUser: ${message}`;
    }

    const args = [
      "-p", prompt,
      "-m", model,
      "-k", apiKey,
    ];

    if (this.config.maxToolRounds !== undefined) {
      args.push("--max-tool-roundtrips", String(this.config.maxToolRounds));
    }

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const child = spawn("grok", args, {
        env: { ...process.env },
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

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        reject(new Error(`Grok timed out after ${timeout / 1000}s`));
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        const durationMs = Date.now() - startTime;
        log(`Exit code: ${code}`);
        if (stderr) log(`stderr: ${stderr.slice(0, 500)}`);

        if (code !== 0 && !stdout.trim()) {
          reject(new Error(`Grok exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }

        const text = stdout.trim() || "No response from Grok.";
        log(`Result: ${text.slice(0, 200)}`);

        // Update history
        this.history.push({ role: "user", content: message });
        this.history.push({ role: "assistant", content: text });
        if (this.history.length > this.maxHistory * 2) {
          this.history = this.history.slice(-this.maxHistory * 2);
        }

        const stats: AgentStats = {
          durationMs,
          totalCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          numTurns: 1,
          provider: "grok",
          model,
        };

        resolve({ messages: splitMessage(text), stats });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.stdin.end();
    });
  }
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

    let splitIdx = remaining.lastIndexOf("\n", MAX_WHATSAPP_LENGTH);
    if (splitIdx === -1 || splitIdx < MAX_WHATSAPP_LENGTH / 2) {
      splitIdx = remaining.lastIndexOf(" ", MAX_WHATSAPP_LENGTH);
    }
    if (splitIdx === -1 || splitIdx < MAX_WHATSAPP_LENGTH / 2) {
      splitIdx = MAX_WHATSAPP_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}
