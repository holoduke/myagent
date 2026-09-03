import { IncomingMessage, ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { MessageQueue } from "../queue.js";
import { handleChatRoutes } from "./chat-api.js";
import { handleContactRoutes } from "./contact-api.js";
import { handleBrainRoutes } from "./brain-api.js";
import { handleIntegrationRoutes } from "./integration-api.js";
import { handleSkillRoutes } from "./skills-api.js";
import { isAuthenticated } from "./auth.js";
import { respondJson } from "../utils/api-helpers.js";
import { getAutonomyState, getSuppressedToday, LEVEL_DESCRIPTIONS, PROMOTE_THRESHOLDS } from "../autonomy.js";
import { getUrgentOverridesToday, getRecentUrgentOverrides } from "../urgency.js";
import { BRAIN_DIR } from "../config.js";

function handleAutonomyGet(res: ServerResponse): void {
  const s = getAutonomyState();

  let lastBrainMessage: unknown = null;
  try {
    const stateFile = `${BRAIN_DIR}/state.json`;
    if (existsSync(stateFile)) {
      const brainState = JSON.parse(readFileSync(stateFile, "utf-8")) as { lastBrainMessage?: unknown };
      lastBrainMessage = brainState.lastBrainMessage ?? null;
    }
  } catch { /* expected: state file may not exist yet */ }

  respondJson(res, 200, {
    level: s.level,
    trustScore: s.trustScore,
    successCount: s.successCount,
    failureCount: s.failureCount,
    shadowSuccessCount: s.shadowSuccessCount ?? 0,
    levelDescriptions: LEVEL_DESCRIPTIONS,
    nextLevelThreshold: PROMOTE_THRESHOLDS[s.level] ?? null,
    suppressedToday: getSuppressedToday(),
    urgentOverridesToday: getUrgentOverridesToday(),
    recentUrgentOverrides: getRecentUrgentOverrides(10),
    lastBrainMessage,
    history: s.history.slice(-10),
  });
}

export function handleApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  queue: MessageQueue,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/api/autonomy" && req.method === "GET" && isAuthenticated(req)) {
    handleAutonomyGet(res);
    return true;
  }

  return handleChatRoutes(req, res, queue)
    || handleContactRoutes(req, res)
    || handleBrainRoutes(req, res)
    || handleIntegrationRoutes(req, res)
    || handleSkillRoutes(req, res);
}
