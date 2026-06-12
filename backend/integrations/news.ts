/**
 * News sources for the daily digest.
 *
 * Unlike the RSS integration (which streams every item into the observation
 * pipeline), news is fetched on-demand once per day by news-digest.ts, filtered
 * and summarized by a cheap LLM, and stored as a single ephemeral memory node.
 * News therefore never reinforces person nodes, never triggers proactive
 * messages, and never bloats the graph with per-headline nodes.
 *
 * Hacker News is the PRIMARY source — weighted highest in the digest prompt.
 */

import Parser from "rss-parser";
import { FileStore } from "../utils/file-store.js";
import { createLogger } from "../logger.js";

const log = createLogger("news");

const NEWS_DIR = "/data/news";
const FEEDS_FILE = `${NEWS_DIR}/feeds.json`;

const parser = new Parser({ timeout: 15_000 });

export interface NewsFeed {
  id: string;
  name: string;
  url: string;
  category: "tech" | "world" | "politics" | "dutch" | "reddit";
  /** Primary sources are emphasized in the digest prompt. */
  primary?: boolean;
  enabled: boolean;
}

export interface NewsItem {
  title: string;
  snippet: string;
  source: string;
  category: NewsFeed["category"];
  primary: boolean;
  link: string;
  publishedAt: number;
}

/**
 * Default feed set. Hacker News is primary. Reddit, Dutch news, tech, and
 * world/politics round it out. Editable later via /data/news/feeds.json.
 */
export const DEFAULT_FEEDS: NewsFeed[] = [
  // ── Primary: Hacker News ──
  { id: "hn-front", name: "Hacker News", url: "https://hnrss.org/frontpage?points=100", category: "tech", primary: true, enabled: true },
  // ── Reddit ──
  { id: "r-worldnews", name: "r/worldnews", url: "https://www.reddit.com/r/worldnews/top/.rss?t=day", category: "world", enabled: true },
  { id: "r-technology", name: "r/technology", url: "https://www.reddit.com/r/technology/top/.rss?t=day", category: "tech", enabled: true },
  { id: "r-programming", name: "r/programming", url: "https://www.reddit.com/r/programming/top/.rss?t=day", category: "tech", enabled: true },
  // ── Dutch news ──
  { id: "nos", name: "NOS Nieuws", url: "https://feeds.nos.nl/nosnieuwsalgemeen", category: "dutch", enabled: true },
  { id: "nu", name: "NU.nl", url: "https://www.nu.nl/rss/Algemeen", category: "dutch", enabled: true },
  // ── Tech ──
  { id: "verge", name: "The Verge", url: "https://www.theverge.com/rss/index.xml", category: "tech", enabled: true },
  { id: "tweakers", name: "Tweakers", url: "https://feeds.feedburner.com/tweakers/mixed", category: "tech", enabled: true },
];

const feedsStore = new FileStore<NewsFeed[]>({ filePath: FEEDS_FILE, defaultValue: [] });

/** Load configured feeds, seeding defaults on first run. */
export function loadNewsFeeds(): NewsFeed[] {
  const stored = feedsStore.load();
  if (stored.length === 0) {
    feedsStore.save(DEFAULT_FEEDS);
    return DEFAULT_FEEDS;
  }
  return stored;
}

export function saveNewsFeeds(feeds: NewsFeed[]): void {
  feedsStore.save(feeds);
}

async function fetchFeed(feed: NewsFeed, sinceMs: number): Promise<NewsItem[]> {
  const parsed = await parser.parseURL(feed.url);
  const items: NewsItem[] = [];
  for (const item of parsed.items || []) {
    const publishedAt = item.isoDate ? new Date(item.isoDate).getTime() : 0;
    // Keep items newer than the cutoff; items without a date are kept (some feeds omit it).
    if (publishedAt && publishedAt < sinceMs) continue;
    const title = (item.title || "").trim();
    if (!title) continue;
    items.push({
      title,
      snippet: (item.contentSnippet || "").replace(/\s+/g, " ").trim().slice(0, 240),
      source: feed.name,
      category: feed.category,
      primary: !!feed.primary,
      link: item.link || "",
      publishedAt: publishedAt || Date.now(),
    });
  }
  return items;
}

/**
 * Fetch recent items from all enabled feeds in parallel. Per-feed failures are
 * logged and skipped — a down feed never fails the whole digest. Items are
 * de-duplicated by title.
 */
export async function fetchRecentNews(sinceMs: number): Promise<NewsItem[]> {
  const feeds = loadNewsFeeds().filter(f => f.enabled);
  if (feeds.length === 0) return [];

  const results = await Promise.allSettled(feeds.map(f => fetchFeed(f, sinceMs)));

  const seen = new Set<string>();
  const out: NewsItem[] = [];
  results.forEach((res, i) => {
    if (res.status === "fulfilled") {
      for (const item of res.value) {
        const key = item.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
    } else {
      log(`Feed "${feeds[i].name}" failed: ${res.reason}`);
    }
  });

  // Primary sources first, then newest.
  out.sort((a, b) => (Number(b.primary) - Number(a.primary)) || (b.publishedAt - a.publishedAt));
  return out;
}
