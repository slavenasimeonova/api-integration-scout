import { describe, expect, it } from "vitest";
import { TokenBudget } from "../src/core/budget.js";

describe("TokenBudget", () => {
  it("sums usage across messages, excluding cache reads from the budget", () => {
    const budget = new TokenBudget(10_000);
    budget.record("msg_1", { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 });
    budget.record("msg_2", { input_tokens: 50, output_tokens: 300, cache_creation_input_tokens: 500, cache_read_input_tokens: 4000 });
    expect(budget.totals).toEqual({
      inputTokens: 1050,
      outputTokens: 500,
      cacheCreationInputTokens: 3500,
      cacheReadInputTokens: 4000,
      budgetedTokens: 5050,
    });
    expect(budget.exceeded).toBe(false);
  });

  it("does not double count repeated frames of the same message", () => {
    const budget = new TokenBudget(10_000);
    budget.record("msg_1", { input_tokens: 100, output_tokens: 10 });
    budget.record("msg_1", { input_tokens: 100, output_tokens: 50 });
    expect(budget.totals.budgetedTokens).toBe(150);
  });

  it("reports crossing the budget exactly once", () => {
    const budget = new TokenBudget(1000);
    expect(budget.record("a", { input_tokens: 600 })).toBe(false);
    expect(budget.record("b", { input_tokens: 600 })).toBe(true);
    expect(budget.record("c", { input_tokens: 10 })).toBe(false);
    expect(budget.exceeded).toBe(true);
  });

  it("tolerates missing and null usage fields", () => {
    const budget = new TokenBudget(1000);
    budget.record("a", { input_tokens: null, output_tokens: 5 });
    expect(budget.totals.budgetedTokens).toBe(5);
  });
});
