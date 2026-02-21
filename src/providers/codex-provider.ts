import { spawn } from "child_process";
import { appendFileSync } from "fs";
import type { AIProvider, AgentResult, AgentStats, ProviderAskOptions, CodexConfig } from "./types.js";
import { splitMessage } from "./util.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  try {
    const line = `[${new Date().toISOString()}] [codex-provider] ${msg}`;
    console.log(line);
    appendFileSync(LOG_FILE, line + "\n");
  } catch { /* prevent disk errors from crashing */ }
}

export class CodexProvider implements AIProvider {
  readonly name = "codex";
  readonly supportsStreaming = true;
  readonly supportsSessions = true;

  private currentSessionId: string | null = null;
  private config: CodexConfig;

  constructor(config: CodexConfig = {}) {
    this.config = config;
  }

  resetSession(): void {
    this.currentSessionId = null;
    log("Session reset");
  }

  async ask(message: string, options: ProviderAskOptions = {}): Promise<AgentResult> {
    const timeout = options.timeout ?? this.config.timeout ?? 300_000;
    return this.runCodex(message, timeout, false, undefined);
  }

  async askStreaming(
    message: string,
    onDelta: (text: string) => void,
    options: ProviderAskOptions = {},
  ): Promise<AgentResult> {
    const timeout = options.timeout ?? this.config.timeout ?? 300_000;
    return this.runCodex(message, timeout, true, onDelta);
  }

  private runCodex(
    message: string,
    timeout: number,
    streaming: boolean,
    onDelta?: (text: string) => void,
  ): Promise<AgentResult> {
    const model = this.config.model || "o3";
    const sandbox = this.config.sandbox || "workspace-write";

    let args: string[];

    if (this.currentSessionId) {
      // Resume existing session with new message
      args = ["resume", this.currentSessionId, "--json", "-m", message];
      log(`Resuming session: ${this.currentSessionId}`);
    } else {
      // New execution
      args = [
        "exec", message,
        "--json",
        "--model", model,
        "--sandbox", sandbox,
      ];
      if (this.config.fullAuto !== false) {
        args.push("--full-auto");
      }
    }

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const child = spawn("codex", args, {
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let fullText = "";
      let sessionId: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let numTurns = 0;
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

            if (event.type === "thread.started" && event.thread_id) {
              sessionId = event.thread_id;
              this.currentSessionId = sessionId ?? null;
              log(`Thread started: ${sessionId}`);
            } else if (event.type === "item.completed" && event.item?.type === "agent_message") {
              const text = event.item.text || "";
              if (text) {
                // Each agent_message is standalone — append to full text
                if (fullText) fullText += "\n";
                fullText += text;
                if (streaming && onDelta) {
                  onDelta(text);
                }
              }
            } else if (event.type === "turn.completed" && event.usage) {
              numTurns++;
              inputTokens += event.usage.input_tokens || 0;
              outputTokens += event.usage.output_tokens || 0;
              cachedTokens += event.usage.cached_input_tokens || 0;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        this.currentSessionId = null;
        reject(new Error(`Codex timed out after ${timeout / 1000}s`));
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        const durationMs = Date.now() - startTime;
        log(`Exit code: ${code}`);
        if (stderr) log(`stderr: ${stderr.slice(0, 500)}`);

        if (!fullText && code !== 0) {
          this.currentSessionId = null;
          reject(new Error(`Codex exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }

        const text = fullText || "No response from Codex.";
        log(`Result: ${text.slice(0, 200)}`);

        const stats: AgentStats = {
          durationMs,
          totalCostUsd: 0,
          inputTokens,
          outputTokens,
          numTurns: numTurns || 1,
          provider: "codex",
          model,
          cacheReadTokens: cachedTokens,
        };

        resolve({ messages: splitMessage(text), sessionId, stats });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.stdin.end();
    });
  }
}
