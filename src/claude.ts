// Thin facade — delegates to ClaudeProvider.
// Brain (brain.ts) and self-improve (self-improve.ts) import from here and require zero changes.
import { getClaudeProvider } from "./providers/index.js";
import type { AgentResult, AgentStats } from "./providers/types.js";

// Re-export types under legacy names for backward compatibility
export type ClaudeStats = AgentStats;
export type ClaudeResult = AgentResult;

export function resetSession(): void {
  getClaudeProvider().resetSession();
}

export async function askClaude(
  message: string,
  options: {
    timeout?: number;
    allowedTools?: string;
    noSession?: boolean;
  } = {},
): Promise<ClaudeResult> {
  return getClaudeProvider().ask(message, options);
}

export async function askClaudeStreaming(
  message: string,
  onDelta: (text: string) => void,
  options: {
    timeout?: number;
    allowedTools?: string;
  } = {},
): Promise<ClaudeResult> {
  return getClaudeProvider().askStreaming(message, onDelta, options);
}
