/**
 * Slack CLI — ARIA's tool for talking to people (or their agents) on Slack.
 *
 * Usage (from /app):
 *   npx tsx backend/scripts/slack-cli.ts users [--workspace newstory] [--match marvin]
 *   npx tsx backend/scripts/slack-cli.ts talk <userId> --name "Marvin" --goal "..." [--opening "..."] [--filter "..."]
 *   npx tsx backend/scripts/slack-cli.ts dm <userId|channelId> --text "..."
 *   npx tsx backend/scripts/slack-cli.ts thread <userId|channelId> [--limit 20]
 *   npx tsx backend/scripts/slack-cli.ts end <userId>
 *   npx tsx backend/scripts/slack-cli.ts scopes
 *
 * `talk` creates (or updates) the per-contact reply directive that lets ARIA
 * answer that user and describes the goal of the conversation, then sends the
 * opening message. Without a directive ARIA never replies on Slack.
 */

import { findUsers, sendSlackMessage, probeScopes, loadWorkspaces, slackUserJid, parseSlackJid, openDm } from "../integrations/slack.js";
import { getReplyDirectives, addReplyDirective, updateReplyDirective, removeReplyDirective } from "../reply-agent.js";
import { getObservationsSince } from "../observer.js";

export type CliCommand =
  | { command: "users"; workspace?: string; match?: string }
  | { command: "talk"; userId: string; workspace?: string; name?: string; goal: string; opening?: string; filter?: string }
  | { command: "dm"; to: string; workspace?: string; text: string }
  | { command: "thread"; to: string; workspace?: string; limit: number }
  | { command: "end"; userId: string; workspace?: string }
  | { command: "scopes"; workspace?: string };

const USAGE = `Usage:
  slack-cli.ts users [--workspace id] [--match text]
  slack-cli.ts talk <userId> --goal "..." [--name "..."] [--opening "..."] [--filter "..."] [--workspace id]
  slack-cli.ts dm <userId|channelId> --text "..." [--workspace id]
  slack-cli.ts thread <userId|channelId> [--limit N] [--workspace id]
  slack-cli.ts end <userId> [--workspace id]
  slack-cli.ts scopes [--workspace id]`;

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  const value = rest[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positional(rest: string[], what: string): string {
  const v = rest[0];
  if (!v || v.startsWith("--")) throw new Error(`${what} is required`);
  return v;
}

export function parseCliArgs(argv: string[]): CliCommand {
  const [command, ...rest] = argv;
  const workspace = flag(rest, "--workspace");
  if (command === "users") return { command: "users", workspace, match: flag(rest, "--match") };
  if (command === "talk") {
    const goal = flag(rest, "--goal");
    if (!goal || goal.length < 10) throw new Error("talk requires --goal (at least 10 chars)");
    return { command: "talk", userId: positional(rest, "userId").toUpperCase(), workspace, name: flag(rest, "--name"), goal, opening: flag(rest, "--opening"), filter: flag(rest, "--filter") };
  }
  if (command === "dm") {
    const text = flag(rest, "--text");
    if (!text) throw new Error("dm requires --text");
    return { command: "dm", to: positional(rest, "recipient").toUpperCase(), workspace, text };
  }
  if (command === "thread") {
    const raw = flag(rest, "--limit");
    const limit = raw === undefined ? 20 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("--limit must be an integer 1-200");
    return { command: "thread", to: positional(rest, "recipient").toUpperCase(), workspace, limit };
  }
  if (command === "end") return { command: "end", userId: positional(rest, "userId").toUpperCase(), workspace };
  if (command === "scopes") return { command: "scopes", workspace };
  throw new Error(USAGE);
}

function resolveWorkspace(id?: string): string {
  const workspaces = loadWorkspaces();
  if (id) {
    if (!workspaces.some(w => w.id === id)) throw new Error(`workspace "${id}" not found (have: ${workspaces.map(w => w.id).join(", ")})`);
    return id;
  }
  const authed = workspaces.filter(w => w.tokens?.access_token);
  if (authed.length === 0) throw new Error("no authenticated Slack workspace");
  return authed[0].id;
}

export const DEFAULT_FILTER = "Reply to every message in this direct conversation unless the other side explicitly asks to stop.";

async function main() {
  const cmd = parseCliArgs(process.argv.slice(2));
  const workspace = resolveWorkspace(cmd.workspace);

  if (cmd.command === "users") {
    const users = (await findUsers(workspace, cmd.match ?? "")).filter(u => !u.deleted);
    for (const u of users) console.log(`${u.id}  ${u.realName || u.name}${u.isBot ? "  [bot]" : ""}`);
    console.log(`${users.length} users`);
    return;
  }

  if (cmd.command === "talk") {
    const contactJid = slackUserJid(workspace, cmd.userId);
    const existing = getReplyDirectives().find(d => d.contactJid === contactJid);
    const directive = existing
      ? updateReplyDirective(existing.id, { replyPrompt: cmd.goal, filterPrompt: cmd.filter ?? DEFAULT_FILTER, enabled: true, contactName: cmd.name ?? existing.contactName })
      : addReplyDirective({ contactJid, contactName: cmd.name ?? cmd.userId, filterPrompt: cmd.filter ?? DEFAULT_FILTER, replyPrompt: cmd.goal, enabled: true });
    console.log(`Conversation directive ${directive?.id} active for ${cmd.name ?? cmd.userId} (${contactJid}).`);
    if (cmd.opening) {
      const sent = await sendSlackMessage(workspace, cmd.userId, cmd.opening);
      console.log(sent.success ? `Opening message sent (DM ${sent.channelId}).` : `Opening message failed: ${sent.error}`);
    }
    return;
  }

  if (cmd.command === "dm") {
    const sent = await sendSlackMessage(workspace, cmd.to, cmd.text);
    console.log(sent.success ? `Sent to ${sent.channelId}.` : `Failed: ${sent.error}`);
    if (!sent.success) process.exit(1);
    return;
  }

  if (cmd.command === "thread") {
    let channelId = cmd.to;
    if (!/^[CDG]/.test(cmd.to)) {
      const dm = await openDm(workspace, cmd.to);
      if ("error" in dm) throw new Error(dm.error);
      channelId = dm.channelId;
    }
    const chat = `slack:${workspace}:${channelId}`;
    const rows = getObservationsSince(Date.now() - 7 * 86_400_000, { source: "slack" }, 2000)
      .filter(o => (o.chatJid || o.senderJid) === chat)
      .slice(-cmd.limit);
    for (const o of rows) console.log(`[${new Date(o.timestamp).toISOString().slice(0, 16)}] ${o.isFromMe ? "ARIA" : o.sender}: ${o.text.replace(/^\[SLACK[^\]]*\]\s*/, "")}`);
    console.log(`${rows.length} messages in ${chat}`);
    return;
  }

  if (cmd.command === "end") {
    const contactJid = slackUserJid(workspace, cmd.userId);
    const d = getReplyDirectives().find(x => x.contactJid === contactJid);
    if (!d) { console.log(`No conversation directive for ${contactJid}.`); return; }
    console.log(removeReplyDirective(d.id) ? `Ended conversation with ${d.contactName ?? cmd.userId}.` : "Could not remove directive.");
    return;
  }

  const probe = await probeScopes(workspace);
  console.log(probe.ok ? `Token OK for bot ${probe.user}; all scopes present.` : `Missing scopes: ${probe.missing}\nWanted: ${probe.wanted}`);
  void parseSlackJid;
}

const invokedDirectly = process.argv[1]?.endsWith("slack-cli.ts");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`Error: ${err.message ?? err}`);
    process.exit(1);
  });
}
