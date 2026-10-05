export type UsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

export type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Tokens counted against the budget: input + cache writes + output. */
  budgetedTokens: number;
};

/**
 * Tracks token usage during a run and reports when the budget is crossed.
 *
 * Cache reads are recorded but not counted against the budget: every turn
 * re-sends the conversation, so counting cached re-reads would end most runs
 * early even though they're billed at a fraction of input price. The SDK's
 * USD cap (maxBudgetUsd) still covers their cost.
 *
 * Usage is keyed by API message id because the SDK may deliver one response
 * as several assistant messages carrying the same usage.
 */
export class TokenBudget {
  private readonly byMessage = new Map<string, Required<{ [K in keyof UsageLike]: number }>>();
  private exceededReported = false;

  constructor(readonly maxTokens: number) {}

  /** Records usage for one API message. Returns true the first time the budget is exceeded. */
  record(messageId: string, usage: UsageLike): boolean {
    this.byMessage.set(messageId, {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    });
    if (!this.exceededReported && this.exceeded) {
      this.exceededReported = true;
      return true;
    }
    return false;
  }

  get exceeded(): boolean {
    return this.totals.budgetedTokens > this.maxTokens;
  }

  get totals(): TokenTotals {
    const t = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    for (const u of this.byMessage.values()) {
      t.inputTokens += u.input_tokens;
      t.outputTokens += u.output_tokens;
      t.cacheCreationInputTokens += u.cache_creation_input_tokens;
      t.cacheReadInputTokens += u.cache_read_input_tokens;
    }
    return { ...t, budgetedTokens: t.inputTokens + t.cacheCreationInputTokens + t.outputTokens };
  }
}
