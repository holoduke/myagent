import { IncomingMessage, ServerResponse } from "http";
import { appendFileSync } from "fs";
import {
  listAgents,
  getAgent,
  saveAgent,
  deleteAgent,
  getDefaultAgent,
  setDefault,
  createProvider,
  invalidateProviderCache,
} from "../providers/index.js";
import { maskSecrets } from "../providers/agent-store.js";
import { isAuthenticated, readBody } from "./auth.js";
import type { AgentProfile } from "../providers/types.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  try {
    const line = `[${new Date().toISOString()}] [agents-api] ${msg}`;
    console.log(line);
    appendFileSync(LOG_FILE, line + "\n");
  } catch { /* prevent disk errors from crashing */ }
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/agents")) return false;
  if (!isAuthenticated(req)) {
    json(res, 401, { error: "Unauthorized" });
    return true;
  }

  // GET /api/agents — list all
  if (pathname === "/api/agents" && req.method === "GET") {
    json(res, 200, listAgents().map(maskSecrets));
    return true;
  }

  // GET /api/agents/default — get default
  if (pathname === "/api/agents/default" && req.method === "GET") {
    const agent = getDefaultAgent();
    if (!agent) {
      json(res, 404, { error: "No agents configured" });
    } else {
      json(res, 200, maskSecrets(agent));
    }
    return true;
  }

  // POST /api/agents — create new
  if (pathname === "/api/agents" && req.method === "POST") {
    handleCreate(req, res);
    return true;
  }

  // Routes with :id
  const idMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (idMatch) {
    const id = idMatch[1];

    if (req.method === "GET") {
      const agent = getAgent(id);
      if (!agent) {
        json(res, 404, { error: "Agent not found" });
      } else {
        json(res, 200, maskSecrets(agent));
      }
      return true;
    }

    if (req.method === "PUT") {
      handleUpdate(req, res, id);
      return true;
    }

    if (req.method === "DELETE") {
      const deleted = deleteAgent(id);
      if (!deleted) {
        json(res, 404, { error: "Agent not found" });
        return true;
      }
      invalidateProviderCache();
      json(res, 200, { success: true });
      return true;
    }
  }

  // POST /api/agents/:id/set-default
  const setDefaultMatch = pathname.match(/^\/api\/agents\/([^/]+)\/set-default$/);
  if (setDefaultMatch && req.method === "POST") {
    const id = setDefaultMatch[1];
    const agent = getAgent(id);
    if (!agent) {
      json(res, 404, { error: "Agent not found" });
    } else {
      setDefault(id);
      invalidateProviderCache();
      json(res, 200, { success: true });
    }
    return true;
  }

  // POST /api/agents/:id/test
  const testMatch = pathname.match(/^\/api\/agents\/([^/]+)\/test$/);
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
    const profile: AgentProfile = {
      id,
      name,
      provider,
      isDefault: isDefault ?? false,
      config: config || {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    saveAgent(profile);
    if (profile.isDefault) {
      setDefault(id);
    }
    invalidateProviderCache();
    log(`Created agent: ${id}`);
    json(res, 201, maskSecrets(profile));
  } catch {
    json(res, 400, { error: "Invalid request" });
  }
}

async function handleUpdate(req: IncomingMessage, res: ServerResponse, id: string) {
  try {
    const existing = getAgent(id);
    if (!existing) {
      json(res, 404, { error: "Agent not found" });
      return;
    }

    const body = await readBody(req);
    const data = JSON.parse(body);

    if (data.name !== undefined) existing.name = data.name;
    if (data.config !== undefined) existing.config = data.config;
    if (data.isDefault !== undefined) existing.isDefault = data.isDefault;

    saveAgent(existing);
    if (existing.isDefault) {
      setDefault(id);
    }
    invalidateProviderCache();
    log(`Updated agent: ${id}`);
    json(res, 200, maskSecrets(existing));
  } catch {
    json(res, 400, { error: "Invalid request" });
  }
}

async function handleTest(res: ServerResponse, id: string) {
  const agent = getAgent(id);
  if (!agent) {
    json(res, 404, { error: "Agent not found" });
    return;
  }

  try {
    const provider = createProvider(agent);
    const start = Date.now();
    const result = await provider.ask("Say hello in one sentence.", { timeout: 30_000, noSession: true });
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
