import { spawn, type ChildProcess } from "child_process";
import type { AIProvider, AgentResult, AgentStats, ProviderAskOptions } from "./types.js";
import { splitMessage } from "./util.js";

export { splitMessage };

export interface SpawnedProcess {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  /** Call to cancel the timeout timer (e.g. on close). */
  clearTimer: () => void;
  /** Whether the process was killed due to timeout. */
  timedOut: boolean;
}

export interface SpawnOptions {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
  timeout: number;
  onTimeout?: () => void;
}

/**
 * Abstract base class for AI provider implementations.
 *
 * Extracts shared patterns: process spawning with timeout handling,
 * stdout/stderr collection, stats helpers, and message splitting.
 * Subclasses implement provider-specific command building, output
 * parsing, and session management.
 */
export abstract class BaseProvider implements AIProvider {
  abstract readonly name: string;
  abstract readonly supportsStreaming: boolean;
  abstract readonly supportsSessions: boolean;

  abstract ask(message: string, options?: ProviderAskOptions): Promise<AgentResult>;
  abstract askStreaming(message: string, onDelta: (text: string) => void, options?: ProviderAskOptions): Promise<AgentResult>;
  abstract resetSession(): void;

  // ---------------------------------------------------------------------------
  // Shared utilities
  // ---------------------------------------------------------------------------

  /** Split text into message-sized chunks. */
  protected splitMessage(text: string): string[] {
    return splitMessage(text);
  }

  /**
   * Spawn a child process with timeout handling.
   *
   * Returns a promise that resolves when the process closes, along with
   * collected stdout/stderr. The caller can also attach their own listeners
   * to `child.stdout` / `child.stderr` before the data starts flowing
   * (the child is returned synchronously).
   */
  protected spawnWithTimeout(opts: SpawnOptions): {
    child: ChildProcess;
    promise: Promise<{ code: number | null; stdout: string; stderr: string }>;
    isTimedOut: () => boolean;
    clearTimer: () => void;
  } {
    const { command, args, env, timeout, onTimeout } = opts;

    const child = spawn(command, args, {
      env: env ? { ...process.env, ...env } : { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      onTimeout?.();
    }, timeout);

    const promise = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`${command} timed out after ${timeout / 1000}s`));
          return;
        }
        resolve({ code, stdout, stderr });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.stdin!.end();
    });

    return {
      child,
      promise,
      isTimedOut: () => timedOut,
      clearTimer: () => clearTimeout(timer),
    };
  }

  /**
   * Spawn a process with an activity-based (inactivity) timeout.
   * The timer resets every time `resetTimer()` is called. Useful
   * for streaming where long-running processes are OK as long as
   * they keep producing output.
   */
  protected spawnWithActivityTimeout(opts: SpawnOptions): {
    child: ChildProcess;
    resetTimer: () => void;
    clearTimer: () => void;
    isTimedOut: () => boolean;
  } {
    const { command, args, env, timeout, onTimeout } = opts;

    const child = spawn(command, args, {
      env: env ? { ...process.env, ...env } : { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let timedOut = false;

    const createTimer = () =>
      setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        onTimeout?.();
      }, timeout);

    let timer = createTimer();

    const resetTimer = () => {
      clearTimeout(timer);
      if (!timedOut) {
        timer = createTimer();
      }
    };

    const clearTimer = () => clearTimeout(timer);

    child.stdin!.end();

    return { child, resetTimer, clearTimer, isTimedOut: () => timedOut };
  }

  /**
   * Build a basic AgentStats object.
   */
  protected buildStats(partial: {
    durationMs: number;
    provider: string;
    model?: string;
    totalCostUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    numTurns?: number;
    apiDurationMs?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): AgentStats {
    return {
      durationMs: partial.durationMs,
      totalCostUsd: partial.totalCostUsd ?? 0,
      inputTokens: partial.inputTokens ?? 0,
      outputTokens: partial.outputTokens ?? 0,
      numTurns: partial.numTurns ?? 1,
      provider: partial.provider,
      model: partial.model,
      apiDurationMs: partial.apiDurationMs,
      cacheReadTokens: partial.cacheReadTokens,
      cacheCreationTokens: partial.cacheCreationTokens,
    };
  }

  /**
   * Parse newline-delimited JSON from a buffer, returning parsed events
   * and the remaining incomplete buffer.
   */
  protected parseJsonLines(buffer: string): { events: unknown[]; remaining: string } {
    const lines = buffer.split("\n");
    const remaining = lines.pop() || "";
    const events: unknown[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip unparseable lines
      }
    }

    return { events, remaining };
  }
}
