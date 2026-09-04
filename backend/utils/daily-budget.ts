/**
 * In-memory daily call budget.
 *
 * Counts consumptions per calendar day (the day key is injectable so callers
 * can use the owner's timezone) and refuses once the limit is reached. State
 * is intentionally not persisted: a restart resets the counter, which errs on
 * the side of availability rather than starving a fresh instance.
 */

export interface DailyBudget {
  /** Consume one unit. Returns false (without consuming) when exhausted. */
  tryConsume(): boolean;
  /** Units left for the current day. */
  remaining(): number;
  /** Units consumed for the current day. */
  used(): number;
  /** Number of refused consumptions for the current day. */
  refused(): number;
}

export function createDailyBudget(opts: { limit: number; dayKey: () => string }): DailyBudget {
  let day = opts.dayKey();
  let used = 0;
  let refused = 0;

  const rollover = (): void => {
    const today = opts.dayKey();
    if (today !== day) {
      day = today;
      used = 0;
      refused = 0;
    }
  };

  return {
    tryConsume(): boolean {
      rollover();
      if (used >= opts.limit) {
        refused += 1;
        return false;
      }
      used += 1;
      return true;
    },
    remaining(): number {
      rollover();
      return Math.max(0, opts.limit - used);
    },
    used(): number {
      rollover();
      return used;
    },
    refused(): number {
      rollover();
      return refused;
    },
  };
}
