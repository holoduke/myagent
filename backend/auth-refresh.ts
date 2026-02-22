import { readFileSync, writeFileSync, existsSync } from "fs";
import { appendFileSync } from "fs";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [auth] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

// Refresh 10 minutes before expiry
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

interface OAuthCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
    rateLimitTier: string;
  };
}

function getCredentialsPath(): string {
  const home = process.env.CLAUDE_HOME || process.env.HOME || "/root";
  return `${home}/.claude/.credentials.json`;
}

function readCredentials(): OAuthCredentials | null {
  const path = getCredentialsPath();
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
    log("Failed to read credentials file");
  }
  return null;
}

function writeCredentials(creds: OAuthCredentials): void {
  const path = getCredentialsPath();
  try {
    writeFileSync(path, JSON.stringify(creds));
    log("Credentials file updated");
  } catch (err) {
    log(`Failed to write credentials: ${err}`);
  }
}

export async function ensureValidToken(): Promise<void> {
  const creds = readCredentials();
  if (!creds?.claudeAiOauth) {
    log("No credentials found, skipping refresh");
    return;
  }

  const { expiresAt, refreshToken } = creds.claudeAiOauth;
  const now = Date.now();
  const timeLeft = expiresAt - now;

  if (timeLeft > REFRESH_BUFFER_MS) {
    return; // Token still valid
  }

  if (!refreshToken) {
    log("Token expiring but no refresh token available");
    return;
  }

  log(`Token expires in ${Math.round(timeLeft / 1000)}s, refreshing...`);

  try {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        scope: creds.claudeAiOauth.scopes.join(" "),
      }),
    });

    if (resp.status !== 200) {
      const text = await resp.text();
      log(`Token refresh failed (${resp.status}): ${text.slice(0, 200)}`);
      return;
    }

    const data = await resp.json();
    if (data.access_token) {
      creds.claudeAiOauth.accessToken = data.access_token;
      if (data.refresh_token) {
        creds.claudeAiOauth.refreshToken = data.refresh_token;
      }
      creds.claudeAiOauth.expiresAt = now + (data.expires_in || 3600) * 1000;
      if (data.scope) {
        creds.claudeAiOauth.scopes = data.scope.split(" ");
      }
      writeCredentials(creds);
      log(`Token refreshed, new expiry: ${new Date(creds.claudeAiOauth.expiresAt).toISOString()}`);
    } else {
      log(`Unexpected refresh response: ${JSON.stringify(data).slice(0, 200)}`);
    }
  } catch (err) {
    log(`Token refresh error: ${err}`);
  }
}

/**
 * Start a background interval that refreshes the token before it expires.
 * Checks every 5 minutes.
 */
export function startTokenRefreshLoop(): void {
  log("Starting token refresh loop (checks every 5 min)");
  // Check immediately on startup
  ensureValidToken().catch((err) => log(`Initial refresh check failed: ${err}`));
  // Then check periodically
  setInterval(() => {
    ensureValidToken().catch((err) => log(`Periodic refresh failed: ${err}`));
  }, 5 * 60 * 1000);
}
