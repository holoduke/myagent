import { google, gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { FileStore, ensureDir } from "../utils/file-store.js";
import { DedupCache } from "../utils/dedup-cache.js";
import { recordObservation } from "../observer.js";
import { isIntegrationEnabled } from "./integration-config.js";
import { logDelivery } from "../scheduler.js";
import { createLogger } from "../logger.js";
import { withTimeout } from "../utils/async.js";
import { verify } from "../action-verifier.js";

const log = createLogger("gmail");

const GMAIL_DIR = process.env.GMAIL_DIR || "/data/gmail";
const ACCOUNTS_FILE = `${GMAIL_DIR}/accounts.json`;
const STATE_FILE = `${GMAIL_DIR}/state.json`;
const SEEN_IDS_FILE = `${GMAIL_DIR}/seen-ids.json`;
const POLL_INTERVAL = Number(process.env.GMAIL_POLL_INTERVAL ?? 60000);
const MAX_BODY_LENGTH = Number(process.env.GMAIL_MAX_BODY_LENGTH ?? 500);
const API_TIMEOUT = 15_000; // 15s timeout for individual Gmail API calls
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

// ── Types ──

export interface GmailAccount {
  id: string;
  email: string;
  credentials: {
    client_id: string;
    client_secret: string;
    redirect_uri: string;
  };
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    expiry_date?: number;
    token_type?: string;
    scope?: string;
  };
}

interface GmailState {
  [accountId: string]: {
    lastHistoryId?: string;
    lastPollTime: number;
    lastMessageTimestamp: number;
  };
}

// ── Persistence ──

const accountsStore = new FileStore<GmailAccount[]>({ filePath: ACCOUNTS_FILE, defaultValue: [] });
const stateStore = new FileStore<GmailState>({ filePath: STATE_FILE, defaultValue: {} });
const seenIdsStore = new FileStore<string[]>({ filePath: SEEN_IDS_FILE, defaultValue: [] });

export function loadAccounts(): GmailAccount[] {
  return accountsStore.load();
}

export function saveAccounts(accounts: GmailAccount[]): void {
  accountsStore.save(accounts);
}

function loadState(): GmailState {
  return stateStore.load();
}

function saveState(state: GmailState): void {
  stateStore.save(state);
}

// ── Seen IDs (dedup) ──

const dedupCache = new DedupCache(200, 50);

// ── OAuth2 Client Factory ──

export function createOAuth2Client(account: GmailAccount): OAuth2Client {
  const client = new google.auth.OAuth2(
    account.credentials.client_id,
    account.credentials.client_secret,
    account.credentials.redirect_uri,
  );
  if (account.tokens) {
    client.setCredentials(account.tokens);
  }
  // Auto-refresh: update stored tokens when refreshed
  client.on("tokens", (tokens) => {
    log(`Tokens refreshed for ${account.id}`);
    const accounts = loadAccounts();
    const acc = accounts.find(a => a.id === account.id);
    if (acc) {
      acc.tokens = {
        ...acc.tokens,
        access_token: tokens.access_token ?? acc.tokens?.access_token,
        refresh_token: tokens.refresh_token ?? acc.tokens?.refresh_token,
        expiry_date: tokens.expiry_date ?? acc.tokens?.expiry_date,
        token_type: tokens.token_type ?? acc.tokens?.token_type,
        scope: tokens.scope ?? acc.tokens?.scope,
      };
      saveAccounts(accounts);
    }
  });
  return client;
}

export function getAuthUrl(account: GmailAccount, state?: string): string {
  const client = createOAuth2Client(account);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state: state || account.id,
  });
}

export async function handleAuthCallback(code: string, accountId: string): Promise<boolean> {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) {
    log(`Account ${accountId} not found for auth callback`);
    return false;
  }

  const client = createOAuth2Client(account);
  try {
    const { tokens } = await client.getToken(code);
    account.tokens = {
      access_token: tokens.access_token ?? undefined,
      refresh_token: tokens.refresh_token ?? undefined,
      expiry_date: tokens.expiry_date ?? undefined,
      token_type: tokens.token_type ?? undefined,
      scope: tokens.scope ?? undefined,
    };
    saveAccounts(accounts);
    log(`OAuth tokens saved for ${account.id} (${account.email})`);
    return true;
  } catch (err) {
    log(`OAuth token exchange failed for ${accountId}: ${err}`);
    return false;
  }
}

// ── Gmail API Operations ──

function getGmailClient(account: GmailAccount): gmail_v1.Gmail {
  const auth = createOAuth2Client(account);
  return google.gmail({ version: "v1", auth });
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function extractBody(payload: gmail_v1.Schema$MessagePart, maxDepth: number = 5): string {
  if (maxDepth <= 0) return "";

  // Simple text body
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart: recurse into parts
  if (payload.parts) {
    // Prefer text/plain over text/html
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Fallback: try nested multiparts
    for (const part of payload.parts) {
      if (part.parts) {
        const result = extractBody(part, maxDepth - 1);
        if (result) return result;
      }
    }
    // Last resort: html
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = decodeBase64Url(part.body.data);
        // Strip HTML tags for a rough text version
        return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
  }

  return "";
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  if (!headers) return "";
  const h = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

// ── Promotional Sender Filter ──
// Emails from these senders are dropped before becoming observations to avoid
// wasting brain context on inbox noise.  The calendar integration already tracks
// events, so calendar-notification emails are redundant.
const PROMOTIONAL_SENDER_PATTERNS: RegExp[] = [
  /ae-ug-ut-interest\d*@mail\.aliexpress\.com/i,
  /english-quora-digest@quora\.com/i,
  /autoscout24-news@mails\.autoscout24\.nl/i,
  /noreply@marktplaats\.nl/i,
  /messages-noreply@linkedin\.com/i,
  /calendar-notification@google\.com/i,
];

/**
 * Extract the bare email address from a From header value.
 * "Display Name <user@example.com>" → "user@example.com"
 */
function extractEmailAddress(from: string): string {
  const match = /<([^>]+)>/.exec(from);
  return match ? match[1] : from.trim();
}

function isPromotionalSender(from: string): boolean {
  const addr = extractEmailAddress(from);
  return PROMOTIONAL_SENDER_PATTERNS.some(re => re.test(addr));
}

async function fetchNewEmails(account: GmailAccount, state: GmailState): Promise<void> {
  if (!account.tokens?.refresh_token && !account.tokens?.access_token) {
    return; // Not authenticated yet
  }

  const gmail = getGmailClient(account);
  const accountState = state[account.id] || { lastPollTime: 0, lastMessageTimestamp: 0 };

  // Build query: messages received after our last poll
  // On first run, only get last hour to avoid flooding
  const sinceMs = accountState.lastMessageTimestamp || (Date.now() - 3600000);
  const sinceSeconds = Math.floor(sinceMs / 1000);
  const query = `after:${sinceSeconds} in:inbox -in:sent`;

  try {
    const listRes = await withTimeout(
      gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: 20,
      }),
      API_TIMEOUT,
      `gmail.messages.list(${account.id})`,
    );

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
      state[account.id] = { ...accountState, lastPollTime: Date.now() };
      return;
    }

    let newestTimestamp = accountState.lastMessageTimestamp;

    // Filter to valid message refs
    const validRefs = messages.filter(m => m.id);

    // Process a single message: fetch full content and record observation
    const processMessage = async (msgRef: gmail_v1.Schema$Message): Promise<void> => {
      const msgRes = await withTimeout(
        gmail.users.messages.get({
          userId: "me",
          id: msgRef.id!,
          format: "full",
        }),
        API_TIMEOUT,
        `gmail.messages.get(${account.id}/${msgRef.id})`,
      );

      const msg = msgRes.data;
      const internalDate = Number(msg.internalDate || 0);

      // Skip messages we've already seen (by timestamp and message ID)
      if (internalDate < accountState.lastMessageTimestamp) return;
      if (!dedupCache.track(msgRef.id!)) return;

      const headers = msg.payload?.headers;
      const from = getHeader(headers, "From");

      // Drop known promotional senders before they consume brain context
      if (isPromotionalSender(from)) {
        log(`Skipped promotional email from ${from}`);
        return;
      }

      const to = getHeader(headers, "To");
      const subject = getHeader(headers, "Subject");
      const body = msg.payload ? extractBody(msg.payload) : "";
      const snippet = msg.snippet || "";

      // Determine if this is an outgoing email
      const isFromMe = msg.labelIds?.includes("SENT") || false;

      // Record as observation
      const bodyPreview = body.length > MAX_BODY_LENGTH
        ? body.slice(0, MAX_BODY_LENGTH) + "... [truncated — full email in Gmail]"
        : body;

      recordObservation({
        timestamp: internalDate,
        sender: from,
        senderJid: `gmail:${account.id}`,
        isGroup: false,
        isFromMe,
        text: `[EMAIL] Subject: ${subject}\n\n${bodyPreview || snippet}`,
        source: "gmail",
        emailMeta: {
          from,
          to,
          subject,
          accountId: account.id,
          accountEmail: account.email,
          messageId: msgRef.id!,
        },
      });

      if (internalDate > newestTimestamp) {
        newestTimestamp = internalDate;
      }

      log(`New email in ${account.id}: "${subject}" from ${from}`);
    };

    // Fetch messages in parallel with concurrency limit of 5
    const CONCURRENCY = 5;
    for (let i = 0; i < validRefs.length; i += CONCURRENCY) {
      const chunk = validRefs.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(chunk.map(ref => processMessage(ref)));
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "rejected") {
          log(`Failed to fetch message ${chunk[j].id} from ${account.id}: ${(results[j] as PromiseRejectedResult).reason}`);
        }
      }
    }

    state[account.id] = {
      lastPollTime: Date.now(),
      lastMessageTimestamp: newestTimestamp || Date.now(),
    };
  } catch (err: unknown) {
    const apiErr = err as { status?: number; response?: { status?: number }; message?: string };
    if (apiErr.status === 401 || apiErr.response?.status === 401) {
      log(`Auth expired for ${account.id}, will retry after refresh`);
    } else if (apiErr.message?.includes("timed out")) {
      log(`Gmail API timeout for ${account.id}, skipping this polling cycle`);
    } else {
      log(`Gmail poll failed for ${account.id}: ${err instanceof Error ? err.message : err}`);
    }
    state[account.id] = { lastPollTime: Date.now(), lastMessageTimestamp: state[account.id]?.lastMessageTimestamp || 0 };
  }
}

// ── Send Email ──

export async function sendEmail(
  accountId: string,
  to: string,
  subject: string,
  body: string,
): Promise<{ success: boolean; error?: string }> {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) {
    return { success: false, error: `Account "${accountId}" not found` };
  }
  if (!account.tokens?.refresh_token && !account.tokens?.access_token) {
    return { success: false, error: `Account "${accountId}" not authenticated` };
  }

  // Action verifier gate — check whitelist and content safety
  const verifyResult = verify({
    type: "send_email",
    source: "think",
    targetJid: `gmail:${to}`,
    messageText: `[EMAIL to ${to}] Subject: ${subject}\n\n${body}`,
  });
  if (verifyResult.verdict === "blocked") {
    const reason = verifyResult.reasons.join("; ");
    log(`Verifier blocked email to ${to}: ${reason}`);
    return { success: false, error: `Blocked by verifier: ${reason}` };
  }

  const gmail = getGmailClient(account);

  // Sanitize headers to prevent header injection via \r\n
  const safeTo = to.replace(/[\r\n]/g, "");
  const safeSubject = subject.replace(/[\r\n]/g, "");

  // Build RFC 2822 email
  const emailLines = [
    `To: ${safeTo}`,
    `From: ${account.email}`,
    `Subject: ${safeSubject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    body,
  ];
  const raw = Buffer.from(emailLines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // Retry logic: up to 3 attempts with exponential backoff for transient failures
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await withTimeout(
        gmail.users.messages.send({
          userId: "me",
          requestBody: { raw },
        }),
        30000,
        "gmail-send"
      );
      log(`Email sent from ${account.id} to ${to}: "${subject}"`);
      logDelivery(to, "email", `[EMAIL to ${to}] Subject: ${subject}`);
      return { success: true };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const apiErr = err as { status?: number; code?: number; response?: { status?: number } };
      const status = apiErr.status || apiErr.code || apiErr.response?.status;
      const isTransient = !status || status >= 500 || errMsg.includes("timed out") || errMsg.includes("ECONNRESET");

      if (isTransient && attempt < MAX_RETRIES) {
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
        log(`Transient failure sending email (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delayMs}ms: ${errMsg}`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      log(`Failed to send email from ${account.id} (attempt ${attempt}/${MAX_RETRIES}): ${errMsg}`);
      return { success: false, error: errMsg };
    }
  }

  // Should not reach here, but satisfy TypeScript
  return { success: false, error: "Unexpected: exceeded retry loop" };
}

// ── Polling Loop ──

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startGmailPolling(): void {
  const ids = seenIdsStore.load();
  dedupCache.load(ids);
  if (ids.length > 0) log(`Loaded ${dedupCache.size} seen message IDs from disk`);

  const accounts = loadAccounts();
  const authenticated = accounts.filter(a => a.tokens?.refresh_token || a.tokens?.access_token);

  if (authenticated.length === 0) {
    log("No authenticated Gmail accounts, polling not started (will start when accounts are added)");
    return;
  }

  log(`Starting Gmail polling for ${authenticated.length} account(s) (every ${POLL_INTERVAL / 1000}s)`);

  // Initial poll after a short delay
  setTimeout(() => pollAllAccounts(), 5000);

  pollTimer = setInterval(() => pollAllAccounts(), POLL_INTERVAL);
}

export function stopGmailPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log("Gmail polling stopped");
  }
}

export function restartGmailPolling(): void {
  stopGmailPolling();
  startGmailPolling();
}

async function pollAllAccounts(): Promise<void> {
  if (!isIntegrationEnabled("gmail")) return;
  const accounts = loadAccounts();
  const state = loadState();

  for (const account of accounts) {
    if (!account.tokens?.refresh_token && !account.tokens?.access_token) continue;
    try {
      await fetchNewEmails(account, state);
    } catch (err) {
      log(`Poll error for ${account.id}: ${err}`);
    }
  }

  saveState(state);
  dedupCache.saveTo(SEEN_IDS_FILE);
}

// ── Account Management ──

export function addAccount(id: string, email: string, clientId: string, clientSecret: string, redirectUri: string): GmailAccount {
  ensureDir(GMAIL_DIR);
  const accounts = loadAccounts();

  const existing = accounts.find(a => a.id === id);
  if (existing) {
    existing.email = email;
    existing.credentials = { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri };
    saveAccounts(accounts);
    log(`Updated account ${id}`);
    return existing;
  }

  const account: GmailAccount = {
    id,
    email,
    credentials: {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    },
  };
  accounts.push(account);
  saveAccounts(accounts);
  log(`Added account ${id} (${email})`);
  return account;
}

export function removeAccount(id: string): boolean {
  const accounts = loadAccounts();
  const idx = accounts.findIndex(a => a.id === id);
  if (idx === -1) return false;
  accounts.splice(idx, 1);
  saveAccounts(accounts);
  log(`Removed account ${id}`);
  return true;
}

export function getAccountStatus(): Array<{ id: string; email: string; authenticated: boolean; lastPoll: number; hasCalendarWrite: boolean }> {
  const accounts = loadAccounts();
  const state = loadState();
  return accounts.map(a => ({
    id: a.id,
    email: a.email,
    authenticated: !!(a.tokens?.refresh_token || a.tokens?.access_token),
    lastPoll: state[a.id]?.lastPollTime || 0,
    hasCalendarWrite: !!(a.tokens?.scope && a.tokens.scope.includes('calendar.events')),
  }));
}
