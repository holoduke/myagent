import { IncomingMessage, ServerResponse } from "http";
import {
  listProviders,
  getProvider,
  saveProvider,
  deleteProvider,
  getDefaultProviderProfile,
  setDefault,
  createProvider,
  invalidateProviderCache,
} from "../providers/index.js";
import { maskSecrets } from "../providers/provider-store.js";
import { isAuthenticated } from "./auth.js";
import type { ProviderProfile } from "../providers/types.js";
import { createLogger } from "../logger.js";
import { respondJson, apiHandler, ApiError } from "../utils/api-helpers.js";

const log = createLogger("providers-api");

export function handleProviderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/providers")) return false;
  if (!isAuthenticated(req)) {
    respondJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  // GET /api/providers — list all
  if (pathname === "/api/providers" && req.method === "GET") {
    respondJson(res, 200, listProviders().map(maskSecrets));
    return true;
  }

  // GET /api/providers/default — get default
  if (pathname === "/api/providers/default" && req.method === "GET") {
    const provider = getDefaultProviderProfile();
    if (!provider) {
      respondJson(res, 404, { error: "No providers configured" });
    } else {
      respondJson(res, 200, maskSecrets(provider));
    }
    return true;
  }

  // POST /api/providers — create new
  if (pathname === "/api/providers" && req.method === "POST") {
    handleCreate(req, res);
    return true;
  }

  // Routes with :id
  const idMatch = pathname.match(/^\/api\/providers\/([^/]+)$/);
  if (idMatch) {
    const id = idMatch[1];

    if (req.method === "GET") {
      const provider = getProvider(id);
      if (!provider) {
        respondJson(res, 404, { error: "Provider not found" });
      } else {
        respondJson(res, 200, maskSecrets(provider));
      }
      return true;
    }

    if (req.method === "PUT") {
      handleUpdate(req, res, id);
      return true;
    }

    if (req.method === "DELETE") {
      const deleted = deleteProvider(id);
      if (!deleted) {
        respondJson(res, 404, { error: "Provider not found" });
        return true;
      }
      invalidateProviderCache();
      respondJson(res, 200, { success: true });
      return true;
    }
  }

  // POST /api/providers/:id/set-default
  const setDefaultMatch = pathname.match(/^\/api\/providers\/([^/]+)\/set-default$/);
  if (setDefaultMatch && req.method === "POST") {
    const id = setDefaultMatch[1];
    const provider = getProvider(id);
    if (!provider) {
      respondJson(res, 404, { error: "Provider not found" });
    } else {
      setDefault(id);
      invalidateProviderCache();
      respondJson(res, 200, { success: true });
    }
    return true;
  }

  // POST /api/providers/:id/test
  const testMatch = pathname.match(/^\/api\/providers\/([^/]+)\/test$/);
  if (testMatch && req.method === "POST") {
    handleTest(res, testMatch[1]);
    return true;
  }

  return false;
}

const handleCreate = apiHandler(async (_req, res, data: { name?: string; provider?: string; config?: Record<string, unknown>; isDefault?: boolean }) => {
  if (!data.name || !data.provider || !["claude", "codex", "grok"].includes(data.provider)) {
    throw new ApiError(400, "name and provider (claude|codex|grok) are required");
  }

  const id = `${data.provider}-${Date.now().toString(36)}`;
  const profile: ProviderProfile = {
    id,
    name: data.name,
    provider: data.provider as "claude" | "codex" | "grok",
    isDefault: data.isDefault ?? false,
    config: data.config || {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  saveProvider(profile);
  if (profile.isDefault) setDefault(id);
  invalidateProviderCache();
  log(`Created provider: ${id}`);
  respondJson(res, 201, maskSecrets(profile));
});

async function handleUpdate(req: IncomingMessage, res: ServerResponse, id: string) {
  const handler = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
    const existing = getProvider(id);
    if (!existing) throw new ApiError(404, "Provider not found");

    if (data.name !== undefined) existing.name = data.name as string;
    if (data.config !== undefined) existing.config = data.config as Record<string, unknown>;
    if (data.isDefault !== undefined) existing.isDefault = data.isDefault as boolean;

    saveProvider(existing);
    if (existing.isDefault) setDefault(id);
    invalidateProviderCache();
    log(`Updated provider: ${id}`);
    return maskSecrets(existing);
  });
  await handler(req, res);
}

async function handleTest(res: ServerResponse, id: string) {
  const provider = getProvider(id);
  if (!provider) {
    respondJson(res, 404, { error: "Provider not found" });
    return;
  }

  try {
    const aiProvider = createProvider(provider);
    const start = Date.now();
    const result = await aiProvider.ask("Say hello in one sentence.", { timeout: 30_000, noSession: true });
    const durationMs = Date.now() - start;
    log(`Test for ${id}: ${result.messages[0]?.slice(0, 100)}`);
    respondJson(res, 200, { success: true, response: result.messages[0] || "", durationMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Test failed for ${id}: ${msg}`);
    respondJson(res, 200, { success: false, error: msg });
  }
}
