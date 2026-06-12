import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory feed store so seeding/loading doesn't touch disk.
let stored: unknown[] = [];
vi.mock("../backend/utils/file-store.js", () => ({
  FileStore: class {
    load() { return stored; }
    save(v: unknown[]) { stored = v; }
  },
  ensureDir: () => {},
}));

// Mock rss-parser with a controllable parseURL (hoisted so the factory can see it).
const { parseURL } = vi.hoisted(() => ({ parseURL: vi.fn() }));
vi.mock("rss-parser", () => ({
  default: class {
    parseURL = parseURL;
  },
}));

import { loadNewsFeeds, fetchRecentNews, DEFAULT_FEEDS } from "../backend/integrations/news.js";

beforeEach(() => {
  stored = [];
  parseURL.mockReset();
});

describe("loadNewsFeeds", () => {
  it("seeds defaults on first run and marks Hacker News primary", () => {
    const feeds = loadNewsFeeds();
    expect(feeds.length).toBe(DEFAULT_FEEDS.length);
    const hn = feeds.find(f => f.id === "hn-front");
    expect(hn).toBeDefined();
    expect(hn!.primary).toBe(true);
    // exactly one primary source
    expect(feeds.filter(f => f.primary).length).toBe(1);
  });
});

describe("fetchRecentNews", () => {
  it("filters out items older than the cutoff and dedupes by title", async () => {
    const recent = new Date("2026-06-12T10:00:00Z").toISOString();
    const old = new Date("2026-06-01T10:00:00Z").toISOString();
    parseURL.mockResolvedValue({
      items: [
        { title: "Big AI release", isoDate: recent, link: "a", contentSnippet: "x" },
        { title: "Old news", isoDate: old, link: "b", contentSnippet: "y" },
        { title: "Big AI release", isoDate: recent, link: "c" }, // dup title
      ],
    });
    const since = new Date("2026-06-11T00:00:00Z").getTime();
    const items = await fetchRecentNews(since);
    const titles = items.map(i => i.title);
    expect(titles).toContain("Big AI release");
    expect(titles).not.toContain("Old news");
    // dedup: only one "Big AI release" across all feeds combined
    expect(titles.filter(t => t === "Big AI release").length).toBe(1);
  });

  it("survives a feed that throws (one bad source does not fail the digest)", async () => {
    parseURL.mockRejectedValue(new Error("network down"));
    const items = await fetchRecentNews(0);
    expect(items).toEqual([]);
  });

  it("sorts primary (Hacker News) items ahead of others", async () => {
    const ts = new Date("2026-06-12T10:00:00Z").toISOString();
    // Every feed returns one item titled after its URL so we can tell them apart.
    parseURL.mockImplementation((url: string) =>
      Promise.resolve({ items: [{ title: `item-${url}`, isoDate: ts, link: url }] }),
    );
    const items = await fetchRecentNews(0);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].primary).toBe(true); // HN sorted first
  });
});
