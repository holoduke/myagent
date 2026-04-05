export interface AgentResult {
  messages: string[];
  sessionId?: string;
  stats?: AgentStats;
}

export interface AgentStats {
  durationMs: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  provider: string;
  model?: string;
  apiDurationMs?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface ProviderProfile {
  id: string;
  name: string;
  provider: "claude" | "codex" | "grok";
  isDefault: boolean;
  config: ClaudeConfig | CodexConfig | GrokConfig;
  createdAt: number;
  updatedAt: number;
}

export interface ClaudeConfig {
  allowedTools?: string;
  timeout?: number;
}

export interface CodexConfig {
  model?: string;
  sandbox?: string;
  fullAuto?: boolean;
  timeout?: number;
}

export interface GrokConfig {
  model?: string;
  apiKey?: string;
  maxToolRounds?: number;
  timeout?: number;
}

export interface AIProvider {
  readonly name: string;
  readonly supportsStreaming: boolean;
  readonly supportsSessions: boolean;
  ask(message: string, options: ProviderAskOptions): Promise<AgentResult>;
  askStreaming(message: string, onDelta: (text: string) => void, options: ProviderAskOptions): Promise<AgentResult>;
  resetSession(): void;
  /** Optional session ID accessor — avoids casting to concrete provider types */
  getSessionId?(): string | null;
}

export interface ProviderAskOptions {
  timeout?: number;
  noSession?: boolean;
  allowedTools?: string;
  /** Model name: Claude "sonnet"|"haiku"|"opus", Grok "grok"|"grok-mini". If omitted, uses default. */
  model?: string;
}
