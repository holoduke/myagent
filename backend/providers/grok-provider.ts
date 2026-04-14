import type { AgentResult, AgentStats, ProviderAskOptions, GrokConfig } from "./types.js";
import { BaseProvider } from "./base-provider.js";
import { createLogger } from "../logger.js";

const log = createLogger("grok-provider");

const GROK_API_URL = "https://api.x.ai/v1/chat/completions";

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
    const model = this.config.model || "grok-3-latest";
    const apiKey = this.config.apiKey || process.env.GROK_API_KEY;

    if (!apiKey) {
      throw new Error("Grok API key is required. Set GROK_API_KEY env var or configure in agent profile.");
    }

    // Build messages array with history for context
    const messages: Array<{ role: string; content: string }> = [
      ...this.history.map(h => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(GROK_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 8192,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Grok API ${response.status}: ${body.slice(0, 500)}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const text = data.choices?.[0]?.message?.content?.trim() || "No response from Grok.";
      log(`Result: ${text.slice(0, 200)}`);

      // Store in history
      if (text !== "No response from Grok.") {
        this.history.push({ role: "user", content: message });
        this.history.push({ role: "assistant", content: text });
        if (this.history.length > this.maxHistory * 2) {
          this.history = this.history.slice(-this.maxHistory * 2);
        }
      }

      const stats: AgentStats = this.buildStats({
        durationMs,
        provider: "grok",
        model,
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      });

      return { messages: this.splitMessage(text), stats };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Grok timed out after ${timeout / 1000}s`);
      }
      throw err;
    }
  }
}
