/**
 * Lightweight LLM runner for single prompt → text response.
 *
 * Supports both Claude CLI models (haiku, sonnet, opus) and Grok API
 * models (grok, grok-mini). Routes automatically based on model name.
 *
 * No session, no tools — single prompt → text response.
 */

import { BaseProvider } from "./base-provider.js";
import { GrokProvider } from "./grok-provider.js";
import { createLogger } from "../logger.js";

const log = createLogger("llm-runner");

export interface LlmRunnerOptions {
  /** Identifier used in log messages. */
  name: string;
  /** Spawn timeout in ms (default 15 000). */
  timeout?: number;
  /** Model name: "haiku", "sonnet", "opus", "fable", "grok", "grok-mini" (default "haiku"). */
  model?: string;
}

/** Returns true if the model should be routed to Grok. */
export function isGrokModel(model: string | undefined): boolean {
  return !!model && model.startsWith("grok");
}

/** Map short model names to Grok API model IDs. */
export function resolveGrokModel(model: string): string {
  switch (model) {
    case "grok": return "grok-3-latest";
    case "grok-mini": return "grok-3-mini-fast";
    default: return model;
  }
}

/** Map versioned short aliases to full Claude model IDs. Returns input unchanged for bare aliases (haiku/sonnet/opus/fable). */
export function resolveClaudeModel(model: string): string {
  switch (model) {
    case "opus-4-7": return "claude-opus-4-7";
    case "sonnet-4-6": return "claude-sonnet-4-6";
    case "haiku-4-5": return "claude-haiku-4-5-20251001";
    case "fable-5": return "claude-fable-5";
    default: return model;
  }
}

export class LlmRunner extends BaseProvider {
  readonly name: string;
  readonly supportsStreaming = false;
  readonly supportsSessions = false;

  private readonly timeout: number;
  private readonly model: string;

  constructor(options: LlmRunnerOptions) {
    super();
    this.name = options.name;
    this.timeout = options.timeout ?? 15_000;
    this.model = options.model ?? "haiku";
  }

  // Required by BaseProvider but unused — LlmRunner exposes `run()` instead.
  async ask(_msg: string) { return { messages: [] as string[] }; }
  async askStreaming(_msg: string, _cb: (t: string) => void) { return { messages: [] as string[] }; }
  resetSession() { /* no-op */ }

  /** Send a single prompt and return the text result (or null on failure). */
  async run(prompt: string): Promise<string | null> {
    return isGrokModel(this.model)
      ? this.runGrok(prompt)
      : this.runClaude(prompt);
  }

  private async runClaude(prompt: string): Promise<string | null> {
    try {
      const { promise } = this.spawnWithTimeout({
        command: "claude",
        args: ["-p", prompt, "--output-format", "json", "--model", resolveClaudeModel(this.model), "--allowedTools", ""],
        env: {
          ANTHROPIC_API_KEY: "",
          CLAUDECODE: "",
          HOME: process.env.CLAUDE_HOME || process.env.HOME || "/root",
        },
        timeout: this.timeout,
        onTimeout: () => log(`${this.name} timed out`),
      });

      const { code, stdout, stderr } = await promise;

      if (code !== 0) {
        log(`${this.name} exited ${code}: ${stderr.slice(0, 200)}`);
        return null;
      }

      try {
        const resp = JSON.parse(stdout) as { result: string; is_error: boolean };
        if (resp.is_error) {
          log(`${this.name} error: ${resp.result.slice(0, 200)}`);
          return null;
        }
        return resp.result;
      } catch {
        return stdout.trim() || null;
      }
    } catch (err) {
      log(`${this.name} spawn failed: ${err}`);
      return null;
    }
  }

  /** Call xAI API via GrokProvider (single-shot, no history). */
  private async runGrok(prompt: string): Promise<string | null> {
    const apiKey = process.env.GROK_API_KEY;
    if (!apiKey) {
      log(`${this.name} skipped: GROK_API_KEY not set`);
      return null;
    }

    try {
      const provider = new GrokProvider({ apiKey, model: resolveGrokModel(this.model) });
      const result = await provider.ask(prompt, { timeout: this.timeout, noSession: true });
      return result.messages[0] ?? null;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        log(`${this.name} grok timed out`);
      } else {
        log(`${this.name} grok failed: ${err}`);
      }
      return null;
    }
  }
}

// Backward-compatible aliases
export { LlmRunner as HaikuRunner };
export type { LlmRunnerOptions as HaikuRunnerOptions };
