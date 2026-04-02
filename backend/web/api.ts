import { IncomingMessage, ServerResponse } from "http";
import { MessageQueue } from "../queue.js";
import { handleChatRoutes } from "./chat-api.js";
import { handleContactRoutes } from "./contact-api.js";
import { handleBrainRoutes } from "./brain-api.js";
import { handleIntegrationRoutes } from "./integration-api.js";
import { handleSkillRoutes } from "./skills-api.js";

export function handleApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  queue: MessageQueue,
): boolean {
  return handleChatRoutes(req, res, queue)
    || handleContactRoutes(req, res)
    || handleBrainRoutes(req, res)
    || handleIntegrationRoutes(req, res)
    || handleSkillRoutes(req, res);
}
