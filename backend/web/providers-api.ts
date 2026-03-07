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
import { isAuthenticated, readBody } from "./auth.js";
import type { ProviderProfile } from "../providers/types.js";
import { createLogger } from "../logger.js";

const log = createLogger("providers-api");

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function handleProviderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/providers")) return false;
  if (!isAuthenticated(req)) {
    json(res, 401, { error: "Unauthorized" });
    return true;
  }

  // GET /api/providers — list all
  if (pathname === "/api/providers" && req.method === "GET") {
    json(res, 200, listProviders().map(maskSecrets));
    return true;
  }

  // GET /api/providers/default — get default
  if (pathname === "/api/providers/default" && req.method === "GET") {
    const provider = getDefaultProviderProfile();
    if (!provider) {
      json(res, 404, { error: "No providers configured" });
    } else {
      json(res, 200, maskSecrets(provider));
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
        json(res, 404, { error: "Provider not found" });
      } else {
        json(res, 200, maskSecrets(provider));
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
        json(res, 404, { error: "Provider not found" });
        return true;
      }
      invalidateProviderCache();
      json(res, 200, { success: true });
      return true;
    }
  }

  // POST /api/providers/:id/set-default
  const setDefaultMatch = pathname.match(/^\/api\/providers\/([^/]+)\/set-default$/);
  if (setDefaultMatch && req.method === "POST") {
    const id = setDefaultMatch[1];
    const provider = getProvider(id);
    if (!provider) {
      json(res, 404, { error: "Provider not found" });
    } else {
      setDefault(id);
      invalidateProviderCache();
      json(res, 200, { success: true });
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

async function handleCreate(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);
    const { name, provider, config, isDefault } = data;

    if (!name || !provider || !["claude", "codex", "grok"].includes(provider)) {
      json(res, 400, { error: "name and provider (claude|codex|grok) are required" });
      return;
    }

    const id = `${provider}-${Date.now().toString(36)}`;
    const profile: ProviderProfile = {
      id,
      name,
      provider,
      isDefault: isDefault ?? false,
      config: config || {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    saveProvider(profile);
    if (profile.isDefault) {
      setDefault(id);
    }
    invalidateProviderCache();
    log(`Created provider: ${id}`);
    json(res, 201, maskSecrets(profile));
  } catch {
    json(res, 400, { error: "Invalid request" });
  }
}

async function handleUpdate(req: IncomingMessage, res: ServerResponse, id: string) {
  try {
    const existing = getProvider(id);
    if (!existing) {
      json(res, 404, { error: "Provider not found" });
      return;
    }

    const body = await readBody(req);
    const data = JSON.parse(body);

    if (data.name !== undefined) existing.name = data.name;
    if (data.config !== undefined) existing.config = data.config;
    if (data.isDefault !== undefined) existing.isDefault = data.isDefault;

    saveProvider(existing);
    if (existing.isDefault) {
      setDefault(id);
    }
    invalidateProviderCache();
    log(`Updated provider: ${id}`);
    json(res, 200, maskSecrets(existing));
  } catch {
    json(res, 400, { error: "Invalid request" });
  }
}

async function handleTest(res: ServerResponse, id: string) {
  const provider = getProvider(id);
  if (!provider) {
    json(res, 404, { error: "Provider not found" });
    return;
  }

  try {
    const aiProvider = createProvider(provider);
    const start = Date.now();
    const result = await aiProvider.ask("Say hello in one sentence.", { timeout: 30_000, noSession: true });
    const durationMs = Date.now() - start;
    log(`Test for ${id}: ${result.messages[0]?.slice(0, 100)}`);
    json(res, 200, {
      success: true,
      response: result.messages[0] || "",
      durationMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Test failed for ${id}: ${msg}`);
    json(res, 200, {
      success: false,
      error: msg,
    });
  }
}
