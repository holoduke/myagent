import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync, spawn } from "child_process";
import { appendFileSync } from "fs";
import { randomBytes } from "crypto";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [ssh] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const SSH_DIR = `${BRAIN_DIR}/ssh`;
const KEY_PATH = `${SSH_DIR}/id_ed25519`;
const PUB_KEY_PATH = `${KEY_PATH}.pub`;
const TARGETS_FILE = `${SSH_DIR}/targets.json`;

export interface SSHTarget {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
  addedAt: number;
  lastTestedAt?: number;
  lastTestOk?: boolean;
}

export interface SSHStatus {
  keyGenerated: boolean;
  publicKey: string;
  targets: SSHTarget[];
}

/** Generate Ed25519 keypair if it doesn't exist yet */
export function ensureSSHKey(): void {
  if (existsSync(KEY_PATH)) {
    log("SSH key already exists");
    return;
  }

  if (!existsSync(SSH_DIR)) {
    mkdirSync(SSH_DIR, { recursive: true });
  }

  try {
    execSync(`ssh-keygen -t ed25519 -f "${KEY_PATH}" -N "" -C "aria@agent"`, {
      timeout: 10000,
      stdio: "pipe",
    });
    log("Generated new Ed25519 SSH keypair");
  } catch (err) {
    log(`Failed to generate SSH key: ${err}`);
  }
}

/** Read and return the public key contents */
export function getPublicKey(): string {
  try {
    if (existsSync(PUB_KEY_PATH)) {
      return readFileSync(PUB_KEY_PATH, "utf-8").trim();
    }
  } catch (err) {
    log(`Failed to read public key: ${err}`);
  }
  return "";
}

/** Get full SSH status */
export function getSSHStatus(): SSHStatus {
  return {
    keyGenerated: existsSync(KEY_PATH),
    publicKey: getPublicKey(),
    targets: getTargets(),
  };
}

/** Load targets from disk */
export function getTargets(): SSHTarget[] {
  try {
    if (existsSync(TARGETS_FILE)) {
      return JSON.parse(readFileSync(TARGETS_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to read SSH targets: ${err}`);
  }
  return [];
}

function saveTargets(targets: SSHTarget[]): void {
  if (!existsSync(SSH_DIR)) {
    mkdirSync(SSH_DIR, { recursive: true });
  }
  writeFileSync(TARGETS_FILE, JSON.stringify(targets, null, 2));
}

/** Add a new SSH target */
export function addTarget(label: string, host: string, user: string, port: number): SSHTarget {
  const targets = getTargets();
  const target: SSHTarget = {
    id: randomBytes(8).toString("hex"),
    label,
    host,
    user,
    port,
    addedAt: Date.now(),
  };
  targets.push(target);
  saveTargets(targets);
  log(`Added SSH target: ${label} (${user}@${host}:${port})`);
  return target;
}

/** Remove an SSH target by id */
export function removeTarget(id: string): boolean {
  const targets = getTargets();
  const idx = targets.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  const removed = targets.splice(idx, 1)[0];
  saveTargets(targets);
  log(`Removed SSH target: ${removed.label}`);
  return true;
}

/** Test SSH connection to a target */
export function testConnection(targetId: string): Promise<{ success: boolean; error?: string }> {
  const targets = getTargets();
  const target = targets.find((t) => t.id === targetId);
  if (!target) {
    return Promise.resolve({ success: false, error: "Target not found" });
  }

  return new Promise((resolve) => {
    const args = [
      "-o", "ConnectTimeout=5",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "BatchMode=yes",
      "-i", KEY_PATH,
      "-p", String(target.port),
      `${target.user}@${target.host}`,
      "echo ok",
    ];

    const proc = spawn("ssh", args, { timeout: 15000, stdio: "pipe" });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      const success = code === 0 && stdout.trim().includes("ok");

      // Update target test status
      target.lastTestedAt = Date.now();
      target.lastTestOk = success;
      saveTargets(targets);

      if (success) {
        log(`SSH test OK: ${target.label}`);
        resolve({ success: true });
      } else {
        const error = stderr.trim() || `Exit code ${code}`;
        log(`SSH test FAILED: ${target.label} — ${error}`);
        resolve({ success: false, error });
      }
    });

    proc.on("error", (err) => {
      target.lastTestedAt = Date.now();
      target.lastTestOk = false;
      saveTargets(targets);
      log(`SSH test ERROR: ${target.label} — ${err.message}`);
      resolve({ success: false, error: err.message });
    });
  });
}
