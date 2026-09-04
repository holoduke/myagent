import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/utils/file-store.js", () => ({
  FileStore: class<T> {
    constructor(private opts: { filePath: string; defaultValue: T }) {}
    load(): T { return this.opts.defaultValue; }
    save() {}
    exists() { return false; }
  },
  ensureDir: () => {},
  atomicWriteFile: () => {},
  safeReadJSON: <T,>(_p: string, fallback: T) => fallback,
  atomicWriteJSON: () => {},
}));

import { parseCliArgs } from "../backend/scripts/ha-cli.js";

describe("ha-cli parseCliArgs", () => {
  it("parses states with filters", () => {
    expect(parseCliArgs(["states"])).toEqual({ command: "states", domain: undefined, match: undefined });
    expect(parseCliArgs(["states", "--domain", "light", "--match", "keuken"])).toEqual({ command: "states", domain: "light", match: "keuken" });
  });

  it("parses call with entity, data and reason", () => {
    expect(parseCliArgs(["call", "light.turn_on", "--entity", "light.keuken", "--data", '{"brightness":10}', "--reason", "dark"]))
      .toEqual({ command: "call", service: "light.turn_on", entity: "light.keuken", data: { brightness: 10 }, reason: "dark" });
  });

  it("rejects malformed call input", () => {
    expect(() => parseCliArgs(["call"])).toThrow(/domain.service/);
    expect(() => parseCliArgs(["call", "turn_on"])).toThrow(/domain.service/);
    expect(() => parseCliArgs(["call", "light.turn_on", "--data", "[1]"])).toThrow(/JSON object/);
    expect(() => parseCliArgs(["call", "light.turn_on", "--entity"])).toThrow(/requires a value/);
  });

  it("parses speak, forecast and events", () => {
    expect(parseCliArgs(["speak", "Hallo", "--player", "media_player.x"])).toEqual({ command: "speak", text: "Hallo", player: "media_player.x" });
    expect(() => parseCliArgs(["speak"])).toThrow(/text/);
    expect(parseCliArgs(["forecast"])).toEqual({ command: "forecast" });
    expect(parseCliArgs(["events"])).toEqual({ command: "events", limit: 20 });
    expect(parseCliArgs(["events", "--limit", "5"])).toEqual({ command: "events", limit: 5 });
    expect(() => parseCliArgs(["events", "--limit", "0"])).toThrow(/1-200/);
  });

  it("prints usage for unknown commands", () => {
    expect(() => parseCliArgs(["nope"])).toThrow(/Usage/);
  });
});
