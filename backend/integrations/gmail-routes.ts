import type { IncomingMessage, ServerResponse } from "http";
import { randomBytes } from "crypto";
import {
  loadAccounts,
  getAuthUrl,
  handleAuthCallback,
  getAccountStatus,
  restartGmailPolling,
} from "./gmail.js";
import { isAuthenticated } from "../web/auth.js";
import { createLogger } from "../logger.js";
import { respondJson } from "../utils/api-helpers.js";

const log = createLogger("gmail-routes");

// OAuth CSRF protection: nonce → accountId, expires after 10 minutes
const oauthNonces = new Map<string, { accountId: string; expiresAt: number }>();
const NONCE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Handle Gmail-related HTTP routes. Returns true if the route was handled.
 */
export function handleGmailRoutes(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // GET /gmail/accounts — list accounts and their status (requires auth)
  if (pathname === "/gmail/accounts" && req.method === "GET") {
    if (!isAuthenticated(req)) {
      respondJson(res, 401, { error: "Unauthorized" });
      return true;
    }
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

    // Generate CSRF nonce and pass as OAuth state
    const nonce = randomBytes(16).toString("hex");
    oauthNonces.set(nonce, { accountId: account.id, expiresAt: Date.now() + NONCE_TTL });
    // Cleanup expired nonces
    for (const [key, val] of oauthNonces) {
      if (val.expiresAt < Date.now()) oauthNonces.delete(key);
    }

    const authUrl = getAuthUrl(account, nonce);
    log(`Generated auth URL for ${accountId}, redirecting (nonce: ${nonce.slice(0, 8)}...)`);
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

    // Validate CSRF nonce
    const nonceData = oauthNonces.get(state);
    if (!nonceData || nonceData.expiresAt < Date.now()) {
      oauthNonces.delete(state);
      log(`OAuth callback: invalid or expired nonce`);
      res.writeHead(302, { Location: '/integrations?gmail_error=' + encodeURIComponent('Invalid or expired OAuth state. Please try again.') });
      res.end();
      return true;
    }
    const accountId = nonceData.accountId;
    oauthNonces.delete(state);

    // Handle the callback asynchronously
    handleAuthCallback(code, accountId)
      .then((success) => {
        if (success) {
          restartGmailPolling();
          res.writeHead(302, { Location: '/integrations?gmail_connected=' + encodeURIComponent(accountId) });
          res.end();
        } else {
          res.writeHead(302, { Location: '/integrations?gmail_error=' + encodeURIComponent(`Token exchange failed for account "${accountId}"`) });
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
