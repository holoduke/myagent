/**
 * Quiet-hours arithmetic shared by the delivery gate, the think tick's
 * reroute paths and the watchdog. Pure functions only — no config access.
 */

const HOUR_MS = 60 * 60 * 1000;

export interface LocalClock {
  hour: number;
  minute: number;
}

/** Owner-local wall clock (hour + minute) for `now`; falls back to system time on a bad timezone. */
export function ownerLocalClock(timezone: string, now: number): LocalClock {
  const date = new Date(now);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(date);
    const hour = Number(parts.find(p => p.type === "hour")?.value ?? date.getHours()) % 24;
    const minute = Number(parts.find(p => p.type === "minute")?.value ?? date.getMinutes());
    return { hour, minute };
  } catch {
    return { hour: date.getHours(), minute: date.getMinutes() };
  }
}

/** Whether an owner-local hour falls inside the configured quiet window. */
export function isQuietHour(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  return quietStart > quietEnd
    ? (hour >= quietStart || hour < quietEnd)   // overnight range (e.g. 23→7)
    : (hour >= quietStart && hour < quietEnd);  // same-day range (e.g. 8→22)
}

/**
 * Delivery time for a message that must not land inside quiet hours: `now`
 * when we're outside the window, otherwise the start of the `quietEnd` hour
 * (owner-local) — the minute offset within the current hour is dropped so the
 * message goes out as soon as the window opens, never mid-hour.
 */
export function quietEndDeliverAt(
  now: number,
  ownerLocal: LocalClock,
  quietStart: number,
  quietEnd: number,
): number {
  if (!isQuietHour(ownerLocal.hour, quietStart, quietEnd)) return now;
  const hoursUntilEnd = (quietEnd - ownerLocal.hour + 24) % 24;
  const startOfCurrentHour = now - ownerLocal.minute * 60 * 1000;
  return startOfCurrentHour + hoursUntilEnd * HOUR_MS;
}
