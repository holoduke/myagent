import { IncomingMessage, ServerResponse } from "http";
import {
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  getCatalog,
  installFromCatalog,
  uninstallSkill,
} from "../skills.js";
import { isAuthenticated } from "./auth.js";
import { respondJson, apiHandler, ApiError } from "../utils/api-helpers.js";
import { createLogger } from "../logger.js";

const log = createLogger("skills-api");

export function handleSkillRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/skills")) return false;
  if (!isAuthenticated(req)) {
    respondJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  // GET /api/skills/catalog — list catalog skills
  if (pathname === "/api/skills/catalog" && req.method === "GET") {
    const catalog = getCatalog();
    const installed = listSkills();
    const installedCatalogIds = new Set(
      installed.filter((s) => s.catalogId).map((s) => s.catalogId),
    );
    const enriched = catalog.map((c) => ({
      ...c,
      installed: installedCatalogIds.has(c.id),
    }));
    respondJson(res, 200, enriched);
    return true;
  }

  // POST /api/skills/catalog/:id/install — install from catalog
  const installMatch = pathname.match(
    /^\/api\/skills\/catalog\/([^/]+)\/install$/,
  );
  if (installMatch && req.method === "POST") {
    const catalogId = installMatch[1];
    const skill = installFromCatalog(catalogId);
    if (!skill) {
      respondJson(res, 404, { error: "Catalog skill not found" });
    } else {
      log(`Installed catalog skill: ${catalogId}`);
      respondJson(res, 201, skill);
    }
    return true;
  }

  // POST /api/skills/catalog/:id/uninstall — uninstall catalog skill
  const uninstallMatch = pathname.match(
    /^\/api\/skills\/catalog\/([^/]+)\/uninstall$/,
  );
  if (uninstallMatch && req.method === "POST") {
    const catalogId = uninstallMatch[1];
    const removed = uninstallSkill(catalogId);
    if (!removed) {
      respondJson(res, 404, { error: "Skill not installed" });
    } else {
      log(`Uninstalled catalog skill: ${catalogId}`);
      respondJson(res, 200, { success: true });
    }
    return true;
  }

  // GET /api/skills — list installed
  if (pathname === "/api/skills" && req.method === "GET") {
    respondJson(res, 200, listSkills());
    return true;
  }

  // POST /api/skills — create custom
  if (pathname === "/api/skills" && req.method === "POST") {
    handleCreate(req, res);
    return true;
  }

  // Routes with :id
  const idMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (idMatch) {
    const id = idMatch[1];

    if (req.method === "GET") {
      const skill = getSkill(id);
      if (!skill) {
        respondJson(res, 404, { error: "Skill not found" });
      } else {
        respondJson(res, 200, skill);
      }
      return true;
    }

    if (req.method === "PUT") {
      handleUpdate(req, res, id);
      return true;
    }

    if (req.method === "DELETE") {
      const deleted = deleteSkill(id);
      if (!deleted) {
        respondJson(res, 404, { error: "Skill not found" });
        return true;
      }
      respondJson(res, 200, { success: true });
      return true;
    }
  }

  return false;
}

const handleCreate = apiHandler(
  async (
    _req,
    res,
    data: {
      name?: string;
      description?: string;
      prompt?: string;
      icon?: string;
      category?: string;
      enabled?: boolean;
    },
  ) => {
    if (!data.name || !data.prompt) {
      throw new ApiError(400, "name and prompt are required");
    }
    const skill = createSkill({
      name: data.name,
      description: data.description || "",
      prompt: data.prompt,
      icon: data.icon,
      category: data.category,
      enabled: data.enabled,
    });
    log(`Created skill via API: ${skill.id}`);
    respondJson(res, 201, skill);
  },
);

async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
) {
  const handler = apiHandler(
    async (_req, _res, data: Record<string, unknown>) => {
      const updated = updateSkill(id, {
        name: data.name as string | undefined,
        description: data.description as string | undefined,
        prompt: data.prompt as string | undefined,
        icon: data.icon as string | undefined,
        enabled: data.enabled as boolean | undefined,
      });
      if (!updated) throw new ApiError(404, "Skill not found");
      log(`Updated skill via API: ${id}`);
      return updated;
    },
  );
  await handler(req, res);
}
