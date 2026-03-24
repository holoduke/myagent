import type { AgentResult, ProviderAskOptions, GrokConfig } from "./types.js";
import { BaseProvider } from "./base-provider.js";
import { createLogger } from "../logger.js";

const log = createLogger("grok-provider");

// Keep recent messages for context (Grok has no session support)
interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export class GrokProvider extends BaseProvider {
  readonly name = "grok";
  readonly supportsStreaming = false;
  readonly supportsSessions = false;

  private config: GrokConfig;
  private history: HistoryEntry[] = [];
  private readonly maxHistory = 10;

  constructor(config: GrokConfig = {}) {
    super();
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

  private async runGrok(message: string, timeout: number): Promise<AgentResult> {
    const model = this.config.model || "grok-4-latest";
    const apiKey = this.config.apiKey;

    if (!apiKey) {
      throw new Error("Grok API key is required. Configure it in the agent profile.");
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
    ];

    if (this.config.maxToolRounds !== undefined) {
      args.push("--max-tool-roundtrips", String(this.config.maxToolRounds));
    }

    const startTime = Date.now();

    const { promise } = this.spawnWithTimeout({
      command: "grok",
      args,
      env: { XAI_API_KEY: apiKey },
      timeout,
    });

    const { code, stdout, stderr } = await promise;
    const durationMs = Date.now() - startTime;

    log(`Exit code: ${code}`);
    if (stderr) log(`stderr: ${stderr.slice(0, 500)}`);

    if (code !== 0 && !stdout.trim()) {
      throw new Error(`Grok exited with code ${code}: ${stderr.slice(0, 500)}`);
    }

    const text = stdout.trim() || "No response from Grok.";
    log(`Result: ${text.slice(0, 200)}`);

    // Only store real responses in history, not fallback text
    if (stdout.trim()) {
      this.history.push({ role: "user", content: message });
      this.history.push({ role: "assistant", content: text });
      if (this.history.length > this.maxHistory * 2) {
        this.history = this.history.slice(-this.maxHistory * 2);
      }
    }

    const stats = this.buildStats({
      durationMs,
      provider: "grok",
      model,
    });

    return { messages: this.splitMessage(text), stats };
  }
}
