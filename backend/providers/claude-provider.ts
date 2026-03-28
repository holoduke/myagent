import { getSystemPrompt, getMessageMemoryContext, resetMemoryContextTracker } from "../system-prompt.js";
import { getRecentConversationRecap } from "../history.js";
import { ensureValidToken } from "../auth-refresh.js";
import type { AIProvider, AgentResult, AgentStats, ProviderAskOptions, ClaudeConfig } from "./types.js";
import { BaseProvider } from "./base-provider.js";
import { createLogger } from "../logger.js";

const log = createLogger("claude-provider");

interface ClaudeResponse {
  result: string;
  is_error: boolean;
  session_id?: string;
}

// ── Session auto-reset thresholds (configurable via env) ──
const SESSION_MAX_COST_USD = Number(process.env.SESSION_MAX_COST_USD) || 2.0;
const SESSION_MAX_INPUT_TOKENS = Number(process.env.SESSION_MAX_INPUT_TOKENS) || 100_000;
const SESSION_MAX_TURNS = Number(process.env.SESSION_MAX_TURNS) || 30;

interface SessionStats {
  cumulativeCostUsd: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  turnCount: number;
  startedAt: number;
}

function freshSessionStats(): SessionStats {
  return {
    cumulativeCostUsd: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    turnCount: 0,
    startedAt: Date.now(),
  };
}

export class ClaudeProvider extends BaseProvider {
  readonly name = "claude";
  readonly supportsStreaming = true;
  readonly supportsSessions = true;

  private currentSessionId: string | null = null;
  private config: ClaudeConfig;
  private sessionStats: SessionStats = freshSessionStats();
  private needsConversationRecap = false;

  constructor(config: ClaudeConfig = {}) {
    super();
    this.config = config;
  }

  resetSession(): void {
    this.currentSessionId = null;
    this.sessionStats = freshSessionStats();
    this.needsConversationRecap = false;
    resetMemoryContextTracker();
    log("Session reset");
  }

  getSessionId(): string | null {
    return this.currentSessionId;
  }

  getSessionStats(): Readonly<SessionStats> {
    return this.sessionStats;
  }

  restoreSession(sessionId: string): void {
    this.currentSessionId = sessionId;
    log(`Session restored: ${sessionId}`);
  }

  /** Check if session exceeds thresholds and auto-reset if so. */
  private checkAutoReset(): void {
    const s = this.sessionStats;
    const reasons: string[] = [];

    if (s.cumulativeCostUsd >= SESSION_MAX_COST_USD) {
      reasons.push(`cost $${s.cumulativeCostUsd.toFixed(4)} >= $${SESSION_MAX_COST_USD}`);
    }
    if (s.cumulativeInputTokens >= SESSION_MAX_INPUT_TOKENS) {
      reasons.push(`input tokens ${s.cumulativeInputTokens.toLocaleString()} >= ${SESSION_MAX_INPUT_TOKENS.toLocaleString()}`);
    }
    if (s.turnCount >= SESSION_MAX_TURNS) {
      reasons.push(`turns ${s.turnCount} >= ${SESSION_MAX_TURNS}`);
    }

    if (reasons.length > 0) {
      log(`Auto-reset: ${reasons.join(", ")} (session ${this.currentSessionId})`);
      this.currentSessionId = null;
      this.sessionStats = freshSessionStats();
      this.needsConversationRecap = true;
      resetMemoryContextTracker();
    }
  }

  /** Accumulate stats from a completed response. */
  private accumulateStats(stats?: AgentStats): void {
    if (!stats) return;
    this.sessionStats.cumulativeCostUsd += stats.totalCostUsd;
    this.sessionStats.cumulativeInputTokens += stats.inputTokens;
    this.sessionStats.cumulativeOutputTokens += stats.outputTokens;
    this.sessionStats.turnCount += 1;
  }

  async ask(message: string, options: ProviderAskOptions = {}): Promise<AgentResult> {
    const timeout = options.timeout ?? this.config.timeout ?? (process.env.CLAUDE_TIMEOUT ? Number(process.env.CLAUDE_TIMEOUT) : 120_000);
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
      if (!noSession) {
        this.accumulateStats(retry.stats);
        this.checkAutoReset();
      }
      return retry;
    }
    if (!noSession) {
      this.accumulateStats(result.stats);
      this.checkAutoReset();
    }
    return result;
  }

  async askStreaming(
    message: string,
    onDelta: (text: string) => void,
    options: ProviderAskOptions = {},
  ): Promise<AgentResult> {
    const timeout = options.timeout ?? this.config.timeout ?? (process.env.CLAUDE_TIMEOUT ? Number(process.env.CLAUDE_TIMEOUT) : 120_000);
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
      if (!noSession) {
        this.accumulateStats(retry.stats);
        this.checkAutoReset();
      }
      return retry;
    }
    if (!noSession) {
      this.accumulateStats(result.stats);
      this.checkAutoReset();
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private buildPrompt(message: string, noSession: boolean): string {
    if (noSession) {
      return message;
    }
    if (this.currentSessionId) {
      // Resumed session: inject working memory update only if changed
      const memCtx = getMessageMemoryContext();
      return memCtx ? `${memCtx}${message}` : message;
    }
    // First message: full system prompt with initial memory snapshot
    // Include conversation recap if session was auto-compacted
    const recap = this.needsConversationRecap ? getRecentConversationRecap() : "";
    this.needsConversationRecap = false;
    return `${getSystemPrompt()}${recap}\n\nUser message:\n${message}`;
  }

  private get claudeEnv(): Record<string, string> {
    return {
      ANTHROPIC_API_KEY: "",
      CLAUDECODE: "",
      HOME: process.env.CLAUDE_HOME || process.env.HOME || "/root",
    };
  }

  private handleSessionError(stderr: string, noSession: boolean, context: string): void {
    const isSessionError = stderr.includes("session") && (stderr.includes("not found") || stderr.includes("invalid") || stderr.includes("expired"));
    if (!noSession && this.currentSessionId && isSessionError) {
      log(`${context} session error detected, resetting session`);
      this.currentSessionId = null;
    } else if (!noSession && this.currentSessionId) {
      log(`${context} transient error, session ${this.currentSessionId} preserved`);
    }
  }

  // ---------------------------------------------------------------------------
  // Non-streaming execution
  // ---------------------------------------------------------------------------

  private runClaude(
    message: string,
    options: { timeout: number; allowedTools: string; noSession?: boolean },
  ): Promise<AgentResult & { isAuthError?: boolean }> {
    const { timeout, allowedTools, noSession } = options;

    const prompt = this.buildPrompt(message, noSession ?? false);

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
      const { promise } = this.spawnWithTimeout({
        command: "claude",
        args,
        env: this.claudeEnv,
        timeout,
        onTimeout: () => {
          log(`Timeout: killed process (session ${this.currentSessionId || "none"} preserved)`);
        },
      });

      promise.then(({ code, stdout, stderr }) => {
        log(`Exit code: ${code}`);
        log(`stdout (${stdout.length} chars): ${stdout.slice(0, 500)}`);
        if (stderr) log(`stderr: ${stderr.slice(0, 500)}`);

        if (code !== 0 && !stdout.trim()) {
          this.handleSessionError(stderr, noSession ?? false, "");
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
          resolve({ messages: this.splitMessage(text), sessionId: response.session_id });
        } catch {
          const text = stdout.trim() || "No response from Claude.";
          log(`JSON parse failed, using raw: ${text.slice(0, 200)}`);
          resolve({ messages: this.splitMessage(text) });
        }
      }).catch(reject);
    });
  }

  // ---------------------------------------------------------------------------
  // Streaming execution
  // ---------------------------------------------------------------------------

  private runClaudeStreaming(
    message: string,
    onDelta: (text: string) => void,
    options: { timeout: number; allowedTools: string; noSession?: boolean },
  ): Promise<AgentResult & { isAuthError?: boolean }> {
    const { timeout, allowedTools, noSession } = options;

    const prompt = this.buildPrompt(message, noSession ?? false);

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
      let fullText = "";
      let sentLength = 0;
      let sessionId: string | undefined;
      let isAuthError = false;
      let stats: AgentStats | undefined;
      let buffer = "";
      let stderr = "";

      const inactivityLimit = timeout;

      const { child, resetTimer, clearTimer, isTimedOut } = this.spawnWithActivityTimeout({
        command: "claude",
        args,
        env: this.claudeEnv,
        timeout: inactivityLimit,
        onTimeout: () => {
          log(`Streaming inactivity timeout (${inactivityLimit / 1000}s no activity, session ${this.currentSessionId || "none"} preserved)`);
          reject(new Error(`Claude timed out after ${inactivityLimit / 1000}s of inactivity`));
        },
      });

      child.stdout!.on("data", (data: Buffer) => {
        resetTimer();
        buffer += data.toString();
        const { events, remaining } = this.parseJsonLines(buffer);
        buffer = remaining;

        for (const event of events as Record<string, unknown>[]) {
          if (event.type === "assistant") {
            const msg = event.message as Record<string, unknown> | undefined;
            const content = msg?.content as Array<Record<string, unknown>> | undefined;
            if (content) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  const newText = block.text as string;
                  if (newText.length > sentLength) {
                    const delta = newText.slice(sentLength);
                    sentLength = newText.length;
                    fullText = newText;
                    onDelta(delta);
                  }
                }
              }
            }
          } else if (event.type === "result") {
            sessionId = event.session_id as string | undefined;
            const resultText = (event.result as string) || "";
            if ((event as Record<string, unknown>).is_error && resultText.includes("authentication_error")) {
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
            const u = (event.usage || {}) as Record<string, number>;
            stats = this.buildStats({
              durationMs: (event.duration_ms as number) || 0,
              apiDurationMs: (event.duration_api_ms as number) || 0,
              totalCostUsd: (event.total_cost_usd as number) || 0,
              inputTokens: u.input_tokens || 0,
              outputTokens: u.output_tokens || 0,
              cacheReadTokens: u.cache_read_input_tokens || 0,
              cacheCreationTokens: u.cache_creation_input_tokens || 0,
              numTurns: (event.num_turns as number) || 0,
              provider: "claude",
            });
          }
        }
      });

      child.stderr!.on("data", (data: Buffer) => {
        resetTimer();
        stderr += data.toString();
      });

      child.on("close", (code) => {
        clearTimer();
        if (isTimedOut()) return;
        log(`Streaming exit code: ${code}`);
        if (stderr) log(`Streaming stderr: ${stderr.slice(0, 500)}`);

        if (isAuthError) {
          resolve({ messages: [], isAuthError: true });
          return;
        }

        if (!fullText && code !== 0) {
          this.handleSessionError(stderr, noSession ?? false, "Streaming");
          reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }

        const text = fullText || "No response from Claude.";
        log(`Streaming result: ${text.slice(0, 200)}`);
        if (stats) log(`Stats: ${stats.durationMs}ms, $${stats.totalCostUsd.toFixed(4)}, ${stats.inputTokens}in/${stats.outputTokens}out`);
        resolve({ messages: this.splitMessage(text), sessionId, stats });
      });

      child.on("error", (err) => {
        clearTimer();
        reject(err);
      });
    });
  }
}
