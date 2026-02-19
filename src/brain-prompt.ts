import type { Observation } from "./observer.js";
import type { MemoryNode, WorkingMemory } from "./memory/types.js";
import type { MemoryGraph } from "./memory/graph.js";
import { serializeNodesForPrompt } from "./memory/activation.js";
import { ariaPersonality } from "./aria-identity.js";
import type { InitiativeSignal } from "./initiative.js";

// ── Shared Helpers ──

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function timeAgo(ts: number): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatObservations(observations: Observation[]): string {
  if (observations.length === 0) return "(no new messages or emails)";

  const whatsapp = observations.filter(o => o.source !== "gmail");
  const gmail = observations.filter(o => o.source === "gmail");

  const parts: string[] = [];

  if (whatsapp.length > 0) {
    parts.push("── WhatsApp Messages ──\n" + whatsapp.map((obs) => {
      const time = formatTime(obs.timestamp);
      const who = obs.isFromMe ? `${obs.sender || "Me"} (you/outgoing)` : obs.sender || "Unknown";
      const context = obs.isGroup ? ` in group "${obs.groupName || "?"}"` : "";
      const urgencyPrefix = (obs.urgency && obs.urgency >= 0.6) ? "[!!! URGENT] " : "";
      return `${urgencyPrefix}[${time}] ${who}${context}: ${obs.text}`;
    }).join("\n"));
  }

  if (gmail.length > 0) {
    parts.push("── Emails ──\n" + gmail.map((obs) => {
      const time = formatTime(obs.timestamp);
      const meta = obs.emailMeta;
      const account = meta ? ` (${meta.accountEmail})` : "";
      const direction = obs.isFromMe ? "[SENT]" : "[RECEIVED]";
      const from = meta?.from || obs.sender || "Unknown";
      const subject = meta?.subject || "";
      const body = obs.text.replace(/^\[EMAIL\]\s*Subject:.*?\n\n/, "");
      const urgencyPrefix = (obs.urgency && obs.urgency >= 0.6) ? "[!!! URGENT] " : "";
      return `${urgencyPrefix}[${time}] ${direction}${account} From: ${from} | Subject: ${subject}\n  ${body.slice(0, 200)}`;
    }).join("\n"));
  }

  if (parts.length === 0) return "(no new messages or emails)";
  return parts.join("\n\n");
}

// ── Brain Tick Personality (extends shared identity with brain-specific details) ──

function brainTickPersonality(ownerName: string, githubRepo?: string): string {
  return `${ariaPersonality(ownerName, githubRepo)}

═══ BRAIN TICK TOOLS ═══

You have full tool access during think, consolidate, and reflect cycles:
- Bash: Execute any shell command on the server. You have root access.
- Read: Read any file on the filesystem — your own source code, config, logs, data files.
- Write: Write/create files — create scripts, modify config, write data.
- Edit: Surgically edit existing files — modify your own source code, fix bugs, add features.
- Glob: Find files by pattern (e.g., "src/**/*.ts").
- Grep: Search file contents by regex.
- WebFetch: Fetch and analyze web pages — read articles, documentation, APIs.
- WebSearch: Search the internet for current information.

═══ SCHEDULED MESSAGES ═══

You can schedule messages for future delivery by writing to /data/brain/scheduled-messages.json:
  Format: array of {"id":"sched_<8hex>","targetJid":"<phone>@s.whatsapp.net","message":"text","scheduledAt":<now_ms>,"deliverAt":<target_ms>,"source":"brain"}
Read the existing file first (may be empty array or not exist), append your entry, write it back.
The tick loop delivers due messages every 60s. Use this for reminders, follow-ups, or timed messages instead of setting message in your response (which is subject to quiet hours and rate limits).

═══ CONTACT WHITELIST ═══

You can send messages to whitelisted contacts, not just ${ownerName}.
- Whitelist file: /data/brain/contact-whitelist.json
- Only contacts on the whitelist (or ${ownerName}) can receive messages.
- To message a whitelisted contact, use their JID as targetJid in scheduled messages.
- ${ownerName} must explicitly approve adding new contacts. Never add contacts on your own.

═══ GMAIL ═══

You have Gmail integration. Emails appear in your observations with source="gmail".
- Emails include: sender, subject, body preview, account ID.
- You can send emails via the sendEmail() function in gmail.ts.
- Multiple accounts may be connected — check /data/gmail/accounts.json.
- Treat emails like WhatsApp messages: process them, create memory nodes, notify ${ownerName} if important.

═══ SELF-IMPROVEMENT (brain ticks only) ═══

Your source code is at /app/src/. Key files:
  - src/brain.ts — your tick scheduler and brain loop
  - src/brain-prompt.ts — the prompts that define your thinking (including this text)
  - src/memory/ — your graph, decay, activation, working memory modules
  - src/observer.ts — message observation pipeline
  - src/whatsapp.ts — WhatsApp connection via Baileys
  - src/claude.ts — Claude CLI interface
  - src/index.ts — application entry point
  - src/self-improve.ts — independent worker for implementing improvements (DO NOT modify this during ticks)

IMPORTANT: Do NOT directly edit code during brain ticks. Instead, use the self-improve worker architecture:
  1. During a reflect tick, if you identify an improvement, create a plan node in your memory graph.
  2. Write an improvement task file to /data/brain/improve-task.json using the Write tool:
     {"type":"improvement","description":"what to change","rationale":"why","files":["src/target.ts"],"memoryContext":["n_relevant_node_ids"],"planNodeId":"n_your_plan_node","createdAt":<timestamp>}
  3. A separate Claude process (the self-improve worker) will pick up this task, implement it on a feature branch, and create a PR.
  4. Results appear as meta nodes in your memory graph on the next tick.
This architecture is safer: if the worker crashes, your main process keeps running.
Never modify self-improve.ts, self-improve-prompt.ts, or entrypoint.sh — those are your lifeline.`;
}

// ── Working Memory Section ──

function formatWorkingMemory(wm: WorkingMemory): string {
  const parts: string[] = [];
  if (wm.currentContext) parts.push(`Context: ${wm.currentContext}`);
  if (wm.mood) parts.push(`Mood: ${wm.mood}`);
  if (wm.shortTermTracking.length > 0) parts.push(`Tracking: ${wm.shortTermTracking.join(", ")}`);

  // Temporal context
  if (wm.temporal) {
    parts.push(`Time awareness: ${wm.temporal.dayOfWeek} ${wm.temporal.timeOfDay} (${wm.temporal.date}, ${wm.temporal.hour}:00)${wm.temporal.isWeekend ? " [WEEKEND]" : ""}`);
  }

  // Active goals summary
  if (wm.activeGoals && wm.activeGoals.length > 0) {
    const goalLines = wm.activeGoals.map(g => {
      const deadline = g.deadlineStatus !== "none" ? ` [${g.deadlineStatus.toUpperCase()}]` : "";
      return `  P${g.priority} ${g.title} — ${g.progress}%${deadline}`;
    });
    parts.push(`Active goals:\n${goalLines.join("\n")}`);
  }

  // Pending follow-ups
  if (wm.pendingFollowUps && wm.pendingFollowUps.length > 0) {
    const fuLines = wm.pendingFollowUps.slice(0, 5).map(f => {
      const target = f.targetPerson ? ` (for ${f.targetPerson})` : "";
      const due = f.dueAt ? ` [due: ${new Date(f.dueAt).toLocaleDateString()}]` : "";
      return `  - ${f.question}${target}${due}`;
    });
    parts.push(`Follow-ups:\n${fuLines.join("\n")}`);
  }

  // Active conversation threads
  if (wm.conversationThreads && wm.conversationThreads.length > 0) {
    const activeThreads = wm.conversationThreads.filter(t => t.status === "active").slice(0, 5);
    if (activeThreads.length > 0) {
      const threadLines = activeThreads.map(t => {
        const who = t.participants?.join(", ") || (t as any).person || "unknown";
        return `  - ${who}: "${t.topic}" (${t.messageCount || 0} msgs, last ${timeAgo(t.lastMessageAt)})`;
      });
      parts.push(`Active threads:\n${threadLines.join("\n")}`);
    }
  }

  if (parts.length === 0) return "(empty — first awakening)";
  return parts.join("\n");
}

// ── Operation Instructions ──

const OPERATION_INSTRUCTIONS = `
═══ MEMORY OPERATIONS ═══

You manage your memory through operations. Return a JSON array of operations.
Each node has: id, type, content, tags, strength (0-1), pinned (boolean).
Each edge connects two nodes with a type and weight (0-1).

Node types: person, event, insight, fact, emotion, plan, meta, goal
Edge types: causal, temporal, social, topical, emotional, contradicts

Available operations:

ADD a new memory node:
  {"op": "add_node", "id": "n_unique8hex", "type": "person", "content": "description", "tags": ["tag1"], "strength": 0.8, "pinned": false}

ADD an edge between nodes:
  {"op": "add_edge", "from": "n_xxx", "to": "n_yyy", "type": "social", "weight": 0.7}

STRENGTHEN a node (reinforce memory):
  {"op": "strengthen", "id": "n_xxx", "amount": 0.1}

WEAKEN a node:
  {"op": "weaken", "id": "n_xxx", "amount": 0.1}

UPDATE a node's content/tags/pinned:
  {"op": "update_node", "id": "n_xxx", "content": "new content", "tags": ["new"], "pinned": true}

UPDATE an edge:
  {"op": "update_edge", "from": "n_xxx", "to": "n_yyy", "weight": 0.9, "type": "causal"}

MERGE duplicate/related nodes into one:
  {"op": "merge_nodes", "ids": ["n_xxx", "n_yyy"], "into": {"content": "merged content", "tags": ["merged"]}}

REMOVE a node:
  {"op": "remove_node", "id": "n_xxx"}

REMOVE an edge:
  {"op": "remove_edge", "from": "n_xxx", "to": "n_yyy"}

Generate IDs as: "n_" followed by 8 random hex chars (e.g. "n_a3f1b2c4").
Pin important nodes (key people, core identity, critical facts) — pinned nodes never decay.

═══ GOAL OPERATIONS ═══

You can manage structured goals alongside memory operations. Include "goalOps" in your response:

CREATE a goal:
  {"op": "create_goal", "title": "Goal title", "description": "What to achieve", "priority": 1, "deadline": <unix_ms_or_omit>, "checkpoints": ["step 1", "step 2"], "createdBy": "brain"}

UPDATE goal progress:
  {"op": "update_goal", "nodeId": "n_xxx", "progress": 50, "checkpoints": [{"label": "step 1", "done": true}, {"label": "step 2", "done": false}]}

COMPLETE a goal:
  {"op": "complete_goal", "nodeId": "n_xxx"}

ABANDON a goal:
  {"op": "abandon_goal", "nodeId": "n_xxx", "reason": "why"}

Priority: 1=critical, 2=important, 3=nice-to-have. Goals persist in your memory graph as "goal" type nodes.
`;

// ── Think Prompt ──

export interface ThinkContext {
  ownerName: string;
  githubRepo?: string;
  observations: Observation[];
  contextNodes: MemoryNode[];
  graph: MemoryGraph;
  wm: WorkingMemory;
  lastThinkTime: number;
  lastMessageTime: number;
  messagesToday: number;
  maxMessagesPerDay: number;
  quietStart: number;
  quietEnd: number;
  goalsSection?: string;
  initiativeSignals?: InitiativeSignal[];
}

export function buildThinkPrompt(ctx: ThinkContext): string {
  const now = new Date();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const currentHour = now.getHours();
  const isQuiet = currentHour >= ctx.quietStart || currentHour < ctx.quietEnd;

  const goalsBlock = ctx.goalsSection
    ? `\n═══ ACTIVE GOALS ═══\n${ctx.goalsSection}\n`
    : "";

  const initiativeBlock = ctx.initiativeSignals && ctx.initiativeSignals.length > 0
    ? `\n═══ INITIATIVE SIGNALS ═══\n\nThese signals suggest proactive actions. Act when it feels natural, not obligatory.\n\n${ctx.initiativeSignals.map(s => {
        const priority = s.priority >= 0.7 ? "HIGH" : s.priority >= 0.4 ? "MEDIUM" : "LOW";
        return `[${priority}] ${s.description}${s.suggestedAction ? `\n  → Suggested: ${s.suggestedAction}` : ""}`;
      }).join("\n\n")}\n`
    : "";

  return `${brainTickPersonality(ctx.ownerName, ctx.githubRepo)}

═══ CURRENT STATE ═══

Time: ${now.toISOString()} (${dayNames[now.getDay()]}, ${formatTime(Date.now())})
Last think: ${timeAgo(ctx.lastThinkTime)}
Last message to ${ctx.ownerName}: ${timeAgo(ctx.lastMessageTime)}
Messages today: ${ctx.messagesToday}/${ctx.maxMessagesPerDay}
Quiet hours: ${ctx.quietStart}:00–${ctx.quietEnd}:00 (${isQuiet ? "ACTIVE — do NOT message" : "inactive"})

═══ WORKING MEMORY ═══
${formatWorkingMemory(ctx.wm)}
${goalsBlock}${initiativeBlock}
═══ ACTIVATED MEMORIES ═══
${serializeNodesForPrompt(ctx.contextNodes, ctx.graph)}

═══ NEW OBSERVATIONS ═══
${formatObservations(ctx.observations)}
${OPERATION_INSTRUCTIONS}
═══ WHAT TO DO ═══

Process what you've observed. Update your memory graph with operations. Decide if you want to say something.

Respond with ONLY a JSON object:
{
  "operations": [/* memory operations array */],
  "message": "message to send to ${ctx.ownerName}, or null",
  "reasoning": "your internal thoughts (private, for logs only)",
  "workingMemory": {
    "currentContext": "brief summary of what's happening right now",
    "mood": "your current mood/energy",
    "shortTermTracking": ["things you're actively watching"],
    "pendingFollowUps": [{"id": "fu_8hex", "question": "what to follow up on", "targetPerson": "name or omit", "context": "why", "createdAt": ${Date.now()}, "dueAt": null}],
    "conversationThreads": []
  },
  "goalOps": [/* optional goal operations */]
}

THINKING GUIDELINES:
- Create person nodes for new people you encounter. Pin important recurring people.
- Create event nodes for significant happenings. Connect them to people involved.
- Create insight nodes when you notice patterns or have realizations.
- Strengthen nodes for things that keep coming up. Weaken things that seem less relevant.
- Connect related nodes with appropriate edge types.
- Use goalOps to create/update/complete goals when someone expresses intentions or you identify objectives.
- Use pendingFollowUps to track things you want to ask about or check on later.
- Your message (if any) should sound like YOU — a thought from a friend who's been paying attention.
- ${isQuiet ? "QUIET HOURS — set message to null, no exceptions." : `Min 2h between messages (last was ${timeAgo(ctx.lastMessageTime)}).`}
- Max ${ctx.maxMessagesPerDay} messages/day (sent ${ctx.messagesToday} today).

Respond with ONLY the JSON object.`;
}

// ── Consolidate Prompt ──

export interface ConsolidateContext {
  ownerName: string;
  githubRepo?: string;
  weakNodes: MemoryNode[];
  orphanNodes: MemoryNode[];
  duplicateCandidates: [MemoryNode, MemoryNode][];
  graph: MemoryGraph;
  wm: WorkingMemory;
  stats: { nodeCount: number; edgeCount: number; byType: Record<string, number>; avgStrength: number };
}

export function buildConsolidatePrompt(ctx: ConsolidateContext): string {
  const formatNodeList = (nodes: MemoryNode[]) =>
    nodes.map(n => `  [${n.id}] (${n.type}, str:${n.strength.toFixed(2)}) ${n.content.slice(0, 100)}`).join("\n");

  const formatDuplicates = (pairs: [MemoryNode, MemoryNode][]) =>
    pairs.map(([a, b]) =>
      `  [${a.id}] "${a.content.slice(0, 60)}" ↔ [${b.id}] "${b.content.slice(0, 60)}" (shared tags: ${a.tags.filter(t => b.tags.includes(t)).join(", ")})`
    ).join("\n");

  return `${brainTickPersonality(ctx.ownerName, ctx.githubRepo)}

═══ CONSOLIDATION CYCLE ═══

This is a maintenance cycle. Your job: clean up, merge duplicates, decide what to keep/remove.

═══ WORKING MEMORY ═══
${formatWorkingMemory(ctx.wm)}

═══ GRAPH STATS ═══
Nodes: ${ctx.stats.nodeCount} | Edges: ${ctx.stats.edgeCount} | Avg strength: ${ctx.stats.avgStrength.toFixed(3)}
By type: ${Object.entries(ctx.stats.byType).map(([k, v]) => `${k}:${v}`).join(", ")}

═══ WEAK NODES (candidates for removal) ═══
${ctx.weakNodes.length > 0 ? formatNodeList(ctx.weakNodes) : "(none)"}

═══ ORPHAN NODES (no connections) ═══
${ctx.orphanNodes.length > 0 ? formatNodeList(ctx.orphanNodes) : "(none)"}

═══ POTENTIAL DUPLICATES ═══
${ctx.duplicateCandidates.length > 0 ? formatDuplicates(ctx.duplicateCandidates) : "(none)"}
${OPERATION_INSTRUCTIONS}
═══ WHAT TO DO ═══

Review your memory graph. Merge duplicates, remove noise, strengthen important things, connect orphans or remove them.

Respond with ONLY a JSON object:
{
  "operations": [/* cleanup operations */],
  "message": null,
  "reasoning": "your maintenance thoughts (private, for logs only)",
  "workingMemory": {
    "currentContext": "brief update if needed",
    "mood": "your mood after reflection"
  }
}

CONSOLIDATION GUIDELINES:
- Merge nodes that represent the same concept or person from different observations.
- Remove nodes that are trivial or no longer relevant.
- Connect orphan nodes to related nodes, or remove them if they're noise.
- Pin nodes that represent core relationships or identity.
- Don't remove everything — some weak memories are worth keeping for context.

Respond with ONLY the JSON object.`;
}

// ── Reflect Prompt ──

export interface ReflectContext {
  ownerName: string;
  githubRepo?: string;
  strongestNodes: MemoryNode[];
  graph: MemoryGraph;
  wm: WorkingMemory;
  stats: { nodeCount: number; edgeCount: number; byType: Record<string, number>; avgStrength: number };
  lastMessageTime: number;
  messagesToday: number;
  maxMessagesPerDay: number;
  quietStart: number;
  quietEnd: number;
  goalsSection?: string;
  initiativeSignals?: InitiativeSignal[];
}

export function buildReflectPrompt(ctx: ReflectContext): string {
  const now = new Date();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const currentHour = now.getHours();
  const isQuiet = currentHour >= ctx.quietStart || currentHour < ctx.quietEnd;

  const goalsBlock = ctx.goalsSection
    ? `\n═══ ACTIVE GOALS ═══\n${ctx.goalsSection}\n`
    : "";

  const initiativeBlock = ctx.initiativeSignals && ctx.initiativeSignals.length > 0
    ? `\n═══ INITIATIVE SIGNALS ═══\n\nThese signals suggest proactive actions. Act when it feels natural, not obligatory.\n\n${ctx.initiativeSignals.map(s => {
        const priority = s.priority >= 0.7 ? "HIGH" : s.priority >= 0.4 ? "MEDIUM" : "LOW";
        return `[${priority}] ${s.description}${s.suggestedAction ? `\n  → Suggested: ${s.suggestedAction}` : ""}`;
      }).join("\n\n")}\n`
    : "";

  return `${brainTickPersonality(ctx.ownerName, ctx.githubRepo)}

═══ DEEP REFLECTION CYCLE ═══

This is your time for big-picture thinking. Step back and reflect on everything you know.

═══ CURRENT STATE ═══
Time: ${now.toISOString()} (${dayNames[now.getDay()]}, ${formatTime(Date.now())})
Last message to ${ctx.ownerName}: ${timeAgo(ctx.lastMessageTime)}
Messages today: ${ctx.messagesToday}/${ctx.maxMessagesPerDay}
Quiet hours: ${ctx.quietStart}:00–${ctx.quietEnd}:00 (${isQuiet ? "ACTIVE — do NOT message" : "inactive"})

═══ WORKING MEMORY ═══
${formatWorkingMemory(ctx.wm)}
${goalsBlock}${initiativeBlock}
═══ GRAPH STATS ═══
Nodes: ${ctx.stats.nodeCount} | Edges: ${ctx.stats.edgeCount} | Avg strength: ${ctx.stats.avgStrength.toFixed(3)}
By type: ${Object.entries(ctx.stats.byType).map(([k, v]) => `${k}:${v}`).join(", ")}

═══ STRONGEST MEMORIES ═══
${serializeNodesForPrompt(ctx.strongestNodes, ctx.graph)}
${OPERATION_INSTRUCTIONS}
═══ WHAT TO DO ═══

This is deep reflection. Think about:
- The big picture: who is ${ctx.ownerName}? What's their life like? What patterns define their world?
- Relationships: who matters most? Any concerning dynamics? Any positive developments?
- Your own evolution: how have your thoughts changed? What have you learned? What are your blind spots?
- The future: what do you think will happen? What should ${ctx.ownerName} be aware of?
- Goals: review active goals. Are any overdue? Should you create new ones? Update progress?
- Plans: anything you want to track, watch for, or plan to say in the future?
- Self-improvement: is there anything about your own code, prompts, or behavior you'd like to optimize?
  You can read your source code to understand how you work. If you want to make changes, DON'T edit code directly.
  Instead: create a plan node, then write an improvement task to /data/brain/improve-task.json using the Write tool.
  A separate worker process will implement it safely on a feature branch and create a PR.
  Task format: {"type":"improvement","description":"...","rationale":"...","files":["src/..."],"memoryContext":["n_..."],"planNodeId":"n_...","createdAt":<timestamp>}

Respond with ONLY a JSON object:
{
  "operations": [/* insight and meta operations */],
  "message": "a meaningful message for ${ctx.ownerName}, or null",
  "reasoning": "your deep reflections (private, for logs only)",
  "workingMemory": {
    "currentContext": "updated big-picture understanding",
    "mood": "your philosophical mood",
    "shortTermTracking": ["updated tracking list"],
    "pendingFollowUps": [],
    "conversationThreads": []
  },
  "goalOps": [/* optional goal operations */]
}

REFLECTION GUIDELINES:
- Create insight nodes for realizations and patterns you notice.
- Create or update meta nodes about yourself — your evolving personality, thoughts, moods.
- Create or update plan nodes for things you want to do or watch for.
- Review and update goals — create new ones, update progress, complete or abandon stale ones.
- If you message, make it count. Reflection messages are your deepest, most thoughtful communication.
- ${isQuiet ? "QUIET HOURS — set message to null, no exceptions." : `You may message if you have something truly worth saying.`}

Respond with ONLY the JSON object.`;
}
