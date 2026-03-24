import { ClaudeProvider } from "./claude-provider.js";
import { CodexProvider } from "./codex-provider.js";
import { GrokProvider } from "./grok-provider.js";
import { getDefaultProvider as getDefaultProviderProfile, bootstrapDefaultProvider } from "./provider-store.js";
import type { AIProvider, ProviderProfile, ClaudeConfig, CodexConfig, GrokConfig } from "./types.js";

export type { AIProvider, AgentResult, AgentStats, ProviderProfile, ProviderAskOptions } from "./types.js";
export type { ClaudeConfig, CodexConfig, GrokConfig } from "./types.js";
export { ClaudeProvider } from "./claude-provider.js";
export { CodexProvider } from "./codex-provider.js";
export { GrokProvider } from "./grok-provider.js";
export { listProviders, getProvider, saveProvider, deleteProvider, getDefaultProvider as getDefaultProviderProfile, setDefault, bootstrapDefaultProvider } from "./provider-store.js";

let cachedDefaultProvider: AIProvider | null = null;
let cachedClaudeProvider: ClaudeProvider | null = null;
let savedSessionId: string | null = null;

export function createProvider(profile: ProviderProfile): AIProvider {
  switch (profile.provider) {
    case "claude":
      return new ClaudeProvider(profile.config as ClaudeConfig);
    case "codex":
      return new CodexProvider(profile.config as CodexConfig);
    case "grok":
      return new GrokProvider(profile.config as GrokConfig);
    default:
      throw new Error(`Unknown provider: ${profile.provider}`);
  }
}

export function getDefaultProvider(): AIProvider {
  if (cachedDefaultProvider) return cachedDefaultProvider;

  bootstrapDefaultProvider();
  const profile = getDefaultProviderProfile();
  if (!profile) {
    throw new Error("No provider profiles configured");
  }
  cachedDefaultProvider = createProvider(profile);

  // Restore session ID from before invalidation so chat doesn't lose context
  if (savedSessionId && cachedDefaultProvider instanceof ClaudeProvider) {
    cachedDefaultProvider.restoreSession(savedSessionId);
    savedSessionId = null;
  }

  return cachedDefaultProvider;
}

export function getClaudeProvider(): ClaudeProvider {
  if (cachedClaudeProvider) return cachedClaudeProvider;
  cachedClaudeProvider = new ClaudeProvider();
  return cachedClaudeProvider;
}

export function invalidateProviderCache(): void {
  // Preserve session ID before destroying provider so chat doesn't lose context
  if (cachedDefaultProvider && cachedDefaultProvider instanceof ClaudeProvider) {
    savedSessionId = cachedDefaultProvider.getSessionId();
  }
  cachedDefaultProvider = null;
  // Note: cachedClaudeProvider is NOT invalidated — brain/self-improve keep their session
}
