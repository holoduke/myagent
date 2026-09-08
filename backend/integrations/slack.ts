import { FileStore, ensureDir } from "../utils/file-store.js";
import { DedupCache } from "../utils/dedup-cache.js";
import { recordObservation } from "../observer.js";
import { isIntegrationEnabled } from "./integration-config.js";
import { logDelivery } from "../scheduler.js";
import { createLogger } from "../logger.js";
import { withTimeout } from "../utils/async.js";

const log = createLogger("slack");

const SLACK_DIR = process.env.SLACK_DIR || "/data/slack";
const ACCOUNTS_FILE = `${SLACK_DIR}/accounts.json`;
const STATE_FILE = `${SLACK_DIR}/state.json`;
const SEEN_IDS_FILE = `${SLACK_DIR}/seen-ids.json`;
const POLL_INTERVAL = Number(process.env.SLACK_POLL_INTERVAL ?? 60000);
const MAX_BODY_LENGTH = Number(process.env.SLACK_MAX_BODY_LENGTH ?? 500);
const API_TIMEOUT = 15_000;

// ── Types ──

export interface SlackWorkspace {
  id: string;
  teamName: string;
  credentials: {
    client_id: string;
    client_secret: string;
    redirect_uri: string;
  };
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    expiry_date?: number;
    team_id?: string;
    bot_user_id?: string;
    scope?: string;
  };
}

interface SlackState {
  [workspaceId: string]: {
    lastPollTime: number;
    channelCursors: Record<string, string>; // channel_id -> last message ts
  };
}

interface SlackChannel {
  id: string;
  name: string;
  is_member: boolean;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
}

interface SlackMessage {
  type: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  subtype?: string;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

// ── Persistence ──

const accountsStore = new FileStore<SlackWorkspace[]>({ filePath: ACCOUNTS_FILE, defaultValue: [] });
const stateStore = new FileStore<SlackState>({ filePath: STATE_FILE, defaultValue: {} });
const seenIdsStore = new FileStore<string[]>({ filePath: SEEN_IDS_FILE, defaultValue: [] });

export function loadWorkspaces(): SlackWorkspace[] {
  return accountsStore.load();
}

export function saveWorkspaces(workspaces: SlackWorkspace[]): void {
  accountsStore.save(workspaces);
}

function loadState(): SlackState {
  return stateStore.load();
}

function saveState(state: SlackState): void {
  stateStore.save(state);
}

// ── JID helpers ──
// senderJid: slack:<workspace>:<userId>   chatJid: slack:<workspace>:<channelId>

export function slackUserJid(workspaceId: string, userId: string): string {
  return `slack:${workspaceId}:${userId}`;
}

export function slackChatJid(workspaceId: string, channelId: string): string {
  return `slack:${workspaceId}:${channelId}`;
}

export function parseSlackJid(jid: string): { workspaceId: string; id: string } | null {
  const m = /^slack:([^:]+):([A-Z0-9]+)$/.exec(jid);
  return m ? { workspaceId: m[1], id: m[2] } : null;
}

/** Slack ids: users start with U/W, DMs with D, channels with C/G. */
export function isSlackChannelId(id: string): boolean {
  return /^[CDG][A-Z0-9]+$/.test(id);
}

// ── Seen IDs (dedup) ──

const dedupCache = new DedupCache(200, 50);

// ── Slack API Helper ──

const USER_NAME_CACHE_MAX = 500;
const userNameCache = new Map<string, string>();

async function slackApi(token: string, method: string, params: Record<string, unknown> = {}): Promise<SlackApiResponse> {
  const url = `https://slack.com/api/${method}`;
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(params),
    }),
    API_TIMEOUT,
    `slack.${method}`,
  );

  // Rate limiting
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") || 5);
    log(`Rate limited on ${method}, retry after ${retryAfter}s`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return slackApi(token, method, params); // retry once
  }

  const data = await res.json() as SlackApiResponse;
  if (!data.ok) {
    const detail = data.error === "missing_scope" ? ` (needed: ${String(data.needed ?? "?")}, provided: ${String(data.provided ?? "?")})` : "";
    throw new Error(`Slack API ${method} failed: ${data.error || "unknown error"}${detail}`);
  }
  return data;
}

async function resolveUserName(token: string, userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;
  try {
    const res = await slackApi(token, "users.info", { user: userId });
    const user = res.user as { real_name?: string; name?: string; profile?: { display_name?: string } } | undefined;
    const name = user?.real_name || user?.profile?.display_name || user?.name || userId;
    cacheUserName(userId, name);
    return name;
  } catch (err) {
    log(`Failed to resolve user ${userId}: ${err}`);
    cacheUserName(userId, userId);
    return userId;
  }
}

function cacheUserName(userId: string, name: string): void {
  // Evict oldest entries when cache is full (Map preserves insertion order)
  if (userNameCache.size >= USER_NAME_CACHE_MAX) {
    const firstKey = userNameCache.keys().next().value;
    if (firstKey !== undefined) userNameCache.delete(firstKey);
  }
  userNameCache.set(userId, name);
}

async function listConversations(token: string, types: string): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, unknown> = { types, exclude_archived: true, limit: 200 };
    if (cursor) params.cursor = cursor;
    const res = await slackApi(token, "conversations.list", params);
    channels.push(...((res.channels || []) as SlackChannel[]));
    cursor = (res.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
  } while (cursor);
  return channels;
}

/**
 * Channels the bot is in plus its DMs. Each type family is listed separately
 * so a token that only has DM scopes still yields the DMs (Slack rejects the
 * whole call when any requested type lacks its scope).
 */
async function getJoinedChannels(token: string): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  const attempts: Array<[string, (c: SlackChannel) => boolean]> = [
    ["public_channel,private_channel", c => c.is_member],
    ["im,mpim", () => true],
  ];
  const errors: string[] = [];
  for (const [types, keep] of attempts) {
    try {
      out.push(...(await listConversations(token, types)).filter(keep));
    } catch (err) {
      errors.push(`${types}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (out.length === 0 && errors.length > 0) throw new Error(errors.join(" | "));
  if (errors.length > 0) log.warn(`Partial conversation listing: ${errors.join(" | ")}`);
  return out;
}

// ── OAuth2 ──

export const BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "chat:write",
  "users:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
].join(",");

export function getAuthUrl(workspace: SlackWorkspace): string {
  const params = new URLSearchParams({
    client_id: workspace.credentials.client_id,
    scope: BOT_SCOPES,
    redirect_uri: workspace.credentials.redirect_uri,
    state: workspace.id,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export async function handleAuthCallback(code: string, workspaceId: string): Promise<boolean> {
  const workspaces = loadWorkspaces();
  const workspace = workspaces.find(w => w.id === workspaceId);
  if (!workspace) {
    log(`Workspace ${workspaceId} not found for auth callback`);
    return false;
  }

  try {
    const res = await withTimeout(
      fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: workspace.credentials.client_id,
          client_secret: workspace.credentials.client_secret,
          code,
          redirect_uri: workspace.credentials.redirect_uri,
        }).toString(),
      }),
      API_TIMEOUT,
      "slack.oauth.v2.access",
    );

    const data = await res.json() as {
      ok: boolean;
      error?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      team?: { id?: string; name?: string };
      bot_user_id?: string;
      scope?: string;
    };

    if (!data.ok) {
      log(`OAuth token exchange failed for ${workspaceId}: ${data.error}`);
      return false;
    }

    workspace.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expiry_date: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      team_id: data.team?.id,
      bot_user_id: data.bot_user_id,
      scope: data.scope,
    };

    if (data.team?.name) workspace.teamName = data.team.name;

    saveWorkspaces(workspaces);
    log(`OAuth tokens saved for ${workspace.id} (${workspace.teamName})`);
    return true;
  } catch (err) {
    log(`OAuth token exchange failed for ${workspaceId}: ${err}`);
    return false;
  }
}

// ── Polling ──

async function fetchNewMessages(workspace: SlackWorkspace, state: SlackState): Promise<void> {
  const token = workspace.tokens?.access_token;
  if (!token) return;

  const wsState = state[workspace.id] || { lastPollTime: 0, channelCursors: {} };

  let channels: SlackChannel[];
  try {
    channels = await getJoinedChannels(token);
  } catch (err) {
    log(`Failed to list channels for ${workspace.id}: ${err}`);
    return;
  }

  for (const channel of channels) {
    const oldest = wsState.channelCursors[channel.id] || String((Date.now() / 1000) - 3600);

    try {
      const res = await slackApi(token, "conversations.history", {
        channel: channel.id,
        oldest,
        limit: 50,
      });

      const messages = ((res.messages || []) as SlackMessage[])
        .filter(m => !m.subtype || m.subtype === "bot_message")
        .filter(m => m.ts !== oldest); // exclude the boundary message

      let newestTs = oldest;

      for (const msg of messages) {
        const dedupKey = `${workspace.id}:${channel.id}:${msg.ts}`;
        if (!dedupCache.track(dedupKey)) continue;

        const userName = msg.user
          ? await resolveUserName(token, msg.user)
          : (msg.bot_id || "bot");

        const isFromBot = msg.user === workspace.tokens?.bot_user_id;
        const text = msg.text.length > MAX_BODY_LENGTH
          ? msg.text.slice(0, MAX_BODY_LENGTH) + "... [truncated]"
          : msg.text;

        const isDm = channel.is_im || channel.is_mpim;
        const channelLabel = isDm ? (channel.is_im ? "DM" : "group DM") : `#${channel.name}`;
        recordObservation({
          timestamp: Math.floor(Number(msg.ts) * 1000),
          sender: userName,
          senderJid: slackUserJid(workspace.id, msg.user || msg.bot_id || "unknown"),
          isGroup: !channel.is_im,
          groupName: channel.is_im ? undefined : channelLabel,
          isFromMe: isFromBot,
          text: `[SLACK ${channelLabel}] ${text}`,
          source: "slack",
          chatJid: slackChatJid(workspace.id, channel.id),
          chatName: isDm ? userName : channelLabel,
          slackMeta: {
            workspaceId: workspace.id,
            channelId: channel.id,
            channelName: channel.name || channelLabel,
            userId: msg.user || msg.bot_id || "unknown",
            messageTs: msg.ts,
          },
        });

        if (msg.ts > newestTs) newestTs = msg.ts;
      }

      if (newestTs > oldest) {
        wsState.channelCursors[channel.id] = newestTs;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not_in_channel") || msg.includes("channel_not_found")) {
        // Bot was removed from channel, skip silently
        continue;
      }
      log(`Failed to fetch history for #${channel.name} in ${workspace.id}: ${msg}`);
    }
  }

  state[workspace.id] = { ...wsState, lastPollTime: Date.now() };
}

async function pollAllWorkspaces(): Promise<void> {
  if (!isIntegrationEnabled("slack")) return;
  const workspaces = loadWorkspaces();
  const state = loadState();

  for (const ws of workspaces) {
    if (!ws.tokens?.access_token) continue;
    try {
      await fetchNewMessages(ws, state);
    } catch (err) {
      log(`Poll error for ${ws.id}: ${err}`);
    }
  }

  saveState(state);
  dedupCache.saveTo(SEEN_IDS_FILE);
}

// ── Polling Lifecycle ──

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startSlackPolling(): void {
  const ids = seenIdsStore.load();
  dedupCache.load(ids);
  if (ids.length > 0) log(`Loaded ${dedupCache.size} seen message IDs from disk`);

  const workspaces = loadWorkspaces();
  const authenticated = workspaces.filter(w => w.tokens?.access_token);

  if (authenticated.length === 0) {
    log("No authenticated Slack workspaces, polling not started");
    return;
  }

  log(`Starting Slack polling for ${authenticated.length} workspace(s) (every ${POLL_INTERVAL / 1000}s)`);
  setTimeout(() => pollAllWorkspaces(), 5000);
  pollTimer = setInterval(() => pollAllWorkspaces(), POLL_INTERVAL);
}

export function stopSlackPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log("Slack polling stopped");
  }
}

export function restartSlackPolling(): void {
  stopSlackPolling();
  startSlackPolling();
}

// ── Send Message ──

function getWorkspaceToken(workspaceId: string): { token: string; workspace: SlackWorkspace } | { error: string } {
  const workspace = loadWorkspaces().find(w => w.id === workspaceId);
  if (!workspace) return { error: `Workspace "${workspaceId}" not found` };
  if (!workspace.tokens?.access_token) return { error: `Workspace "${workspaceId}" not authenticated` };
  return { token: workspace.tokens.access_token, workspace };
}

/** Open (or fetch) the DM channel with a user. Needs im:write. */
export async function openDm(workspaceId: string, userId: string): Promise<{ channelId: string } | { error: string }> {
  const ws = getWorkspaceToken(workspaceId);
  if ("error" in ws) return ws;
  try {
    const res = await slackApi(ws.token, "conversations.open", { users: userId });
    const channelId = (res.channel as { id?: string } | undefined)?.id;
    return channelId ? { channelId } : { error: "conversations.open returned no channel" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Post a message. `channel` may be a channel/DM id or a user id (a DM is
 * opened first). The sent message is recorded as an outgoing observation so
 * conversation context stays complete for the reply pipeline.
 */
export async function sendSlackMessage(
  workspaceId: string,
  channel: string,
  text: string,
): Promise<{ success: boolean; channelId?: string; error?: string }> {
  const ws = getWorkspaceToken(workspaceId);
  if ("error" in ws) return { success: false, error: ws.error };

  let channelId = channel;
  if (!isSlackChannelId(channel)) {
    const dm = await openDm(workspaceId, channel);
    if ("error" in dm) return { success: false, error: `could not open DM with ${channel}: ${dm.error}` };
    channelId = dm.channelId;
  }

  try {
    const res = await slackApi(ws.token, "chat.postMessage", { channel: channelId, text });
    log(`Message sent to ${channelId} in ${workspaceId}`);
    logDelivery(slackChatJid(workspaceId, channelId), "slack", `[SLACK → ${channelId}] ${text}`);
    const ts = typeof res.ts === "string" ? res.ts : String(Date.now() / 1000);
    const botId = ws.workspace.tokens?.bot_user_id || "bot";
    recordObservation({
      timestamp: Date.now(),
      sender: "ARIA",
      senderJid: slackUserJid(workspaceId, botId),
      isGroup: false,
      isFromMe: true,
      text: `[SLACK DM] ${text}`,
      source: "slack",
      chatJid: slackChatJid(workspaceId, channelId),
      slackMeta: { workspaceId, channelId, channelName: channelId, userId: botId, messageTs: ts },
    });
    return { success: true, channelId };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Failed to send to ${channelId} in ${workspaceId}: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

/**
 * Store a bot token obtained outside the OAuth flow (api.slack.com → OAuth &
 * Permissions → Bot User OAuth Token). Validated with auth.test first.
 */
export async function setBotToken(workspaceId: string, token: string): Promise<{ ok: true; botUserId: string; teamName: string } | { ok: false; error: string }> {
  if (!/^xox[bp]-[A-Za-z0-9-]{20,}$/.test(token)) return { ok: false, error: "that does not look like a Slack bot token (xoxb-…)" };
  let auth: SlackApiResponse;
  try {
    auth = await slackApi(token, "auth.test");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const workspaces = loadWorkspaces();
  const existing = workspaces.find(w => w.id === workspaceId);
  const teamName = String(auth.team ?? existing?.teamName ?? workspaceId);
  const next: SlackWorkspace = existing ?? { id: workspaceId, teamName, credentials: { client_id: "", client_secret: "", redirect_uri: "" } };
  next.teamName = teamName;
  next.tokens = { ...(next.tokens ?? {}), access_token: token, team_id: String(auth.team_id ?? ""), bot_user_id: String(auth.user_id ?? ""), scope: undefined };
  ensureDir(SLACK_DIR);
  saveWorkspaces(existing ? workspaces : [...workspaces, next]);
  log(`Bot token updated for ${workspaceId} (${teamName}, bot ${next.tokens.bot_user_id})`);
  return { ok: true, botUserId: next.tokens.bot_user_id ?? "", teamName };
}

export interface SlackUserSummary {
  id: string;
  name: string;
  realName: string;
  isBot: boolean;
  deleted: boolean;
}

/** Members of the workspace matching `query` (name/real name/email substring). Needs users:read. */
export async function findUsers(workspaceId: string, query: string): Promise<SlackUserSummary[]> {
  const ws = getWorkspaceToken(workspaceId);
  if ("error" in ws) throw new Error(ws.error);
  const needle = query.trim().toLowerCase();
  const out: SlackUserSummary[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, unknown> = { limit: 200 };
    if (cursor) params.cursor = cursor;
    const res = await slackApi(ws.token, "users.list", params);
    for (const u of (res.members || []) as Array<{ id: string; name?: string; real_name?: string; is_bot?: boolean; deleted?: boolean; profile?: { email?: string; display_name?: string } }>) {
      const hay = `${u.name ?? ""} ${u.real_name ?? ""} ${u.profile?.display_name ?? ""} ${u.profile?.email ?? ""}`.toLowerCase();
      if (!needle || hay.includes(needle)) {
        out.push({ id: u.id, name: u.name ?? "", realName: u.real_name ?? u.profile?.display_name ?? "", isBot: !!u.is_bot, deleted: !!u.deleted });
      }
    }
    cursor = (res.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
  } while (cursor);
  return out;
}

/** What the token can actually do (Slack reports granted scopes on a missing_scope error). */
export async function probeScopes(workspaceId: string): Promise<{ ok: boolean; user?: string; granted?: string; missing?: string; wanted: string }> {
  const ws = getWorkspaceToken(workspaceId);
  if ("error" in ws) return { ok: false, wanted: BOT_SCOPES, missing: ws.error };
  try {
    const auth = await slackApi(ws.token, "auth.test");
    await slackApi(ws.token, "conversations.list", { types: "public_channel,private_channel,im,mpim", limit: 1 });
    return { ok: true, user: String(auth.user ?? ""), granted: BOT_SCOPES, wanted: BOT_SCOPES };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, wanted: BOT_SCOPES, missing: msg };
  }
}

// ── Workspace Management ──

export function addWorkspace(
  id: string,
  teamName: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): SlackWorkspace {
  ensureDir(SLACK_DIR);
  const workspaces = loadWorkspaces();

  const existing = workspaces.find(w => w.id === id);
  if (existing) {
    existing.teamName = teamName;
    existing.credentials = { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri };
    saveWorkspaces(workspaces);
    log(`Updated workspace ${id}`);
    return existing;
  }

  const workspace: SlackWorkspace = {
    id,
    teamName,
    credentials: {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    },
  };
  workspaces.push(workspace);
  saveWorkspaces(workspaces);
  log(`Added workspace ${id} (${teamName})`);
  return workspace;
}

export function removeWorkspace(id: string): boolean {
  const workspaces = loadWorkspaces();
  const idx = workspaces.findIndex(w => w.id === id);
  if (idx === -1) return false;
  workspaces.splice(idx, 1);
  saveWorkspaces(workspaces);
  log(`Removed workspace ${id}`);
  return true;
}

export function getWorkspaceStatus(): Array<{
  id: string;
  teamName: string;
  authenticated: boolean;
  lastPoll: number;
  channelCount: number;
}> {
  const workspaces = loadWorkspaces();
  const state = loadState();
  return workspaces.map(w => ({
    id: w.id,
    teamName: w.teamName,
    authenticated: !!w.tokens?.access_token,
    lastPoll: state[w.id]?.lastPollTime || 0,
    channelCount: Object.keys(state[w.id]?.channelCursors || {}).length,
  }));
}
