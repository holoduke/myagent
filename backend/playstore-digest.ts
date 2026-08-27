/**
 * Daily Play Store report.
 *
 * Once per day (after a configured local hour) the agent pulls Football Mania's
 * Play Store vitals (crash rate, ANR rate, active-user proxy) and the reviews
 * that arrived since the previous report, formats them deterministically — no
 * LLM pass — and sends the result to the owner over WhatsApp through the
 * action verifier, like any recurring message.
 */

import { isIntegrationEnabled } from "./integrations/integration-config.js";
import {
  refreshSnapshot,
  getPlayStoreConfig,
  isPlayStoreConfigured,
} from "./integrations/playstore.js";
import type { VitalsDay, Review } from "./integrations/playstore.js";
import { getOwnerLocalDate, getOwnerLocalTime } from "./brain-config.js";
import { verify } from "./action-verifier.js";
import { createLogger } from "./logger.js";

const log = createLogger("playstore-digest");

const DEFAULT_DIGEST_HOUR = 9;
const REVIEW_LOOKBACK_MS = 26 * 60 * 60 * 1000; // slight overlap so no review falls between two runs
const MAX_REVIEWS_IN_REPORT = 4;
const MAX_REVIEW_TEXT = 140;

/** Parse PLAYSTORE_DIGEST_HOUR into a valid 0-23 hour, falling back to the default on blank/invalid input. */
export function parsePlayStoreDigestHour(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DIGEST_HOUR;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    log(`Invalid PLAYSTORE_DIGEST_HOUR "${raw}" — falling back to ${DEFAULT_DIGEST_HOUR}`);
    return DEFAULT_DIGEST_HOUR;
  }
  return n;
}

const DIGEST_HOUR = parsePlayStoreDigestHour(process.env.PLAYSTORE_DIGEST_HOUR);

/** Gate: run once per owner-local day, at or after DIGEST_HOUR. */
export function shouldRunPlayStoreDigest(lastDigestTick: number, timezone: string, now: Date = new Date()): boolean {
  const { hour } = getOwnerLocalTime(timezone, now);
  if (hour < DIGEST_HOUR) return false;
  const today = getOwnerLocalDate(timezone, now);
  if (lastDigestTick > 0) {
    const lastDay = getOwnerLocalDate(timezone, new Date(lastDigestTick));
    if (lastDay === today) return false; // already ran today
  }
  return true;
}

function pct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(2)}%`;
}

function users(v: number | null): string {
  if (v === null) return "n/a";
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
}

function stars(n: number): string {
  const filled = Math.max(0, Math.min(5, n));
  return "★".repeat(filled) + "☆".repeat(5 - filled);
}

/** Compose the WhatsApp report text. Pure — fully unit-testable. */
export function formatPlayStoreReport(appLabel: string, vitals: VitalsDay[], reviews: Review[]): string {
  const lines: string[] = [`📱 *${appLabel} — Play Store daily*`];

  // The reporting API lags a few days; the last row is the freshest available.
  const withData = vitals.filter(d => d.crashRate !== null || d.anrRate !== null);
  const latest = withData[withData.length - 1];
  const previous = withData[withData.length - 2];

  if (latest) {
    lines.push("");
    lines.push(`📊 Vitals (${latest.date}):`);
    const trend = (cur: number | null, prev: number | null | undefined): string => {
      if (cur === null || prev === null || prev === undefined) return "";
      if (cur > prev) return " ↑";
      if (cur < prev) return " ↓";
      return " =";
    };
    lines.push(`• Crash rate: ${pct(latest.crashRate)}${trend(latest.crashRate, previous?.crashRate)}`);
    lines.push(`• ANR rate: ${pct(latest.anrRate)}${trend(latest.anrRate, previous?.anrRate)}`);
    lines.push(`• Users (crash-metric base): ${users(latest.distinctUsers)}`);
  } else {
    lines.push("");
    lines.push("📊 Vitals: no data available from the reporting API.");
  }

  lines.push("");
  if (reviews.length === 0) {
    lines.push("⭐ No new reviews in the last 24h.");
  } else {
    lines.push(`⭐ New reviews (${reviews.length}):`);
    for (const r of reviews.slice(0, MAX_REVIEWS_IN_REPORT)) {
      const text = r.text ? `"${r.text.slice(0, MAX_REVIEW_TEXT)}${r.text.length > MAX_REVIEW_TEXT ? "…" : ""}"` : "(no text)";
      lines.push(`${stars(r.stars)} [${r.language}] ${text}`);
    }
    if (reviews.length > MAX_REVIEWS_IN_REPORT) {
      lines.push(`…and ${reviews.length - MAX_REVIEWS_IN_REPORT} more.`);
    }
    const unreplied = reviews.filter(r => !r.replied && r.stars <= 3).length;
    if (unreplied > 0) {
      lines.push(`⚠️ ${unreplied} low-star review${unreplied === 1 ? "" : "s"} without a reply.`);
    }
  }

  return lines.join("\n");
}

export interface PlayStoreDigestResult {
  /** True when the day's slot is used up (report delivered, or verifier-blocked — retrying won't help). */
  consumed: boolean;
  /** True only when the message actually went out. */
  delivered: boolean;
  reason?: string;
}

/**
 * Run the daily report: fetch vitals + reviews, format, verify, send.
 * Never throws — failures degrade to a no-op so the brain tick is never
 * endangered. The caller only stamps the day's slot when `sent` is true.
 */
export async function runPlayStoreDigest(
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
): Promise<PlayStoreDigestResult> {
  if (!isIntegrationEnabled("playstore")) {
    return { consumed: false, delivered: false, reason: "integration disabled" };
  }
  if (!isPlayStoreConfigured()) {
    return { consumed: false, delivered: false, reason: "service-account key not found" };
  }

  let vitals: VitalsDay[];
  let reviews: Review[];
  try {
    // Refreshing the shared snapshot also keeps the dashboard UI current.
    const snapshot = await refreshSnapshot();
    vitals = snapshot.vitals;
    reviews = snapshot.reviews.filter(r => r.lastModifiedMs >= Date.now() - REVIEW_LOOKBACK_MS);
  } catch (err) {
    log(`Play Store fetch failed: ${err}`);
    return { consumed: false, delivered: false, reason: `fetch failed: ${err}` };
  }

  const text = formatPlayStoreReport(getPlayStoreConfig().appLabel, vitals, reviews);

  const verdict = verify({
    type: "send_recurring",
    source: "recurring",
    targetJid: ownerJid,
    messageText: text,
    metadata: { taskId: "playstore_daily_report", taskLabel: "Play Store daily report" },
  });
  if (verdict.verdict === "blocked") {
    // Consume the slot: a verifier block will not resolve by retrying all day.
    log(`Verifier blocked Play Store report: ${verdict.reasons.join("; ")}`);
    return { consumed: true, delivered: false, reason: "verifier blocked" };
  }

  try {
    await sendMessage(ownerJid, text);
  } catch (err) {
    log(`Play Store report send failed: ${err}`);
    return { consumed: false, delivered: false, reason: `send failed: ${err}` };
  }

  log(`Play Store daily report sent (${reviews.length} new reviews)`);
  return { consumed: true, delivered: true };
}
