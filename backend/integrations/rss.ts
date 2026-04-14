import Parser from "rss-parser";
import { FileStore, ensureDir } from "../utils/file-store.js";
import { randomUUID } from "crypto";
import { recordObservation } from "../observer.js";
import { isIntegrationEnabled } from "./integration-config.js";
import { createLogger } from "../logger.js";

const log = createLogger("rss");

const RSS_DIR = "/data/rss";
const FEEDS_FILE = `${RSS_DIR}/feeds.json`;
const STATE_FILE = `${RSS_DIR}/state.json`;
const POLL_INTERVAL = Number(process.env.RSS_POLL_INTERVAL ?? 900000);

const parser = new Parser();

export interface RSSFeed {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

interface RSSState {
  [feedId: string]: {
    lastItemDate: number;
    lastPoll: number;
    itemCount: number;
  };
}

const feedsStore = new FileStore<RSSFeed[]>({ filePath: FEEDS_FILE, defaultValue: [] });
const stateStore = new FileStore<RSSState>({ filePath: STATE_FILE, defaultValue: {} });

function loadFeeds(): RSSFeed[] {
  return feedsStore.load();
}

function saveFeeds(feeds: RSSFeed[]): void {
  feedsStore.save(feeds);
}

function loadState(): RSSState {
  return stateStore.load();
}

function saveState(state: RSSState): void {
  stateStore.save(state);
}

async function fetchFeed(feed: RSSFeed, state: RSSState): Promise<void> {
  try {
    const parsed = await parser.parseURL(feed.url);
    const feedState = state[feed.id] || { lastItemDate: 0, lastPoll: 0, itemCount: 0 };
    let newItems = 0;
    let newestDate = feedState.lastItemDate;

    for (const item of parsed.items || []) {
      const itemDate = item.isoDate ? new Date(item.isoDate).getTime() : 0;
      if (itemDate <= feedState.lastItemDate) continue;

      const title = item.title || "Untitled";
      const snippet = (item.contentSnippet || item.content || "").slice(0, 200);

      recordObservation({
        timestamp: itemDate || Date.now(),
        sender: feed.name,
        senderJid: `rss:${feed.id}`,
        isGroup: false,
        isFromMe: false,
        text: `[NEWS] ${title} — ${snippet} (from ${feed.name})`,
        source: "rss",
      });

      if (itemDate > newestDate) newestDate = itemDate;
      newItems++;
    }

    state[feed.id] = {
      lastItemDate: newestDate || Date.now(),
      lastPoll: Date.now(),
      itemCount: (parsed.items || []).length,
    };

    if (newItems > 0) {
      log(`Feed "${feed.name}": ${newItems} new items`);
    }
  } catch (err) {
    log(`Failed to fetch feed "${feed.name}" (${feed.url}): ${err}`);
    // Update poll time even on failure to avoid hammering
    state[feed.id] = {
      ...(state[feed.id] || { lastItemDate: 0, itemCount: 0 }),
      lastPoll: Date.now(),
    };
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startRSSPolling(): void {
  const feeds = loadFeeds();
  const enabled = feeds.filter(f => f.enabled);

  if (enabled.length === 0) {
    log("No RSS feeds configured, polling not started");
    return;
  }

  log(`Starting RSS polling for ${enabled.length} feed(s) (every ${POLL_INTERVAL / 1000}s)`);

  setTimeout(() => pollAllFeeds(), 12000);
  pollTimer = setInterval(() => pollAllFeeds(), POLL_INTERVAL);
}

export function stopRSSPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log("RSS polling stopped");
  }
}

export function restartRSSPolling(): void {
  stopRSSPolling();
  startRSSPolling();
}

async function pollAllFeeds(): Promise<void> {
  if (!isIntegrationEnabled("rss")) return;
  const feeds = loadFeeds();
  const state = loadState();

  for (const feed of feeds) {
    if (!feed.enabled) continue;
    try {
      await fetchFeed(feed, state);
    } catch (err) {
      log(`RSS poll error for ${feed.id}: ${err}`);
    }
  }

  saveState(state);
}

export function addFeed(name: string, url: string): RSSFeed {
  // Validate URL to prevent SSRF (only allow http/https, reject internal addresses)
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Invalid protocol "${parsed.protocol}" — only http and https are allowed`);
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" ||
        hostname === "0.0.0.0" || hostname.endsWith(".local") ||
        hostname.startsWith("10.") || hostname.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) {
      throw new Error(`Internal/private addresses are not allowed as RSS feed URLs`);
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`Invalid URL: ${url}`);
    }
    throw err;
  }

  ensureDir(RSS_DIR);
  const feeds = loadFeeds();
  const feed: RSSFeed = { id: randomUUID(), name, url, enabled: true };
  feeds.push(feed);
  saveFeeds(feeds);
  log(`Added feed "${name}" (${url})`);

  // Restart polling to pick up new feed
  if (pollTimer) {
    stopRSSPolling();
    startRSSPolling();
  }

  return feed;
}

export function removeFeed(id: string): boolean {
  const feeds = loadFeeds();
  const idx = feeds.findIndex(f => f.id === id);
  if (idx === -1) return false;
  const removed = feeds.splice(idx, 1)[0];
  saveFeeds(feeds);
  log(`Removed feed "${removed?.name}"`);
  return true;
}

export function getFeeds(): RSSFeed[] {
  return loadFeeds();
}

export function getRSSStatus(): { feeds: Array<{ id: string; name: string; url: string; enabled: boolean; lastPoll: number; itemCount: number }> } {
  const feeds = loadFeeds();
  const state = loadState();

  return {
    feeds: feeds.map(f => ({
      id: f.id,
      name: f.name,
      url: f.url,
      enabled: f.enabled,
      lastPoll: state[f.id]?.lastPoll || 0,
      itemCount: state[f.id]?.itemCount || 0,
    })),
  };
}
