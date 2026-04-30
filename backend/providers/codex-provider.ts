import type { AgentResult, AgentStats, ProviderAskOptions, CodexConfig } from "./types.js";
import { BaseProvider } from "./base-provider.js";
import { createLogger } from "../logger.js";

const log = createLogger("codex-provider");

export class CodexProvider extends BaseProvider {
  readonly name = "codex";
  readonly supportsStreaming = true;
  readonly supportsSessions = true;

  private currentSessionId: string | null = null;
  private config: CodexConfig;

  constructor(config: CodexConfig = {}) {
    super();
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

      let fullText = "";
      let sessionId: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let numTurns = 0;
      let buffer = "";
      let stderr = "";

      const { child, isTimedOut, clearTimer } = this.spawnWithTimeout({
        command: "codex",
        args,
        timeout,
        onTimeout: () => {
          this.currentSessionId = null;
          reject(new Error(`Codex timed out after ${timeout / 1000}s`));
        },
      });

      // Override default stdout collection — we parse JSON lines
      child.stdout!.removeAllListeners("data");
      child.stderr!.removeAllListeners("data");

      child.stdout!.on("data", (data: Buffer) => {
        buffer += data.toString();
        const { events, remaining } = this.parseJsonLines(buffer);
        buffer = remaining;

        for (const event of events as Record<string, unknown>[]) {
          if (event.type === "thread.started" && event.thread_id) {
            sessionId = event.thread_id as string;
            this.currentSessionId = sessionId ?? null;
            log(`Thread started: ${sessionId}`);
          } else if (event.type === "item.completed") {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "agent_message") {
              const text = (item.text as string) || "";
              if (text) {
                if (fullText) fullText += "\n";
                fullText += text;
                if (streaming && onDelta) {
                  onDelta(text);
                }
              }
            }
          } else if (event.type === "turn.completed" && event.usage) {
            numTurns++;
            const usage = event.usage as Record<string, number>;
            inputTokens += usage.input_tokens || 0;
            outputTokens += usage.output_tokens || 0;
            cachedTokens += usage.cached_input_tokens || 0;
          }
        }
      });

      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        clearTimer();
        if (isTimedOut()) return;
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

        const stats: AgentStats = this.buildStats({
          durationMs,
          provider: "codex",
          model,
          inputTokens,
          outputTokens,
          numTurns: numTurns || 1,
          cacheReadTokens: cachedTokens,
        });

        resolve({ messages: this.splitMessage(text), sessionId, stats });
      });

      child.on("error", (err) => {
        clearTimer();
        reject(err);
      });

      child.stdin!.end();
    });
  }
}
