import type { IncomingMessage, ServerResponse } from "http";
import {
  loadAccounts,
  getAuthUrl,
  handleAuthCallback,
  getAccountStatus,
  restartGmailPolling,
} from "./gmail.js";
import { createLogger } from "../logger.js";
import { respondJson } from "../utils/api-helpers.js";

const log = createLogger("gmail-routes");

/**
 * Handle Gmail-related HTTP routes. Returns true if the route was handled.
 */
export function handleGmailRoutes(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // GET /gmail/accounts — list accounts and their status
  if (pathname === "/gmail/accounts" && req.method === "GET") {
    const status = getAccountStatus();
    respondJson(res, 200, { accounts: status });
    return true;
  }

  // GET /gmail/auth/:accountId — start OAuth flow for an account
  const authMatch = pathname.match(/^\/gmail\/auth\/([^/]+)$/);
  if (authMatch && req.method === "GET") {
    const accountId = decodeURIComponent(authMatch[1]);
    const accounts = loadAccounts();
    const account = accounts.find(a => a.id === accountId);

    if (!account) {
      respondJson(res, 404, { error: `Account "${accountId}" not found. Add it first via ARIA.` });
      return true;
    }

    const authUrl = getAuthUrl(account);
    log(`Generated auth URL for ${accountId}, redirecting`);
    res.writeHead(302, { Location: authUrl });
    res.end();
    return true;
  }

  // GET /gmail/callback — OAuth redirect handler
  if (pathname === "/gmail/callback" && req.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state"); // accountId
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(302, { Location: '/integrations?gmail_error=' + encodeURIComponent(error) });
      res.end();
      return true;
    }

    if (!code || !state) {
      res.writeHead(302, { Location: '/integrations?gmail_error=' + encodeURIComponent('Missing code or state parameter') });
      res.end();
      return true;
    }

    // Handle the callback asynchronously
    handleAuthCallback(code, state)
      .then((success) => {
        if (success) {
          restartGmailPolling();
          res.writeHead(302, { Location: '/integrations?gmail_connected=' + encodeURIComponent(state) });
          res.end();
        } else {
          res.writeHead(302, { Location: '/integrations?gmail_error=' + encodeURIComponent(`Token exchange failed for account "${state}"`) });
          res.end();
        }
      })
      .catch((err) => {
        log(`Auth callback error: ${err}`);
        res.writeHead(302, { Location: '/integrations?gmail_error=' + encodeURIComponent(String(err)) });
        res.end();
      });

    return true;
  }

  return false;
}
