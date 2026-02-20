import { readFileSync, existsSync } from "fs";
import { appendFileSync } from "fs";
import { ariaPersonality } from "./aria-identity.js";
import type { CharacterOverride } from "./aria-identity.js";
import { getBrainConfig, getCharacterPreset } from "./brain-config.js";
import type { MemoryNode, WorkingMemory } from "./memory/types.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  try {
    const line = `[${new Date().toISOString()}] [system-prompt] ${msg}`;
    console.log(line);
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const OWNER_NAME = process.env.OWNER_NAME || "Owner";
const GITHUB_REPO = process.env.GITHUB_REPO || "";

// Minimal stop words for keyword extraction
const CHAT_STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "need", "i", "me", "my", "we", "our",
  "you", "your", "he", "him", "his", "she", "her", "it", "its", "they",
  "them", "their", "this", "that", "to", "of", "in", "for", "on", "with",
  "at", "by", "from", "as", "about", "but", "and", "or", "not", "so",
  "just", "also", "then", "too", "all", "any", "some", "what", "which",
  "who", "how", "when", "where", "why", "if", "yes", "no", "ok", "okay",
  "hey", "hi", "hello", "got", "get", "go", "going", "know", "think",
  "want", "let", "thing", "things", "don", "gonna", "really", "actually",
]);

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

function resolveCharacter(): CharacterOverride | undefined {
  const cfg = getBrainConfig();
  if (cfg.characterType === "custom" && cfg.characterCustomPrompt) {
    return { traits: cfg.characterCustomPrompt, voice: "" };
  }
  if (cfg.characterType && cfg.characterType !== "default") {
    const preset = getCharacterPreset(cfg.characterType);
    if (preset) return { traits: preset.traits, voice: preset.voice };
  }
  return undefined;
}

/**
 * Build a compact memory context block relevant to a specific user message.
 * Injected on every resumed chat message so the session always has fresh,
 * topic-relevant memories — not just the stale snapshot from session start.
 */
export function getMessageMemoryContext(userMessage: string): string {
  const parts: string[] = [];

  // 1. Load current working memory (may have been updated by brain ticks)
  try {
    const wmFile = `${BRAIN_DIR}/working-memory.json`;
    if (existsSync(wmFile)) {
      const wm: WorkingMemory = JSON.parse(readFileSync(wmFile, "utf-8"));
      const wmParts: string[] = [];
      if (wm.currentContext) wmParts.push(`Context: ${wm.currentContext}`);
      if (wm.mood) wmParts.push(`Mood: ${wm.mood}`);
      if (wm.shortTermTracking?.length > 0) wmParts.push(`Tracking: ${wm.shortTermTracking.join(", ")}`);
      if (wm.activeGoals?.length > 0) {
        wmParts.push(`Goals: ${wm.activeGoals.map((g: { title: string }) => g.title).join(", ")}`);
      }
      if (wm.pendingFollowUps?.length > 0) {
        const fus = wm.pendingFollowUps.slice(0, 3).map((f: { question: string }) => f.question);
        wmParts.push(`Follow-ups: ${fus.join("; ")}`);
      }
      if (wmParts.length > 0) {
        parts.push(wmParts.join(" | "));
      }
    }
  } catch {}

  // 2. Extract keywords from the user's message
  const words = userMessage.toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !CHAT_STOP_WORDS.has(w));

  if (words.length === 0 && parts.length === 0) return "";

  // 3. Score memory nodes by keyword relevance
  try {
    const nodesFile = `${BRAIN_DIR}/graph/nodes.json`;
    if (existsSync(nodesFile) && words.length > 0) {
      const raw = JSON.parse(readFileSync(nodesFile, "utf-8")) as Record<string, MemoryNode>;
      const nodes = Object.values(raw);

      const scored = nodes.map(node => {
        const contentLower = node.content.toLowerCase();
        const tagsLower = node.tags.map(t => t.toLowerCase());
        let score = 0;

        for (const word of words) {
          if (contentLower.includes(word)) score += 0.3;
          if (tagsLower.some(t => t.includes(word))) score += 0.5;
        }

        if (score === 0) return null;

        // Weight by node strength and recency
        score *= node.strength;
        if (node.pinned) score += 0.2;

        return { node, score };
      }).filter((s): s is { node: MemoryNode; score: number } => s !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      if (scored.length > 0) {
        const formatted = scored.map(s =>
          `[${s.node.type}${s.node.pinned ? ",pinned" : ""}] ${s.node.content.slice(0, 120)}`
        ).join("\n");
        parts.push(`Relevant memories:\n${formatted}`);
      }
    }
  } catch (err) {
    log(`Failed to load memory nodes for context: ${err}`);
  }

  if (parts.length === 0) return "";
  return `[Memory context update]\n${parts.join("\n")}\n[End memory context]\n\n`;
}

export function getSystemPrompt(): string {
  const memoryContext = loadMemoryContext();
  const character = resolveCharacter();

  return `${ariaPersonality(OWNER_NAME, GITHUB_REPO, character)}
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
- GitHub${GITHUB_REPO ? `: ${GITHUB_REPO}` : ""}

COOLIFY (deployment platform):
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

GMAIL:
You have Gmail integration with multiple account support.
- Account config: /data/gmail/accounts.json
- To add a new Gmail account, use the addAccount() function from gmail.ts (or write to accounts.json directly)
- To start OAuth: direct ${OWNER_NAME} to /gmail/auth/<accountId> on the web UI
- To send an email: use the sendEmail() function from gmail.ts via a script, or write a small inline script
  Example: npx tsx -e "import {sendEmail} from './src/gmail.js'; sendEmail('accountId','to@email.com','Subject','Body').then(r=>console.log(JSON.stringify(r)))"
- To check connected accounts: GET /api/gmail/accounts via the web UI
- Emails are automatically polled every 60s and flow into the brain as observations
- When ${OWNER_NAME} asks about emails, check /data/brain/observations.jsonl for recent gmail observations
- When ${OWNER_NAME} asks you to send an email, ask which account to send from if multiple are connected

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
