import { describe, it, expect, vi, beforeEach } from "vitest";

const files = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../backend/utils/file-store.js", () => ({
  FileStore: class<T> {
    constructor(private opts: { filePath: string; defaultValue: T }) {}
    load(): T { return (files.has(this.opts.filePath) ? files.get(this.opts.filePath) : this.opts.defaultValue) as T; }
    save(v: T) { files.set(this.opts.filePath, v); }
    exists() { return files.has(this.opts.filePath); }
  },
  ensureDir: () => {},
  atomicWriteFile: () => {},
  safeReadJSON: <T,>(_p: string, fallback: T) => fallback,
  atomicWriteJSON: () => {},
}));
vi.mock("../backend/utils/merged-store.js", () => ({
  MergedStore: class<T> {
    private value: T;
    constructor(private opts: { filePath: string; defaultValue: () => T }) { this.value = opts.defaultValue(); }
    get(): T { return this.value; }
    update(fn: (v: T) => T) { this.value = fn(this.value); }
    saveMerged() {}
  },
}));
vi.mock("../backend/observer.js", () => ({ recordObservation: () => {}, getObservationsSince: () => [] }));
vi.mock("../backend/scheduler.js", () => ({ logDelivery: () => {} }));
vi.mock("../backend/contact-whitelist.js", () => ({ resolveCanonicalJid: (j: string) => j, isWhitelisted: () => false }));
vi.mock("../backend/action-verifier.js", () => ({ verify: () => ({ verdict: "allowed", reasons: [] }) }));
vi.mock("../backend/brain-config.js", () => ({ getBrainConfig: () => ({ enabled: true, models: {} }) }));
vi.mock("../backend/providers/llm-runner.js", () => ({ LlmRunner: class { async run() { return null; } } }));

import { slackUserJid, slackChatJid, parseSlackJid, isSlackChannelId } from "../backend/integrations/slack.js";
import { canReply, replyChannelFor } from "../backend/reply-agent.js";
import { parseCliArgs } from "../backend/scripts/slack-cli.js";

beforeEach(() => files.clear());

describe("slack jid helpers", () => {
  it("builds and parses sender/chat jids and recognises channel ids", () => {
    expect(slackUserJid("newstory", "UF2TMG6HJ")).toBe("slack:newstory:UF2TMG6HJ");
    expect(slackChatJid("newstory", "D0AESPZDYRL")).toBe("slack:newstory:D0AESPZDYRL");
    expect(parseSlackJid("slack:newstory:UF2TMG6HJ")).toEqual({ workspaceId: "newstory", id: "UF2TMG6HJ" });
    expect(parseSlackJid("31612345678@s.whatsapp.net")).toBeNull();
    expect(isSlackChannelId("D0AESPZDYRL")).toBe(true);
    expect(isSlackChannelId("C123ABC")).toBe(true);
    expect(isSlackChannelId("UF2TMG6HJ")).toBe(false);
  });
});

describe("reply channel and Slack limits", () => {
  it("maps sources to reply channels", () => {
    expect(replyChannelFor({ source: undefined })).toBe("whatsapp");
    expect(replyChannelFor({ source: "whatsapp" })).toBe("whatsapp");
    expect(replyChannelFor({ source: "slack" })).toBe("slack");
    expect(replyChannelFor({ source: "gmail" })).toBeNull();
  });

  it("allows a first reply to any chat", () => {
    expect(canReply("slack:newstory:D1", false)).toBe(true);
    expect(canReply("31612345678@s.whatsapp.net", false)).toBe(true);
  });
});

describe("slack-cli parseCliArgs", () => {
  it("parses talk with goal, name and opening", () => {
    expect(parseCliArgs(["talk", "uf2tmg6hj", "--goal", "Have a short intro chat", "--name", "Marvin", "--opening", "Hoi!"]))
      .toEqual({ command: "talk", userId: "UF2TMG6HJ", workspace: undefined, name: "Marvin", goal: "Have a short intro chat", opening: "Hoi!", filter: undefined });
    expect(() => parseCliArgs(["talk", "U1", "--goal", "short"])).toThrow(/at least 10/);
  });

  it("parses users, dm, thread, end, scopes", () => {
    expect(parseCliArgs(["users", "--match", "marvin"])).toEqual({ command: "users", workspace: undefined, match: "marvin" });
    expect(parseCliArgs(["dm", "D0AESPZDYRL", "--text", "hi"])).toEqual({ command: "dm", to: "D0AESPZDYRL", workspace: undefined, text: "hi" });
    expect(parseCliArgs(["thread", "UF2TMG6HJ"])).toEqual({ command: "thread", to: "UF2TMG6HJ", workspace: undefined, limit: 20 });
    expect(parseCliArgs(["end", "UF2TMG6HJ"])).toEqual({ command: "end", userId: "UF2TMG6HJ", workspace: undefined });
    expect(parseCliArgs(["scopes"])).toEqual({ command: "scopes", workspace: undefined });
    expect(() => parseCliArgs(["nope"])).toThrow(/Usage/);
  });
});
