import { spawn } from "child_process";
import { appendFileSync } from "fs";
import { getSystemPrompt, getMessageMemoryContext, resetMemoryContextTracker } from "../system-prompt.js";
import { ensureValidToken } from "../auth-refresh.js";
import type { AIProvider, AgentResult, AgentStats, ProviderAskOptions, ClaudeConfig } from "./types.js";
import { splitMessage } from "./util.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  try {
    const line = `[${new Date().toISOString()}] [claude-provider] ${msg}`;
    console.log(line);
    appendFileSync(LOG_FILE, line + "\n");
  } catch { /* prevent disk errors from crashing */ }
}

interface ClaudeResponse {
  result: string;
  is_error: boolean;
  session_id?: string;
}

export class ClaudeProvider implements AIProvider {
  readonly name = "claude";
  readonly supportsStreaming = true;
  readonly supportsSessions = true;

  private currentSessionId: string | null = null;
  private config: ClaudeConfig;

  constructor(config: ClaudeConfig = {}) {
    this.config = config;
  }

  resetSession(): void {
    this.currentSessionId = null;
    resetMemoryContextTracker();
    log("Session reset");
  }

  getSessionId(): string | null {
    return this.currentSessionId;
  }

  restoreSession(sessionId: string): void {
    this.currentSessionId = sessionId;
    log(`Session restored: ${sessionId}`);
  }

  async ask(message: string, options: ProviderAskOptions = {}): Promise<AgentResult> {
    const timeout = options.timeout ?? this.config.timeout ?? (process.env.CLAUDE_TIMEOUT ? Number(process.env.CLAUDE_TIMEOUT) : 300_000);
    const allowedTools = options.allowedTools ?? this.config.allowedTools ?? process.env.CLAUDE_ALLOWED_TOOLS ?? "Bash,Read,Write,Edit,Glob,Grep,Task,WebFetch,WebSearch,NotebookEdit";
    const noSession = options.noSession ?? false;

    await ensureValidToken();

    const result = await this.runClaude(message, { timeout, allowedTools, noSession });
    if (result.isAuthError) {
      log("Auth error detected, refreshing token and retrying...");
      await ensureValidToken();
      const retry = await this.runClaude(message, { timeout, allowedTools, noSession });
      if (retry.isAuthError) {
        throw new Error("Authentication failed after retry. OAuth tokens may need manual refresh.");
      }
      return retry;
    }
    return result;
  }

  async askStreaming(
    message: string,
    onDelta: (text: string) => void,
    options: ProviderAskOptions = {},
  ): Promise<AgentResult> {
    const timeout = options.timeout ?? this.config.timeout ?? (process.env.CLAUDE_TIMEOUT ? Number(process.env.CLAUDE_TIMEOUT) : 300_000);
    const allowedTools = options.allowedTools ?? this.config.allowedTools ?? process.env.CLAUDE_ALLOWED_TOOLS ?? "Bash,Read,Write,Edit,Glob,Grep,Task,WebFetch,WebSearch,NotebookEdit";
    const noSession = options.noSession ?? false;

    await ensureValidToken();

    const result = await this.runClaudeStreaming(message, onDelta, { timeout, allowedTools, noSession });
    if (result.isAuthError) {
      log("Auth error in streaming, refreshing token and retrying...");
      await ensureValidToken();
      const retry = await this.runClaudeStreaming(message, onDelta, { timeout, allowedTools, noSession });
      if (retry.isAuthError) {
        throw new Error("Authentication failed after retry. OAuth tokens may need manual refresh.");
      }
      return retry;
    }
    return result;
  }

  private runClaude(
    message: string,
    options: { timeout: number; allowedTools: string; noSession?: boolean },
  ): Promise<AgentResult & { isAuthError?: boolean }> {
    const { timeout, allowedTools, noSession } = options;

    let prompt: string;
    if (noSession) {
      prompt = message;
    } else if (this.currentSessionId) {
      // Resumed session: inject working memory update only if changed
      const memCtx = getMessageMemoryContext();
      prompt = memCtx ? `${memCtx}${message}` : message;
    } else {
      // First message: full system prompt with initial memory snapshot
      prompt = `${getSystemPrompt()}\n\nUser message:\n${message}`;
    }

    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--allowedTools", allowedTools,
    ];

    if (!noSession && this.currentSessionId) {
      args.push("--resume", this.currentSessionId);
      log(`Resuming session: ${this.currentSessionId}`);
    }

    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ANTHROPIC_API_KEY: "",
        CLAUDECODE: "",
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

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Don't reset session on timeout — the server-side session may still be valid
        log(`Timeout: killed process (session ${this.currentSessionId || "none"} preserved)`);
        reject(new Error(`Claude timed out after ${timeout / 1000}s`));
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        log(`Exit code: ${code}`);
        log(`stdout (${stdout.length} chars): ${stdout.slice(0, 500)}`);
        if (stderr) log(`stderr: ${stderr.slice(0, 500)}`);

        if (code !== 0 && !stdout.trim()) {
          // Only reset session for session-specific errors, not transient failures
          const isSessionError = stderr.includes("session") && (stderr.includes("not found") || stderr.includes("invalid") || stderr.includes("expired"));
          if (!noSession && this.currentSessionId && isSessionError) {
            log("Session error detected, resetting session");
            this.currentSessionId = null;
          } else if (!noSession && this.currentSessionId) {
            log(`Transient error (code ${code}), session ${this.currentSessionId} preserved`);
          }
          reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }

        try {
          const response = JSON.parse(stdout) as ClaudeResponse;
          const text = response.result || "No response from Claude.";

          if (response.is_error && text.includes("authentication_error")) {
            log("Authentication error detected in response");
            resolve({ messages: [text], isAuthError: true });
            return;
          }

          if (!noSession && !response.is_error && response.session_id) {
            this.currentSessionId = response.session_id;
            log(`Session ID: ${this.currentSessionId}`);
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

  private runClaudeStreaming(
    message: string,
    onDelta: (text: string) => void,
    options: { timeout: number; allowedTools: string; noSession?: boolean },
  ): Promise<AgentResult & { isAuthError?: boolean }> {
    const { timeout, allowedTools, noSession } = options;

    let prompt: string;
    if (noSession) {
      prompt = message;
    } else if (this.currentSessionId) {
      // Resumed session: inject working memory update only if changed
      const memCtx = getMessageMemoryContext();
      prompt = memCtx ? `${memCtx}${message}` : message;
    } else {
      // First message: full system prompt with initial memory snapshot
      prompt = `${getSystemPrompt()}\n\nUser message:\n${message}`;
    }

    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--allowedTools", allowedTools,
    ];

    if (!noSession && this.currentSessionId) {
      args.push("--resume", this.currentSessionId);
      log(`Resuming session (streaming): ${this.currentSessionId}`);
    }

    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ANTHROPIC_API_KEY: "",
        CLAUDECODE: "",
        HOME: process.env.CLAUDE_HOME || process.env.HOME || "/root",
      };

      const child = spawn("claude", args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let fullText = "";
      let sentLength = 0;
      let sessionId: string | undefined;
      let isAuthError = false;
      let stats: AgentStats | undefined;
      let buffer = "";
      let stderr = "";

      // Activity-based timeout: resets on each streaming event.
      // Uses inactivity timeout (default: timeout value) — if no events arrive within
      // the window, the process is killed. Active processes can run indefinitely.
      let timedOut = false;
      const inactivityLimit = timeout;
      let activityTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        log(`Streaming inactivity timeout (${inactivityLimit / 1000}s no activity, session ${this.currentSessionId || "none"} preserved)`);
        reject(new Error(`Claude timed out after ${inactivityLimit / 1000}s of inactivity`));
      }, inactivityLimit);

      const resetActivityTimer = () => {
        clearTimeout(activityTimer);
        if (timedOut) return;
        activityTimer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          log(`Streaming inactivity timeout (${inactivityLimit / 1000}s no activity, session ${this.currentSessionId || "none"} preserved)`);
          reject(new Error(`Claude timed out after ${inactivityLimit / 1000}s of inactivity`));
        }, inactivityLimit);
      };

      child.stdout.on("data", (data: Buffer) => {
        resetActivityTimer();
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text" && block.text) {
                  const newText = block.text;
                  if (newText.length > sentLength) {
                    const delta = newText.slice(sentLength);
                    sentLength = newText.length;
                    fullText = newText;
                    onDelta(delta);
                  }
                }
              }
            } else if (event.type === "result") {
              sessionId = event.session_id;
              const resultText = event.result || "";
              if (event.is_error && resultText.includes("authentication_error")) {
                isAuthError = true;
              } else if (!noSession && !event.is_error && sessionId) {
                this.currentSessionId = sessionId;
                log(`Session ID (streaming): ${this.currentSessionId}`);
              }
              if (resultText.length > sentLength) {
                const delta = resultText.slice(sentLength);
                sentLength = resultText.length;
                fullText = resultText;
                onDelta(delta);
              } else if (!fullText && resultText) {
                fullText = resultText;
                onDelta(resultText);
              }
              const u = event.usage || {};
              stats = {
                durationMs: event.duration_ms || 0,
                apiDurationMs: event.duration_api_ms || 0,
                totalCostUsd: event.total_cost_usd || 0,
                inputTokens: u.input_tokens || 0,
                outputTokens: u.output_tokens || 0,
                cacheReadTokens: u.cache_read_input_tokens || 0,
                cacheCreationTokens: u.cache_creation_input_tokens || 0,
                numTurns: event.num_turns || 0,
                provider: "claude",
              };
            }
          } catch {
            // Skip unparseable lines
          }
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        resetActivityTimer();
        stderr += data.toString();
      });

      child.on("close", (code) => {
        clearTimeout(activityTimer);
        if (timedOut) return;
        log(`Streaming exit code: ${code}`);
        if (stderr) log(`Streaming stderr: ${stderr.slice(0, 500)}`);

        if (isAuthError) {
          resolve({ messages: [], isAuthError: true });
          return;
        }

        if (!fullText && code !== 0) {
          // Only reset session for session-specific errors, not transient failures
          const isSessionError = stderr.includes("session") && (stderr.includes("not found") || stderr.includes("invalid") || stderr.includes("expired"));
          if (this.currentSessionId && isSessionError) {
            log("Streaming session error detected, resetting session");
            this.currentSessionId = null;
          } else if (this.currentSessionId) {
            log(`Streaming transient error (code ${code}), session ${this.currentSessionId} preserved`);
          }
          reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }

        const text = fullText || "No response from Claude.";
        log(`Streaming result: ${text.slice(0, 200)}`);
        if (stats) log(`Stats: ${stats.durationMs}ms, $${stats.totalCostUsd.toFixed(4)}, ${stats.inputTokens}in/${stats.outputTokens}out`);
        resolve({ messages: splitMessage(text), sessionId, stats });
      });

      child.on("error", (err) => {
        clearTimeout(activityTimer);
        reject(err);
      });

      child.stdin.end();
    });
  }
}
