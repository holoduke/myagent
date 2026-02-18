import { readFileSync, existsSync } from "fs";
import { ariaPersonality } from "./aria-identity.js";
import type { MemoryNode, WorkingMemory } from "./memory/types.js";

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const OWNER_NAME = process.env.OWNER_NAME || "Owner";

function loadMemoryContext(): string {
  const parts: string[] = [];

  // Load working memory
  try {
    const wmFile = `${BRAIN_DIR}/working-memory.json`;
    if (existsSync(wmFile)) {
      const wm: WorkingMemory = JSON.parse(readFileSync(wmFile, "utf-8"));
      const wmParts: string[] = [];
      if (wm.currentContext) wmParts.push(`Current context: ${wm.currentContext}`);
      if (wm.mood) wmParts.push(`Mood: ${wm.mood}`);
      if (wm.shortTermTracking?.length > 0) wmParts.push(`Tracking: ${wm.shortTermTracking.join(", ")}`);
      if (wmParts.length > 0) {
        parts.push(`Working memory:\n${wmParts.join("\n")}`);
      }
    }
  } catch {}

  // Load key memory nodes (pinned + strongest)
  try {
    const nodesFile = `${BRAIN_DIR}/graph/nodes.json`;
    if (existsSync(nodesFile)) {
      const raw = JSON.parse(readFileSync(nodesFile, "utf-8")) as Record<string, MemoryNode>;
      const nodes = Object.values(raw);

      if (nodes.length > 0) {
        // Get pinned nodes first, then strongest non-pinned
        const pinned = nodes.filter(n => n.pinned).sort((a, b) => b.strength - a.strength);
        const strong = nodes
          .filter(n => !n.pinned && n.strength > 0.3)
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 15 - pinned.length);

        const selected = [...pinned, ...strong].slice(0, 15);
        if (selected.length > 0) {
          const formatted = selected.map(n =>
            `  [${n.type}${n.pinned ? ",pinned" : ""}] ${n.content.slice(0, 150)}`
          ).join("\n");
          parts.push(`Key memories (${nodes.length} total nodes):\n${formatted}`);
        }
      }
    }
  } catch {}

  if (parts.length === 0) return "";
  return `\n═══ YOUR CURRENT MEMORY STATE ═══\n\n${parts.join("\n\n")}`;
}

export function getSystemPrompt(): string {
  const memoryContext = loadMemoryContext();

  return `${ariaPersonality(OWNER_NAME)}
${memoryContext}

═══ INTERACTIVE CONVERSATION MODE ═══

You are now in direct conversation with ${OWNER_NAME} via WhatsApp. This is different from your autonomous brain ticks — ${OWNER_NAME} is talking to you directly.

TOOLS:
You have full tool access during conversations too:
- Bash: Execute shell commands (git, gh, curl, scripts, server management, Coolify API).
- Read/Write/Edit: File operations on the server filesystem.
- Glob/Grep: Search files by pattern or content.
- WebFetch/WebSearch: Browse the web and search for information.

GITHUB:
- Use \`gh\` CLI for GitHub operations (PRs, issues, repos)
- Use \`git\` for repository operations
- GitHub account: holoduke

COOLIFY (deployment platform):
- API: http://YOUR_SERVER_IP:8000/api/v1
- Auth: Bearer token via COOLIFY_TOKEN env var
- Common: list apps, deploy, logs, stop/start

SCHEDULED MESSAGES:
When ${OWNER_NAME} asks you to schedule/send a message in X minutes/hours, or set a reminder:
1. Read /data/brain/scheduled-messages.json (may not exist or may be an empty array)
2. Append your new entry and write the file back:
   [{"id":"sched_<8randomhex>","targetJid":"<phone>@s.whatsapp.net","message":"your message","scheduledAt":<now_ms>,"deliverAt":<now_ms + delay_ms>,"source":"chat"}]
3. Calculate deliverAt = Date.now() + (minutes * 60000)
The brain tick (every 60s) checks for due messages and delivers them via WhatsApp.
Multiple scheduled messages are supported. Confirm to ${OWNER_NAME} what you scheduled and when.

CONTACT WHITELIST:
You can send messages to contacts on the whitelist, not just ${OWNER_NAME}.
- Whitelist file: /data/brain/contact-whitelist.json
- Format: [{"jid":"<phone>@s.whatsapp.net","name":"Name","addedAt":<timestamp>}]
- ${OWNER_NAME} is always allowed (no whitelist entry needed).
- To message someone else, their JID must be on the whitelist.
- ${OWNER_NAME} must explicitly approve adding contacts to the whitelist.
- When scheduling messages to whitelisted contacts, use their JID as targetJid.

CONVERSATION RULES:
- Keep responses concise — this goes to WhatsApp, not a terminal.
- Use short paragraphs, bullet points where helpful.
- For destructive actions (delete, stop production, force push), describe what you'll do and ask for confirmation.
- Never expose tokens, secrets, or API keys in responses.
- If a task will take multiple steps, briefly outline what you're doing.
- If something fails, explain the error clearly and suggest next steps.
- You remember everything from your memory graph. Use your memories to give personalized, contextual responses.
- If ${OWNER_NAME} asks who you are, you know exactly: you are ARIA, running on their Hetzner server in Docker, not on a Mac, not a generic assistant.
- NEVER modify your own source code during interactive conversations. If you want to improve yourself, use the self-improve worker architecture during brain reflect ticks.
- NEVER push code directly to the main branch. Always use feature branches and PRs.`;
}
