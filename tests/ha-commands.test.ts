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

const client = vi.hoisted(() => ({ reachable: false, callService: vi.fn() }));
vi.mock("../backend/integrations/ha-client.js", () => ({
  isHAReachableConfigured: () => client.reachable,
  callService: client.callService,
  HAClientError: class extends Error {},
}));

import {
  validateServiceCall,
  dispatchCommand,
  pullQueuedCommands,
  getQueuedCount,
  getCommandQueue,
  toPulledCommand,
  COMMAND_TTL_MS,
} from "../backend/integrations/ha-commands.js";

beforeEach(() => {
  files.clear();
  client.reachable = false;
  client.callService.mockReset();
});

describe("validateServiceCall", () => {
  it("accepts allow-listed domains with valid entity ids", () => {
    expect(() => validateServiceCall({ domain: "light", service: "turn_on", entityId: "light.keuken" })).not.toThrow();
    expect(() => validateServiceCall({ domain: "tts", service: "google_translate_say", entityId: ["media_player.a", "media_player.b"] })).not.toThrow();
  });

  it("rejects locks and other non-allow-listed domains", () => {
    expect(() => validateServiceCall({ domain: "lock", service: "unlock", entityId: "lock.front" })).toThrow(/not allowed/);
    expect(() => validateServiceCall({ domain: "homeassistant", service: "restart" })).toThrow(/not allowed/);
  });

  it("rejects malformed names, entity ids and data", () => {
    expect(() => validateServiceCall({ domain: "light", service: "turn on" })).toThrow(/invalid service/);
    expect(() => validateServiceCall({ domain: "light", service: "turn_on", entityId: "keuken" })).toThrow(/invalid entity_id/);
    expect(() => validateServiceCall({ domain: "light", service: "turn_on", data: [] as unknown as Record<string, unknown> })).toThrow(/data must/);
    expect(() => validateServiceCall({ domain: "light", service: "turn_on", data: { x: "y".repeat(5000) } })).toThrow(/4096/);
  });
});

describe("dispatchCommand", () => {
  it("queues when the house is unreachable", async () => {
    const r = await dispatchCommand({ domain: "light", service: "turn_on", entityId: "light.keuken" }, "cli", "test");
    expect(r.mode).toBe("queued");
    expect(r.command.status).toBe("queued");
    expect(getQueuedCount()).toBe(1);
    expect(client.callService).not.toHaveBeenCalled();
  });

  it("calls directly when reachable", async () => {
    client.reachable = true;
    client.callService.mockResolvedValue({});
    const r = await dispatchCommand({ domain: "light", service: "turn_off", entityId: "light.keuken" }, "brain");
    expect(r.mode).toBe("direct");
    expect(r.command.status).toBe("sent");
    expect(getQueuedCount()).toBe(0);
  });

  it("queues as fallback when a direct call fails", async () => {
    client.reachable = true;
    client.callService.mockRejectedValue(new Error("timeout"));
    const r = await dispatchCommand({ domain: "scene", service: "turn_on", entityId: "scene.avond" }, "brain");
    expect(r.mode).toBe("queued");
    expect(r.command.error).toContain("timeout");
    expect(getQueuedCount()).toBe(1);
  });

  it("refuses invalid calls before touching the queue", async () => {
    await expect(dispatchCommand({ domain: "lock", service: "unlock" }, "cli")).rejects.toThrow(/not allowed/);
    expect(getQueuedCount()).toBe(0);
  });
});

describe("pullQueuedCommands", () => {
  it("hands queued commands to the house once, in wire shape", async () => {
    await dispatchCommand({ domain: "light", service: "turn_on", entityId: "light.keuken", data: { brightness: 100 } }, "cli", "why");
    const pulled = pullQueuedCommands();
    expect(pulled).toHaveLength(1);
    expect(pulled[0]).toMatchObject({ service: "light.turn_on", target: { entity_id: "light.keuken" }, data: { brightness: 100 }, reason: "why" });
    expect(pullQueuedCommands()).toHaveLength(0);
    expect(getCommandQueue()[0].status).toBe("pulled");
  });

  it("expires stale commands instead of delivering them", async () => {
    const created = 1_000_000;
    await dispatchCommand({ domain: "light", service: "turn_on" }, "cli", undefined, created);
    const pulled = pullQueuedCommands(created + COMMAND_TTL_MS + 1);
    expect(pulled).toHaveLength(0);
    expect(getCommandQueue()[0].status).toBe("expired");
  });

  it("omits target when there is no entity", () => {
    const wire = toPulledCommand({ id: "x", createdAt: 1, updatedAt: 1, domain: "script", service: "goodnight", source: "brain", status: "queued" });
    expect(wire.target).toBeUndefined();
    expect(wire.data).toEqual({});
  });
});
