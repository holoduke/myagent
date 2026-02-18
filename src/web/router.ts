import { IncomingMessage, ServerResponse } from "http";
import { MessageQueue } from "../queue.js";
import { handleLogin } from "./auth.js";
import { handleApiRoutes } from "./api.js";

export function handleWebRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  queue: MessageQueue,
): boolean {
  const pathname = (req.url || "/").split("?")[0];

  // ── Login API ──
  if (pathname === "/api/login" && req.method === "POST") {
    handleLogin(req, res);
    return true;
  }

  // ── API routes ──
  if (pathname.startsWith("/api/")) {
    return handleApiRoutes(req, res, queue);
  }

  // ── Root: API info (frontend is now a separate Nuxt app) ──
  if (pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: "ARIA Backend API",
      version: "1.0.0",
      note: "Frontend is served by a separate Nuxt application",
    }));
    return true;
  }

  return false;
}
