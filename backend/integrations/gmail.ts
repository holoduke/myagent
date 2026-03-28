import { google, gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { FileStore, atomicWriteJSON, ensureDir } from "../utils/file-store.js";
import { recordObservation } from "../observer.js";
import { isIntegrationEnabled } from "./integration-config.js";
import { logDelivery } from "../scheduler.js";
import { createLogger } from "../logger.js";

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

function loadSeenIds(): void {
  const ids = seenIdsStore.load();
  seenMessageIds.clear();
  for (const id of ids) {
    seenMessageIds.add(id);
  }
  if (ids.length > 0) {
    log(`Loaded ${seenMessageIds.size} seen message IDs from disk`);
  }
}

function saveSeenIds(): void {
  // Keep only the most recent MAX_SEEN_IDS entries (tail of the set = newest)
  const allIds = Array.from(seenMessageIds);
  const toSave = allIds.length > MAX_SEEN_IDS ? allIds.slice(allIds.length - MAX_SEEN_IDS) : allIds;
  atomicWriteJSON(SEEN_IDS_FILE, toSave, 0);
}

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

export function getAuthUrl(account: GmailAccount): string {
  const client = createOAuth2Client(account);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state: account.id,
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

// Track recently seen message IDs to avoid duplicates at timestamp boundaries
const seenMessageIds = new Set<string>();
const MAX_SEEN_IDS = 200;

function trackMessageId(id: string): boolean {
  if (seenMessageIds.has(id)) return false;
  seenMessageIds.add(id);
  // Prune if too large
  if (seenMessageIds.size > MAX_SEEN_IDS) {
    const iter = seenMessageIds.values();
    for (let i = 0; i < 50; i++) {
      const val = iter.next().value;
      if (val) seenMessageIds.delete(val);
    }
  }
  return true;
}

// ── Timeout Helper ──

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms / 1000}s`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
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
      if (!trackMessageId(msgRef.id!)) return;

      const headers = msg.payload?.headers;
      const from = getHeader(headers, "From");
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
  } catch (err: any) {
    if (err.status === 401 || err.response?.status === 401) {
      log(`Auth expired for ${account.id}, will retry after refresh`);
    } else if (err.message?.includes("timed out")) {
      log(`Gmail API timeout for ${account.id}, skipping this polling cycle`);
    } else {
      log(`Gmail poll failed for ${account.id}: ${err.message || err}`);
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

  const gmail = getGmailClient(account);

  // Build RFC 2822 email
  const emailLines = [
    `To: ${to}`,
    `From: ${account.email}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    body,
  ];
  const raw = Buffer.from(emailLines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

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
  } catch (err: any) {
    const errMsg = err.message || String(err);
    log(`Failed to send email from ${account.id}: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

// ── Polling Loop ──

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startGmailPolling(): void {
  loadSeenIds();

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
  saveSeenIds();
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
