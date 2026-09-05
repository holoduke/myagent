/**
 * Timezone helpers — build instants from wall-clock date/time in an IANA zone.
 *
 * The container runs in UTC while the owner lives in Europe/Amsterdam; a
 * naive `new Date("2026-05-01T10:00:00")` therefore lands one or two hours
 * off in the calendar. These helpers use Intl to resolve the zone offset at
 * the requested instant (DST-aware) without a dependency.
 */

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HM_RE = /^(\d{1,2}):(\d{2})$/;

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

/** Wall-clock components of an instant as seen in `timeZone`. */
export function wallClockIn(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const pick = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? "0");
  return { year: pick("year"), month: pick("month"), day: pick("day"), hour: pick("hour") % 24, minute: pick("minute") };
}

function asUtcMs(wc: WallClock): number {
  return Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, 0, 0);
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC instant. Two refinement
 * passes handle DST transitions; non-existent local times resolve forward.
 */
export function zonedWallClockToDate(wc: WallClock, timeZone: string): Date {
  const target = asUtcMs(wc);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const seen = asUtcMs(wallClockIn(new Date(guess), timeZone));
    guess += target - seen;
  }
  return new Date(guess);
}

/**
 * Parse "YYYY-MM-DD" + "HH:MM" as a wall-clock time in `timeZone`.
 * Returns null on malformed input.
 */
export function zonedDateTimeToDate(ymd: string, hm: string, timeZone: string): Date | null {
  const d = YMD_RE.exec(ymd);
  const t = HM_RE.exec(hm);
  if (!d || !t) return null;
  const wc: WallClock = {
    year: Number(d[1]),
    month: Number(d[2]),
    day: Number(d[3]),
    hour: Number(t[1]),
    minute: Number(t[2]),
  };
  if (wc.month < 1 || wc.month > 12 || wc.day < 1 || wc.day > 31 || wc.hour > 23 || wc.minute > 59) return null;
  const result = zonedWallClockToDate(wc, timeZone);
  return Number.isNaN(result.getTime()) ? null : result;
}

/** Format the date part of a Date using its own (process-local) calendar fields. */
export function localYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
