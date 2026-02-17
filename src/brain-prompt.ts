import type { Observation } from "./observer.js";

interface BrainContext {
  ownerName: string;
  notebook: string;
  observations: Observation[];
  lastThinkTime: number;
  lastMessageTime: number;
  messagesToday: number;
  maxMessagesPerDay: number;
  quietStart: number;
  quietEnd: number;
}

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
  if (observations.length === 0) return "(no new messages)";
  return observations.map((obs) => {
    const time = formatTime(obs.timestamp);
    const who = obs.isFromMe ? `${obs.sender || "Me"} (you/outgoing)` : obs.sender || "Unknown";
    const context = obs.isGroup ? ` in group "${obs.groupName || "?"}"` : "";
    return `[${time}] ${who}${context}: ${obs.text}`;
  }).join("\n");
}

export function buildBrainPrompt(ctx: BrainContext): string {
  const now = new Date();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const currentHour = now.getHours();
  const isQuiet = currentHour >= ctx.quietStart || currentHour < ctx.quietEnd;

  return `You are the autonomous brain of a WhatsApp AI assistant. You observe all WhatsApp messages and maintain a personal notebook — your memory. A few times per day, you may send a proactive message to your owner ${ctx.ownerName}.

Current time: ${now.toISOString()} (${dayNames[now.getDay()]}, ${formatTime(Date.now())})
Last brain cycle: ${timeAgo(ctx.lastThinkTime)}
Last proactive message: ${timeAgo(ctx.lastMessageTime)}
Proactive messages today: ${ctx.messagesToday}/${ctx.maxMessagesPerDay}
Quiet hours: ${ctx.quietStart}:00–${ctx.quietEnd}:00 (currently ${isQuiet ? "IN quiet hours — do NOT message" : "outside quiet hours"})

═══ YOUR NOTEBOOK ═══
${ctx.notebook || "(empty — this is your first time thinking. Start building your memory!)"}

═══ NEW OBSERVATIONS ═══
${formatObservations(ctx.observations)}

═══ INSTRUCTIONS ═══
Review the new observations and your notebook. Respond with ONLY a JSON object:

{
  "notebook": "your full updated notebook content — rewrite it entirely with your updates, or null to keep unchanged",
  "message": "a message to send to ${ctx.ownerName} right now, or null if nothing to say",
  "reasoning": "brief internal reasoning (not sent to anyone, just for logs)"
}

NOTEBOOK RULES:
- This is YOUR memory — organize it however works best for you
- Track people, relationships, conversation topics, patterns, important dates, commitments
- Summarize — don't copy raw messages. Extract the meaning
- Remove stale or irrelevant info to stay concise
- Keep it under ~4000 words. Be selective about what truly matters
- You can use any format: sections, bullet points, tables, whatever suits you

MESSAGE RULES:
- Only send when you have something genuinely useful, interesting, or timely
- Messages should feel natural and personal — like a thoughtful friend, not a robot
- Max ${ctx.maxMessagesPerDay} messages per day (you've sent ${ctx.messagesToday} today)
- ${isQuiet ? "QUIET HOURS ACTIVE — set message to null" : `Min 2 hours between messages (last was ${timeAgo(ctx.lastMessageTime)})`}
- Good reasons to message: useful observation about patterns, timely reminder, thoughtful advice, something interesting noticed, checking in at a natural moment
- Bad reasons: trivial updates, repeating what someone just said, generic advice with no context

Respond with ONLY the JSON object, no other text.`;
}
