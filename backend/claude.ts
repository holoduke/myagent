// Thin facade — delegates to ClaudeProvider or GrokProvider based on model.
// Brain (brain.ts) and self-improve (self-improve.ts) import from here.
import { getClaudeProvider } from "./providers/index.js";
import { isGrokModel } from "./providers/llm-runner.js";
import { GrokProvider } from "./providers/grok-provider.js";
import type { AgentResult, AgentStats } from "./providers/types.js";

// Re-export types under legacy names for backward compatibility
export type ClaudeStats = AgentStats;
export type ClaudeResult = AgentResult;

function createGrokProvider(model?: string): GrokProvider {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) throw new Error("GROK_API_KEY not set — cannot use Grok model");
  return new GrokProvider({ apiKey, model });
}

export function resetSession(): void {
  getClaudeProvider().resetSession();
}

export async function askClaude(
  message: string,
  options: {
    timeout?: number;
    allowedTools?: string;
    noSession?: boolean;
    model?: string;
  } = {},
): Promise<ClaudeResult> {
  if (isGrokModel(options.model)) {
    return createGrokProvider(options.model).ask(message, { timeout: options.timeout, noSession: true });
  }
  return getClaudeProvider().ask(message, options);
}

export async function askClaudeStreaming(
  message: string,
  onDelta: (text: string) => void,
  options: {
    timeout?: number;
    allowedTools?: string;
    noSession?: boolean;
    model?: string;
  } = {},
): Promise<ClaudeResult> {
  if (isGrokModel(options.model)) {
    // Grok doesn't support real streaming — run blocking and emit full text
    const result = await createGrokProvider(options.model).ask(message, { timeout: options.timeout, noSession: true });
    const text = result.messages.join("\n");
    onDelta(text);
    return result;
  }
  return getClaudeProvider().askStreaming(message, onDelta, options);
}
