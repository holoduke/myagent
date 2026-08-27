/**
 * Google Play Store data access for the daily app report.
 *
 * Reads vitals (crash rate, ANR rate) via the Play Developer Reporting API and
 * recent reviews via the Android Publisher API, using a service account key
 * stored on the data volume. Configured per-app via /data/playstore/config.json.
 *
 * Fetch-only: composing and delivering the daily report lives in
 * playstore-digest.ts.
 */

import { existsSync } from "fs";
import { google } from "googleapis";
import { safeReadJSON } from "../utils/file-store.js";
import { createLogger } from "../logger.js";

const log = createLogger("playstore");

const PLAYSTORE_DIR = "/data/playstore";
const CONFIG_FILE = `${PLAYSTORE_DIR}/config.json`;
const DEFAULT_SERVICE_ACCOUNT_FILE = `${PLAYSTORE_DIR}/service-account.json`;
const VITALS_LOOKBACK_DAYS = 14;
const REVIEWS_PAGE_SIZE = 100;

export interface PlayStoreConfig {
  packageName: string;
  appLabel: string;
  serviceAccountFile: string;
}

export function getPlayStoreConfig(): PlayStoreConfig {
  const saved = safeReadJSON<Partial<PlayStoreConfig>>(CONFIG_FILE, {});
  return {
    packageName: saved.packageName ?? "holoduke.soccer_gen",
    appLabel: saved.appLabel ?? "Football Mania",
    serviceAccountFile: saved.serviceAccountFile ?? DEFAULT_SERVICE_ACCOUNT_FILE,
  };
}

/** True when the service-account key file is present on the data volume. */
export function isPlayStoreConfigured(): boolean {
  return existsSync(getPlayStoreConfig().serviceAccountFile);
}

export interface VitalsDay {
  /** Owner-agnostic ISO date (YYYY-MM-DD) the metrics apply to. */
  date: string;
  crashRate: number | null;
  anrRate: number | null;
  /** Distinct users in the crash-metric base — a rough daily-actives proxy. */
  distinctUsers: number | null;
}

export interface Review {
  date: string;
  lastModifiedMs: number;
  stars: number;
  text: string;
  language: string;
  replied: boolean;
}

function authFor(scope: string) {
  return new google.auth.GoogleAuth({
    keyFile: getPlayStoreConfig().serviceAccountFile,
    scopes: [scope],
  });
}

interface MetricRow {
  startTime?: { year?: number; month?: number; day?: number };
  metrics?: { metric?: string; decimalValue?: { value?: string } }[];
}

function rowDate(row: MetricRow): string | null {
  const t = row.startTime;
  if (!t?.year || !t.month || !t.day) return null;
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

function rowMetric(row: MetricRow, name: string): number | null {
  const m = (row.metrics ?? []).find(x => x.metric === name);
  const v = m?.decimalValue?.value;
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function timelineSpec(now: Date) {
  const start = new Date(now.getTime() - VITALS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const toApiDate = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  return {
    aggregation_period: "DAILY",
    start_time: toApiDate(start),
    end_time: toApiDate(now),
  };
}

/**
 * Fetch daily crash + ANR rates for the recent window, merged by date and
 * sorted ascending. The reporting API lags a few days — callers should treat
 * the last row as "the freshest available day", not "yesterday".
 */
export async function fetchVitals(now: Date = new Date()): Promise<VitalsDay[]> {
  const cfg = getPlayStoreConfig();
  const auth = authFor("https://www.googleapis.com/auth/playdeveloperreporting");
  const reporting = google.playdeveloperreporting({ version: "v1beta1", auth });
  const appName = `apps/${cfg.packageName}`;

  const byDate = new Map<string, VitalsDay>();
  const ensure = (date: string): VitalsDay => {
    const existing = byDate.get(date);
    if (existing) return existing;
    const fresh: VitalsDay = { date, crashRate: null, anrRate: null, distinctUsers: null };
    byDate.set(date, fresh);
    return fresh;
  };

  const crashRes = await reporting.vitals.crashrate.query({
    name: `${appName}/crashRateMetricSet`,
    requestBody: {
      timeline_spec: timelineSpec(now),
      dimensions: [],
      metrics: ["crashRate", "distinctUsers"],
      page_size: 50,
    },
  } as never);
  for (const row of ((crashRes as { data?: { rows?: MetricRow[] } }).data?.rows ?? [])) {
    const date = rowDate(row);
    if (!date) continue;
    const day = ensure(date);
    byDate.set(date, { ...day, crashRate: rowMetric(row, "crashRate"), distinctUsers: rowMetric(row, "distinctUsers") });
  }

  const anrRes = await reporting.vitals.anrrate.query({
    name: `${appName}/anrRateMetricSet`,
    requestBody: {
      timeline_spec: timelineSpec(now),
      dimensions: [],
      metrics: ["anrRate"],
      page_size: 50,
    },
  } as never);
  for (const row of ((anrRes as { data?: { rows?: MetricRow[] } }).data?.rows ?? [])) {
    const date = rowDate(row);
    if (!date) continue;
    const day = ensure(date);
    byDate.set(date, { ...day, anrRate: rowMetric(row, "anrRate") });
  }

  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  log(`Fetched vitals for ${days.length} days (${cfg.packageName})`);
  return days;
}

interface RawReview {
  comments?: {
    userComment?: {
      starRating?: number;
      text?: string;
      reviewerLanguage?: string;
      lastModified?: { seconds?: string };
    };
    developerComment?: { text?: string };
  }[];
}

/**
 * Fetch reviews modified since `sinceMs`, newest first. Reads a single page of
 * the most recent reviews — plenty for a daily delta on one app.
 */
export async function fetchRecentReviews(sinceMs: number): Promise<Review[]> {
  const cfg = getPlayStoreConfig();
  const auth = authFor("https://www.googleapis.com/auth/androidpublisher");
  const androidpublisher = google.androidpublisher({ version: "v3", auth });

  const res = await androidpublisher.reviews.list({
    packageName: cfg.packageName,
    maxResults: REVIEWS_PAGE_SIZE,
  });

  const out: Review[] = [];
  for (const raw of ((res.data.reviews ?? []) as RawReview[])) {
    const uc = raw.comments?.[0]?.userComment;
    if (!uc) continue;
    const lastModifiedMs = uc.lastModified?.seconds ? parseInt(uc.lastModified.seconds, 10) * 1000 : 0;
    if (!lastModifiedMs || lastModifiedMs < sinceMs) continue;
    out.push({
      date: new Date(lastModifiedMs).toISOString().slice(0, 10),
      lastModifiedMs,
      stars: uc.starRating ?? 0,
      text: (uc.text ?? "").replace(/\s+/g, " ").trim(),
      language: uc.reviewerLanguage ?? "?",
      replied: (raw.comments ?? []).some(c => c.developerComment),
    });
  }

  out.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  log(`Fetched ${out.length} reviews modified in window (${cfg.packageName})`);
  return out;
}

/** Review with its Play Store id, for listing/replying via the CLI. */
export interface ReviewWithId extends Review {
  reviewId: string;
}

/** Fetch the most recent reviews including their ids, newest first. */
export async function fetchReviewsWithIds(sinceMs: number): Promise<ReviewWithId[]> {
  const cfg = getPlayStoreConfig();
  const auth = authFor("https://www.googleapis.com/auth/androidpublisher");
  const androidpublisher = google.androidpublisher({ version: "v3", auth });

  const res = await androidpublisher.reviews.list({
    packageName: cfg.packageName,
    maxResults: REVIEWS_PAGE_SIZE,
  });

  const out: ReviewWithId[] = [];
  for (const raw of ((res.data.reviews ?? []) as (RawReview & { reviewId?: string })[])) {
    const uc = raw.comments?.[0]?.userComment;
    if (!uc || !raw.reviewId) continue;
    const lastModifiedMs = uc.lastModified?.seconds ? parseInt(uc.lastModified.seconds, 10) * 1000 : 0;
    if (!lastModifiedMs || lastModifiedMs < sinceMs) continue;
    out.push({
      reviewId: raw.reviewId,
      date: new Date(lastModifiedMs).toISOString().slice(0, 10),
      lastModifiedMs,
      stars: uc.starRating ?? 0,
      text: (uc.text ?? "").replace(/\s+/g, " ").trim(),
      language: uc.reviewerLanguage ?? "?",
      replied: (raw.comments ?? []).some(c => c.developerComment),
    });
  }
  out.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  return out;
}

/**
 * Post a developer reply to a review. Public-facing: callers must only invoke
 * this with owner-approved text.
 */
export async function replyToReview(reviewId: string, replyText: string): Promise<void> {
  if (!reviewId.trim()) throw new Error("reviewId is required");
  const trimmed = replyText.trim();
  if (!trimmed) throw new Error("reply text is required");
  if (trimmed.length > 350) throw new Error(`reply text too long (${trimmed.length} chars, Play Store max is 350)`);

  const cfg = getPlayStoreConfig();
  const auth = authFor("https://www.googleapis.com/auth/androidpublisher");
  const androidpublisher = google.androidpublisher({ version: "v3", auth });

  await androidpublisher.reviews.reply({
    packageName: cfg.packageName,
    reviewId,
    requestBody: { replyText: trimmed },
  });
  log(`Posted developer reply to review ${reviewId} (${cfg.packageName})`);
}
