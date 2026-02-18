import type { IncomingMessage, ServerResponse } from "http";
import { appendFileSync } from "fs";
import {
  loadAccounts,
  getAuthUrl,
  handleAuthCallback,
  addAccount,
  getAccountStatus,
  restartGmailPolling,
} from "./gmail.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [gmail-routes] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Handle Gmail-related HTTP routes. Returns true if the route was handled.
 */
export function handleGmailRoutes(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // GET /gmail/accounts — list accounts and their status
  if (pathname === "/gmail/accounts" && req.method === "GET") {
    const status = getAccountStatus();
    sendJson(res, 200, { accounts: status });
    return true;
  }

  // GET /gmail/auth/:accountId — start OAuth flow for an account
  const authMatch = pathname.match(/^\/gmail\/auth\/([^/]+)$/);
  if (authMatch && req.method === "GET") {
    const accountId = decodeURIComponent(authMatch[1]);
    const accounts = loadAccounts();
    const account = accounts.find(a => a.id === accountId);

    if (!account) {
      sendJson(res, 404, { error: `Account "${accountId}" not found. Add it first via ARIA.` });
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
      sendHtml(res, 400, `
        <h1>Gmail Auth Failed</h1>
        <p>Error: ${escapeHtml(error)}</p>
        <p>Try again or check your Google Cloud Console settings.</p>
      `);
      return true;
    }

    if (!code || !state) {
      sendHtml(res, 400, `
        <h1>Gmail Auth Failed</h1>
        <p>Missing code or state parameter.</p>
      `);
      return true;
    }

    // Handle the callback asynchronously
    handleAuthCallback(code, state)
      .then((success) => {
        if (success) {
          // Restart polling to include the new account
          restartGmailPolling();
          sendHtml(res, 200, `
            <h1>Gmail Connected!</h1>
            <p>Account <strong>${escapeHtml(state)}</strong> is now linked to ARIA.</p>
            <p>Email polling will start automatically. You can close this tab.</p>
          `);
        } else {
          sendHtml(res, 500, `
            <h1>Gmail Auth Failed</h1>
            <p>Token exchange failed for account "${escapeHtml(state)}". Check ARIA logs.</p>
          `);
        }
      })
      .catch((err) => {
        log(`Auth callback error: ${err}`);
        sendHtml(res, 500, `
          <h1>Gmail Auth Failed</h1>
          <p>Error: ${escapeHtml(String(err))}</p>
        `);
      });

    return true;
  }

  return false;
}
