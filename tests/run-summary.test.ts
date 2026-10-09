import { describe, expect, it } from "vitest";
import { summaryLine, type RunReport } from "../src/postman/run.js";

const totals = (t: Partial<RunReport["totals"]>): RunReport["totals"] => ({
  requests: 0,
  run: 0,
  passed: 0,
  failed: 0,
  expectedFailures: 0,
  skipped: 0,
  ...t,
});

describe("Newman runner: summary line", () => {
  it("uses the singular for one", () => {
    expect(summaryLine(totals({ requests: 1, run: 1, expectedFailures: 1 }))).toBe(
      "0 passed, 0 failed, 1 expected failure, 0 skipped of 1 request",
    );
  });

  it("uses the plural for zero and many", () => {
    expect(summaryLine(totals({ requests: 5, run: 3, passed: 2, failed: 1, skipped: 2 }))).toBe(
      "2 passed, 1 failed, 0 expected failures, 2 skipped of 5 requests",
    );
    expect(summaryLine(totals({ requests: 2, run: 2, expectedFailures: 2 }))).toBe(
      "0 passed, 0 failed, 2 expected failures, 0 skipped of 2 requests",
    );
  });
});
