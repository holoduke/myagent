import { describe, it, expect } from "vitest";
import { createDailyBudget } from "../../backend/utils/daily-budget.js";

describe("createDailyBudget", () => {
  it("allows up to the limit and refuses beyond it", () => {
    const budget = createDailyBudget({ limit: 2, dayKey: () => "2026-01-01" });
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.used()).toBe(2);
    expect(budget.remaining()).toBe(0);
    expect(budget.refused()).toBe(1);
  });

  it("resets when the day key changes", () => {
    let day = "2026-01-01";
    const budget = createDailyBudget({ limit: 1, dayKey: () => day });
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    day = "2026-01-02";
    expect(budget.remaining()).toBe(1);
    expect(budget.refused()).toBe(0);
    expect(budget.tryConsume()).toBe(true);
  });
});
