/**
 * Play Store polling — feeds the brain's observation pipeline.
 *
 * Every few hours this refreshes the shared Play Store snapshot and turns
 * what changed into observations, the same way Gmail/RSS do:
 * - each new review becomes one observation (review text is untrusted content)
 * - a significant crash/ANR-rate jump becomes an alert observation
 *
 * The daily WhatsApp report (playstore-digest.ts) stays the ambient summary;
 * this module is what lets ARIA notice and reason about store events between
 * reports, subject to the normal messaging budgets.
 */

import { refreshSnapshot, isPlayStoreConfigured, getPlayStoreConfig } from "./playstore.js";
import type { VitalsDay } from "./playstore.js";
import { isIntegrationEnabled } from "./integration-config.js";
import { recordObservation } from "../observer.js";
import { FileStore } from "../utils/file-store.js";
import { createLogger } from "../logger.js";

const log = createLogger("playstore-poll");

const POLL_INTERVAL = 6 * 60 * 60 * 1000; // 6h — review flow is slow, API quota is finite
const FIRST_POLL_DELAY = 30_000;
const STATE_FILE = "/data/playstore/poll-state.json";
const MAX_REVIEW_OBS_PER_POLL = 10;

interface PollState {
  lastReviewMs: number;
  lastAlertDate: string; // vitals date we last alerted on, to avoid repeats
  lastPoll: number;
}

const stateStore = new FileStore<PollState>({
  filePath: STATE_FILE,
  defaultValue: { lastReviewMs: 0, lastAlertDate: "", lastPoll: 0 },
});

export interface VitalsAnomaly {
  metric: "crashRate" | "anrRate";
  previous: number;
  current: number;
}

/**
 * Compare the two freshest days with data. A jump of at least 50% relative
 * AND 0.1 percentage point absolute counts as an anomaly — the absolute floor
 * keeps noise on tiny rates (0.01% → 0.02%) from alerting.
 */
export function detectVitalsAnomalies(vitals: VitalsDay[]): VitalsAnomaly[] {
  const withData = vitals.filter(d => d.crashRate !== null || d.anrRate !== null);
  const latest = withData[withData.length - 1];
  const previous = withData[withData.length - 2];
  if (!latest || !previous) return [];

  const anomalies: VitalsAnomaly[] = [];
  const check = (metric: VitalsAnomaly["metric"]) => {
    const prev = previous[metric];
    const cur = latest[metric];
    if (prev === null || cur === null) return;
    if (cur >= prev * 1.5 && cur - prev >= 0.001) {
      anomalies.push({ metric, previous: prev, current: cur });
    }
  };
  check("crashRate");
  check("anrRate");
  return anomalies;
}

async function poll(): Promise<void> {
  if (!isIntegrationEnabled("playstore") || !isPlayStoreConfigured()) return;

  let snapshot;
  try {
    snapshot = await refreshSnapshot();
  } catch (err) {
    log(`Poll failed (non-fatal): ${err}`);
    return;
  }

  const state = stateStore.load();
  const appLabel = getPlayStoreConfig().appLabel;

  // ── New reviews → observations ──
  // First run: baseline only (don't flood the brain with 30 days of reviews).
  if (state.lastReviewMs === 0) {
    const newest = snapshot.reviews[0]?.lastModifiedMs ?? Date.now();
    stateStore.save({ ...state, lastReviewMs: newest, lastPoll: Date.now() });
    log(`Baseline set (${snapshot.reviews.length} existing reviews skipped)`);
    return;
  }

  const fresh = snapshot.reviews
    .filter(r => r.lastModifiedMs > state.lastReviewMs)
    .sort((a, b) => a.lastModifiedMs - b.lastModifiedMs);

  for (const r of fresh.slice(0, MAX_REVIEW_OBS_PER_POLL)) {
    const stars = "★".repeat(r.stars) + "☆".repeat(5 - r.stars);
    recordObservation({
      timestamp: r.lastModifiedMs,
      sender: `${appLabel} review`,
      senderJid: "playstore:review",
      isGroup: false,
      isFromMe: false,
      text: `[PLAYSTORE REVIEW] ${stars} (${r.language}) ${r.text ? `"${r.text.slice(0, 300)}"` : "(no text)"}${r.replied ? " [already replied]" : ""}`,
      source: "playstore",
      trustLevel: "untrusted",
    });
  }
  if (fresh.length > MAX_REVIEW_OBS_PER_POLL) {
    log(`Capped review observations: ${fresh.length} new, ${MAX_REVIEW_OBS_PER_POLL} recorded`);
  }

  // ── Vitals anomalies → one alert observation per vitals day ──
  const withData = snapshot.vitals.filter(d => d.crashRate !== null || d.anrRate !== null);
  const latestDate = withData[withData.length - 1]?.date ?? "";
  const anomalies = latestDate && latestDate !== state.lastAlertDate
    ? detectVitalsAnomalies(snapshot.vitals)
    : [];
  for (const a of anomalies) {
    const label = a.metric === "crashRate" ? "Crash rate" : "ANR rate";
    recordObservation({
      timestamp: Date.now(),
      sender: `${appLabel} vitals`,
      senderJid: "playstore:vitals",
      isGroup: false,
      isFromMe: false,
      text: `[PLAYSTORE ALERT] ${label} jumped from ${(a.previous * 100).toFixed(2)}% to ${(a.current * 100).toFixed(2)}% on ${latestDate}. Worth investigating — this affects Play Store ranking.`,
      source: "playstore",
      trustLevel: "trusted",
    });
  }

  const newLastReview = fresh.length > 0
    ? fresh[fresh.length - 1].lastModifiedMs
    : state.lastReviewMs;
  stateStore.save({
    lastReviewMs: newLastReview,
    lastAlertDate: anomalies.length > 0 ? latestDate : state.lastAlertDate,
    lastPoll: Date.now(),
  });

  if (fresh.length > 0 || anomalies.length > 0) {
    log(`Recorded ${Math.min(fresh.length, MAX_REVIEW_OBS_PER_POLL)} review + ${anomalies.length} vitals observations`);
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startPlayStorePolling(): void {
  if (!isIntegrationEnabled("playstore")) {
    log("Play Store integration disabled, polling not started");
    return;
  }
  if (!isPlayStoreConfigured()) {
    log("Play Store not configured (no service-account key), polling not started");
    return;
  }
  log(`Starting Play Store polling (every ${POLL_INTERVAL / 3600000}h)`);
  setTimeout(() => { poll().catch(err => log(`Poll error: ${err}`)); }, FIRST_POLL_DELAY);
  pollTimer = setInterval(() => { poll().catch(err => log(`Poll error: ${err}`)); }, POLL_INTERVAL);
}

export function stopPlayStorePolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log("Play Store polling stopped");
  }
}
