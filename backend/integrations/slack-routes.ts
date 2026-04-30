import type { IncomingMessage, ServerResponse } from "http";
import {
  loadWorkspaces,
  getAuthUrl,
  handleAuthCallback,
  getWorkspaceStatus,
  restartSlackPolling,
} from "./slack.js";
import { createLogger } from "../logger.js";
import { respondJson } from "../utils/api-helpers.js";

const log = createLogger("slack-routes");

/**
 * Handle Slack-related HTTP routes. Returns true if the route was handled.
 */
export function handleSlackRoutes(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // GET /slack/workspaces — list workspaces and their status
  if (pathname === "/slack/workspaces" && req.method === "GET") {
    const status = getWorkspaceStatus();
    respondJson(res, 200, { workspaces: status });
    return true;
  }

  // GET /slack/auth/:workspaceId — start OAuth flow for a workspace
  const authMatch = pathname.match(/^\/slack\/auth\/([^/]+)$/);
  if (authMatch && req.method === "GET") {
    const workspaceId = decodeURIComponent(authMatch[1]);
    const workspaces = loadWorkspaces();
    const workspace = workspaces.find(w => w.id === workspaceId);

    if (!workspace) {
      respondJson(res, 404, { error: `Workspace "${workspaceId}" not found. Add it first via ARIA.` });
      return true;
    }

    const authUrl = getAuthUrl(workspace);
    log(`Generated auth URL for ${workspaceId}, redirecting`);
    res.writeHead(302, { Location: authUrl });
    res.end();
    return true;
  }

  // GET /slack/callback — OAuth redirect handler
  if (pathname === "/slack/callback" && req.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state"); // workspaceId
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(302, { Location: "/integrations?slack_error=" + encodeURIComponent(error) });
      res.end();
      return true;
    }

    if (!code || !state) {
      res.writeHead(302, { Location: "/integrations?slack_error=" + encodeURIComponent("Missing code or state parameter") });
      res.end();
      return true;
    }

    handleAuthCallback(code, state)
      .then((success) => {
        if (success) {
          restartSlackPolling();
          res.writeHead(302, { Location: "/integrations?slack_connected=" + encodeURIComponent(state) });
          res.end();
        } else {
          res.writeHead(302, { Location: "/integrations?slack_error=" + encodeURIComponent(`Token exchange failed for workspace "${state}"`) });
          res.end();
        }
      })
      .catch((err) => {
        log(`Auth callback error: ${err}`);
        res.writeHead(302, { Location: "/integrations?slack_error=" + encodeURIComponent(String(err)) });
        res.end();
      });

    return true;
  }

  return false;
}
