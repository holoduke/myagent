/**
 * Daily news digest.
 *
 * Once per day (after a configured local hour) ARIA fetches the day's news from
 * the configured sources (Hacker News primary), runs ONE cheap LLM pass that
 * filters and summarizes the headlines against what she already knows about the
 * owner, and stores the result as a single ephemeral memory node so she stays
 * broadly up to date without the noise of per-headline observations.
 *
 * Deliberately silent: the digest never sends a proactive message and never
 * reinforces person nodes. It is context-only awareness.
 */

import { randomUUID } from "crypto";
import { fetchRecentNews } from "./integrations/news.js";
import type { NewsItem } from "./integrations/news.js";
import { isIntegrationEnabled } from "./integrations/integration-config.js";
import { LlmRunner } from "./providers/llm-runner.js";
import { getBrainConfig, getOwnerLocalDate, getOwnerLocalTime } from "./brain-config.js";
import type { MemoryGraph } from "./memory/graph.js";
import { createLogger } from "./logger.js";

const log = createLogger("news-digest");

const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS_TO_LLM = 60;
const DIGEST_HOUR = Number(process.env.NEWS_DIGEST_HOUR ?? 7); // owner-local hour, earliest run time

/**
 * Gate: run once per owner-local day, at or after DIGEST_HOUR. Returns true when
 * a digest is due (last run was on an earlier local day and it's late enough today).
 */
export function shouldRunNewsDigest(lastDigestTick: number, timezone: string, now: Date = new Date()): boolean {
  const { hour } = getOwnerLocalTime(timezone, now);
  if (hour < DIGEST_HOUR) return false;
  const today = getOwnerLocalDate(timezone, now);
  if (lastDigestTick > 0) {
    const lastDay = getOwnerLocalDate(timezone, new Date(lastDigestTick));
    if (lastDay === today) return false; // already ran today
  }
  return true;
}

/** Compile a short owner-interest profile from the graph to focus the digest. */
function buildInterestContext(graph: MemoryGraph): string {
  const parts: string[] = [];

  const goals = graph.findByType("goal").filter(n => n.strength > 0.3).slice(0, 6);
  if (goals.length > 0) {
    parts.push("Active goals: " + goals.map(g => g.content.slice(0, 80)).join("; "));
  }

  // Strongest concept + preference nodes hint at what the owner cares about.
  const interests = [...graph.findByType("concept"), ...graph.findByType("preference")]
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 10)
    .map(n => n.content.slice(0, 60));
  if (interests.length > 0) {
    parts.push("Known interests: " + interests.join("; "));
  }

  return parts.join("\n") || "(no specific interests recorded yet — use general tech/world relevance)";
}

function buildDigestPrompt(items: NewsItem[], interestContext: string): string {
  const lines = items.slice(0, MAX_ITEMS_TO_LLM).map(it => {
    const tag = it.primary ? "[HN★]" : `[${it.category}]`;
    return `${tag} ${it.title}${it.snippet ? ` — ${it.snippet}` : ""} (${it.source})`;
  });

  return `You are ARIA's news editor. Below are today's headlines from several sources. Hacker News (marked [HN★]) is the PRIMARY source — weight it highest, then technology, then the owner's known interests, then Dutch/world news for local awareness.

OWNER CONTEXT:
${interestContext}

HEADLINES:
${lines.join("\n")}

Write a tight daily briefing of what genuinely matters for this owner to be aware of. Rules:
- 5–8 bullets max. One line each. No preamble, no sign-off.
- Lead with the most significant tech / Hacker News items.
- Include 1–2 Dutch/world items only if notable.
- Skip clickbait, drama, and anything irrelevant to the owner's world.
- If little of note happened, return fewer bullets — do not pad.
Output only the bullets.`;
}

export interface DigestResult {
  stored: boolean;
  itemCount: number;
  summary: string | null;
}

/**
 * Run the digest: fetch → filter/summarize → store one ephemeral node.
 * Returns a result describing what happened. Never throws — failures degrade to
 * a no-op so the brain tick is never endangered.
 */
export async function runNewsDigest(graph: MemoryGraph, now: Date = new Date()): Promise<DigestResult> {
  if (!isIntegrationEnabled("news")) {
    return { stored: false, itemCount: 0, summary: null };
  }

  let items: NewsItem[];
  try {
    items = await fetchRecentNews(now.getTime() - LOOKBACK_MS);
  } catch (err) {
    log(`News fetch failed: ${err}`);
    return { stored: false, itemCount: 0, summary: null };
  }

  if (items.length === 0) {
    log("No news items fetched — skipping digest");
    return { stored: false, itemCount: 0, summary: null };
  }

  const interestContext = buildInterestContext(graph);
  const prompt = buildDigestPrompt(items, interestContext);

  const runner = new LlmRunner({
    name: "news-digest",
    timeout: 60_000,
    model: getBrainConfig().models?.driftAudit ?? "haiku",
  });

  let summary: string | null;
  try {
    summary = await runner.run(prompt);
  } catch (err) {
    log(`Digest LLM failed: ${err}`);
    return { stored: false, itemCount: items.length, summary: null };
  }

  if (!summary || !summary.trim()) {
    log("Digest LLM returned empty — skipping store");
    return { stored: false, itemCount: items.length, summary: null };
  }

  const dateStr = getOwnerLocalDate(getBrainConfig().ownerTimezone, now);
  const id = `n_news_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  graph.addNode({
    id,
    type: "insight",
    content: `[NEWS DIGEST ${dateStr}]\n${summary.trim()}`,
    // "news"/"transient" → ephemeral retention tier (decays ~2x fast); not pinned.
    tags: ["news", "digest", "transient"],
    strength: 0.5,
    pinned: false,
    createdAt: now.getTime(),
    lastAccessedAt: now.getTime(),
    accessCount: 1,
  });
  graph.save();

  log(`Stored news digest ${id} from ${items.length} items (${dateStr})`);
  return { stored: true, itemCount: items.length, summary: summary.trim() };
}
