import { describe, expect, it } from "vitest";
import { MemoryStore, RunLimiter, type LimitConfig } from "../worker/limits.js";

const LIMITS: LimitConfig = { perVisitorRuns: 3, globalRuns: 10, globalUsd: 2, perRunUsd: 0.5, maxConcurrent: 100 };

function limiter(overrides: Partial<LimitConfig> = {}, start = "2026-10-07T12:00:00Z") {
  let now = new Date(start);
  const store = new MemoryStore(() => now.getTime());
  const l = new RunLimiter(store, { ...LIMITS, ...overrides }, "salt", () => now);
  return { l, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

async function runOnce(l: RunLimiter, ip: string, cost = 0.1) {
  const r = await l.reserve(ip);
  if (r.ok) await l.settle(r.reservation, cost);
  return r;
}

describe("RunLimiter", () => {
  it("allows 3 runs per visitor per day", async () => {
    const { l } = limiter();
    for (let i = 0; i < 3; i++) expect((await runOnce(l, "1.1.1.1")).ok).toBe(true);
    expect(await runOnce(l, "1.1.1.1")).toMatchObject({ ok: false, reason: "visitor_limit" });
    expect((await runOnce(l, "2.2.2.2")).ok).toBe(true);
    expect(await l.status("1.1.1.1")).toMatchObject({ visitorRemaining: 0, perVisitorRuns: 3 });
  });

  it("caps total runs per day across visitors", async () => {
    const { l } = limiter({ globalUsd: 100 });
    for (let i = 0; i < 10; i++) expect((await runOnce(l, `10.0.0.${i}`, 0.01)).ok).toBe(true);
    expect(await runOnce(l, "10.0.1.1")).toMatchObject({ ok: false, reason: "global_runs" });
    // A rejected attempt doesn't use up the visitor's own allowance.
    expect(await l.status("10.0.1.1")).toMatchObject({ visitorRemaining: 3, globalRemaining: 0 });
  });

  it("reserves the per-run cap up front so parallel runs can't overshoot the daily spend", async () => {
    const { l } = limiter({ perVisitorRuns: 10 });
    const open = [];
    for (let i = 0; i < 4; i++) {
      const r = await l.reserve(`ip${i}`);
      expect(r.ok).toBe(true);
      open.push(r);
    }
    // 4 x $0.50 reserved = the $2 cap.
    expect(await l.reserve("ip9")).toMatchObject({ ok: false, reason: "global_budget" });
    // Settling at the real cost frees budget again.
    for (const r of open) if (r.ok) await l.settle(r.reservation, 0.1);
    expect((await l.reserve("ip9")).ok).toBe(true);
  });

  it("stops once actual spend reaches the daily cap", async () => {
    const { l } = limiter({ perVisitorRuns: 10, globalRuns: 100 });
    for (let i = 0; i < 4; i++) await runOnce(l, `ip${i}`, 0.4); // $1.60 spent
    expect(await runOnce(l, "ipX")).toMatchObject({ ok: false, reason: "global_budget" });
    expect((await l.status("ipX")).globalRemaining).toBe(0);
  });

  it("limits concurrent runs", async () => {
    const { l } = limiter({ maxConcurrent: 2 });
    const a = await l.reserve("a");
    await l.reserve("b");
    expect(await l.reserve("c")).toMatchObject({ ok: false, reason: "busy" });
    if (a.ok) await l.settle(a.reservation, 0.1);
    expect((await l.reserve("c")).ok).toBe(true);
  });

  it("gives the slot back when a run cost nothing", async () => {
    const { l } = limiter();
    await runOnce(l, "1.1.1.1", 0);
    expect(await l.status("1.1.1.1")).toMatchObject({ visitorRemaining: 3 });
  });

  it("settles a reservation only once", async () => {
    const { l } = limiter();
    const r = await l.reserve("1.1.1.1");
    if (!r.ok) throw new Error("expected a slot");
    await l.settle(r.reservation, 0);
    await l.settle(r.reservation, 0);
    expect(await l.status("1.1.1.1")).toMatchObject({ visitorRemaining: 3 });
  });

  it("resets at midnight UTC", async () => {
    const { l, advance } = limiter({}, "2026-10-07T23:59:00Z");
    for (let i = 0; i < 3; i++) await runOnce(l, "1.1.1.1");
    expect((await runOnce(l, "1.1.1.1")).ok).toBe(false);
    advance(2 * 60 * 1000);
    expect((await runOnce(l, "1.1.1.1")).ok).toBe(true);
  });

  it("never uses the raw IP as an identifier", () => {
    const { l } = limiter();
    const id = l.visitorId("203.0.113.7");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toContain("203");
  });
});
