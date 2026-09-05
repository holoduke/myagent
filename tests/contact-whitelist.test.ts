import { describe, it, expect, afterAll } from "vitest";
import { vi } from "vitest";
import { rmSync, readFileSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";

const { brainDir } = vi.hoisted(() => {
  const { mkdtempSync } = require("fs") as typeof import("fs");
  const { tmpdir } = require("os") as typeof import("os");
  const { join } = require("path") as typeof import("path");
  return { brainDir: mkdtempSync(join(tmpdir(), "whitelist-")) };
});

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {} }),
}));

vi.mock("../backend/config.js", () => ({ BRAIN_DIR: brainDir }));

import {
  addToWhitelist,
  removeFromWhitelist,
  isWhitelisted,
  getWhitelist,
  updatePermissions,
  getActionMode,
  resolveCanonicalJid,
} from "../backend/contact-whitelist.js";

const FILE = join(brainDir, "contact-whitelist.json");

afterAll(() => {
  rmSync(brainDir, { recursive: true, force: true });
});

describe("contact whitelist store", () => {
  it("adds, resolves and removes contacts", () => {
    addToWhitelist("alice@s.whatsapp.net", "Alice");
    expect(isWhitelisted("alice@s.whatsapp.net")).toBe(true);
    expect(isWhitelisted("0:alice@s.whatsapp.net".replace("alice", "31611111111"))).toBe(false);
    expect(resolveCanonicalJid("alice@s.whatsapp.net")).toBe("alice@s.whatsapp.net");
    expect(removeFromWhitelist("alice@s.whatsapp.net")).toBe(true);
    expect(removeFromWhitelist("alice@s.whatsapp.net")).toBe(false);
  });

  it("keeps a contact another instance added while this one was cached", () => {
    addToWhitelist("bob@s.whatsapp.net", "Bob");
    // Another instance writes the file behind our back
    const external = [...getWhitelist(), { jid: "carol@s.whatsapp.net", name: "Carol", addedAt: 1 }];
    writeFileSync(FILE, JSON.stringify(external));
    const future = new Date(Date.now() + 5000);
    utimesSync(FILE, future, future);

    addToWhitelist("dave@s.whatsapp.net", "Dave");
    const onDisk = JSON.parse(readFileSync(FILE, "utf-8")) as { jid: string }[];
    expect(onDisk.map(c => c.jid).sort()).toEqual(["bob@s.whatsapp.net", "carol@s.whatsapp.net", "dave@s.whatsapp.net"]);
    expect(isWhitelisted("carol@s.whatsapp.net")).toBe(true);
  });

  it("updates and removes permissions immutably", () => {
    addToWhitelist("erin@s.whatsapp.net", "Erin");
    expect(updatePermissions("erin@s.whatsapp.net", { acceptCommands: true, autoActions: ["event"], confirmActions: [], defaultMode: "confirm" })).toBe(true);
    expect(getActionMode("erin@s.whatsapp.net", "event")).toBe("auto");
    expect(getActionMode("erin@s.whatsapp.net", "request")).toBe("confirm");
    expect(updatePermissions("erin@s.whatsapp.net", null)).toBe(true);
    expect(getActionMode("erin@s.whatsapp.net", "event")).toBe("ignore");
    expect(updatePermissions("nobody@s.whatsapp.net", null)).toBe(false);
  });
});
