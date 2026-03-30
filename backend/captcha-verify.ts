/**
 * Captcha verification loop — Playwright screenshots a captcha, sends it
 * to Gillis via WhatsApp, waits for his reply, returns the answer.
 *
 * Flow:
 *  1. Playwright Boss (or any caller) calls requestCaptchaVerification(imagePath, caption?)
 *  2. Image is sent to Gillis on WhatsApp with a reference ID
 *  3. Gillis replies with the captcha answer
 *  4. The pending promise resolves with the answer text
 *  5. Caller uses the answer to fill in the captcha field
 */

import { FileStore } from "./utils/file-store.js";
import { randomUUID } from "crypto";
import { createLogger } from "./logger.js";
import { sendImage } from "./integrations/whatsapp.js";
import { OWNER_PHONE } from "./config.js";

const log = createLogger("captcha-verify");

const DATA_DIR = "/data/browser";
const PENDING_FILE = `${DATA_DIR}/captcha-pending.json`;

// ── Types ──

export interface CaptchaRequest {
  id: string;
  imagePath: string;
  caption: string;
  requestedAt: number;
  expiresAt: number;
  status: "pending" | "answered" | "expired";
  answer?: string;
  answeredAt?: number;
}

// ── In-memory waiters ──

const waiters = new Map<string, {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// ── Persistence ──

const pendingStore = new FileStore<CaptchaRequest[]>({ filePath: PENDING_FILE, defaultValue: [] });

function loadPending(): CaptchaRequest[] {
  return pendingStore.load();
}

function savePending(items: CaptchaRequest[]): void {
  pendingStore.save(items);
}

// ── Core API ──

/**
 * Request captcha verification from the owner.
 * Sends the screenshot via WhatsApp and returns a promise that resolves
 * when the owner replies with the answer.
 *
 * @param imagePath - path to the captcha screenshot PNG
 * @param caption - optional caption (default: auto-generated with ID)
 * @param timeoutMs - how long to wait for a reply (default: 5 minutes)
 * @returns the owner's answer text
 */
export async function requestCaptchaVerification(
  imagePath: string,
  caption?: string,
  timeoutMs = 300_000,
): Promise<string> {
  const id = `captcha_${Date.now()}_${randomUUID().slice(0, 6)}`;
  const ownerJid = `${process.env.OWNER_PHONE}@s.whatsapp.net`;

  const request: CaptchaRequest = {
    id,
    imagePath,
    caption: caption || "captcha verification needed",
    requestedAt: Date.now(),
    expiresAt: Date.now() + timeoutMs,
    status: "pending",
  };

  // Persist
  const pending = loadPending();
  pending.push(request);
  savePending(pending);

  // Send image to Gillis
  const msg = `🔒 captcha [${id}]\n${request.caption}\n\nreply with the answer and i'll fill it in`;
  await sendImage(ownerJid, imagePath, msg);

  log(`Captcha ${id} sent to owner, waiting for reply (timeout: ${timeoutMs / 1000}s)`);

  // Return promise that resolves when owner replies
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      markExpired(id);
      reject(new Error(`Captcha ${id} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    waiters.set(id, { resolve, reject, timer });
  });
}

/**
 * Called when a WhatsApp message arrives from the owner.
 * Checks if it matches a pending captcha and resolves the waiter.
 *
 * Match strategy:
 *  1. If the message starts with the captcha ID (e.g. "captcha_123456_abc: XYZW")
 *  2. If there's exactly ONE pending captcha, any reply is treated as the answer
 *
 * Returns true if the message was consumed as a captcha answer.
 */
export function handleCaptchaReply(text: string): boolean {
  if (waiters.size === 0) return false;

  const trimmed = text.trim();

  // Strategy 1: message references a specific captcha ID
  for (const [id, _waiter] of waiters) {
    if (trimmed.toLowerCase().startsWith(id.toLowerCase())) {
      // Extract answer after the ID
      const answer = trimmed.slice(id.length).replace(/^[:\s-]+/, "").trim();
      if (answer) {
        resolveWaiter(id, answer);
        return true;
      }
    }
  }

  // Strategy 2: exactly one pending captcha — any message is the answer
  if (waiters.size === 1) {
    const [id] = waiters.keys();
    resolveWaiter(id, trimmed);
    return true;
  }

  // Strategy 3: multiple pending — check if it looks like a short answer (< 20 chars)
  // and resolve the oldest one
  if (trimmed.length <= 20 && waiters.size > 0) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    const pending = loadPending();
    for (const req of pending) {
      if (req.status === "pending" && waiters.has(req.id) && req.requestedAt < oldestTime) {
        oldestTime = req.requestedAt;
        oldestId = req.id;
      }
    }
    if (oldestId) {
      resolveWaiter(oldestId, trimmed);
      return true;
    }
  }

  return false;
}

function resolveWaiter(id: string, answer: string): void {
  const waiter = waiters.get(id);
  if (!waiter) return;

  clearTimeout(waiter.timer);
  waiters.delete(id);

  // Update persistence
  const pending = loadPending();
  const req = pending.find(r => r.id === id);
  if (req) {
    req.status = "answered";
    req.answer = answer;
    req.answeredAt = Date.now();
    savePending(pending);
  }

  log(`Captcha ${id} answered: "${answer}"`);
  waiter.resolve(answer);
}

function markExpired(id: string): void {
  const pending = loadPending();
  const req = pending.find(r => r.id === id);
  if (req) {
    req.status = "expired";
    savePending(pending);
  }
  log(`Captcha ${id} expired`);
}

// ── Status ──

export function getPendingCaptchas(): CaptchaRequest[] {
  return loadPending().filter(r => r.status === "pending" && r.expiresAt > Date.now());
}

export function getCaptchaHistory(): CaptchaRequest[] {
  return loadPending().slice(-20);
}

/**
 * Clean up old captcha records (keep last 50, remove expired older than 1 hour).
 */
export function cleanupCaptchaHistory(): void {
  const pending = loadPending();
  const cutoff = Date.now() - 3600_000;
  const cleaned = pending.filter(r =>
    r.status === "pending" || r.answeredAt && r.answeredAt > cutoff || r.requestedAt > cutoff,
  ).slice(-50);
  savePending(cleaned);
}
