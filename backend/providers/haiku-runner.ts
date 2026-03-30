/**
 * Lightweight LLM runner using Claude CLI with haiku model.
 *
 * Consolidates the duplicated pattern found in message-handlers,
 * reply-agent, intent-classifier, prompt-detector, and message-evaluator.
 * No session, no tools — single prompt → JSON response.
 */

import { BaseProvider } from "./base-provider.js";
import { createLogger } from "../logger.js";

const log = createLogger("haiku-runner");

export interface HaikuRunnerOptions {
  /** Identifier used in log messages. */
  name: string;
  /** Spawn timeout in ms (default 15 000). */
  timeout?: number;
}

export class HaikuRunner extends BaseProvider {
  readonly name: string;
  readonly supportsStreaming = false;
  readonly supportsSessions = false;

  private readonly timeout: number;

  constructor(options: HaikuRunnerOptions) {
    super();
    this.name = options.name;
    this.timeout = options.timeout ?? 15_000;
  }

  // Required by BaseProvider but unused — HaikuRunner exposes `run()` instead.
  async ask(_msg: string) { return { messages: [] as string[] }; }
  async askStreaming(_msg: string, _cb: (t: string) => void) { return { messages: [] as string[] }; }
  resetSession() { /* no-op */ }

  /** Send a single prompt to haiku and return the text result (or null on failure). */
  async run(prompt: string): Promise<string | null> {
    try {
      const { promise } = this.spawnWithTimeout({
        command: "claude",
        args: ["-p", prompt, "--output-format", "json", "--model", "haiku", "--allowedTools", ""],
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
}
