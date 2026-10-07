import { createHash } from "node:crypto";

/**
 * Daily limits for live runs: per visitor, global run count, and global spend.
 * Counters live in a LimitStore; MemoryStore works for a single instance, and a
 * persistent store (e.g. Redis) can be plugged in when the hosting is chosen.
 */

export type LimitStore = {
  /** Adds `by` to the counter (creating it with the TTL) and returns the new value. */
  incr(key: string, by: number, ttlSeconds: number): Promise<number>;
  get(key: string): Promise<number>;
};

export class MemoryStore implements LimitStore {
  private readonly values = new Map<string, { value: number; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async incr(key: string, by: number, ttlSeconds: number): Promise<number> {
    const entry = this.live(key) ?? { value: 0, expiresAt: this.now() + ttlSeconds * 1000 };
    entry.value += by;
    this.values.set(key, entry);
    return entry.value;
  }

  async get(key: string): Promise<number> {
    return this.live(key)?.value ?? 0;
  }

  private live(key: string) {
    const entry = this.values.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry;
  }
}

export type LimitConfig = {
  perVisitorRuns: number;
  globalRuns: number;
  globalUsd: number;
  /** Reserved per run up front, so parallel runs can't overshoot globalUsd (= SCOUT_MAX_BUDGET_USD). */
  perRunUsd: number;
  maxConcurrent: number;
};

export const DEFAULT_LIMITS: Omit<LimitConfig, "perRunUsd"> = {
  perVisitorRuns: 3,
  globalRuns: 10,
  globalUsd: 2,
  maxConcurrent: 2,
};

export type LimitReason = "visitor_limit" | "global_runs" | "global_budget" | "busy";

export type Reservation = { visitor: string; day: string; reservedMicros: number; settled: boolean };

export type ReserveResult = { ok: true; reservation: Reservation } | { ok: false; reason: LimitReason; message: string };

export type LimitStatus = {
  visitorRemaining: number;
  perVisitorRuns: number;
  globalRemaining: number;
};

const TTL_SECONDS = 2 * 24 * 60 * 60;
const MICROS = 1_000_000;

export class RunLimiter {
  private active = 0;

  constructor(
    private readonly store: LimitStore,
    private readonly limits: LimitConfig,
    /** Salt for hashing visitor IPs, so raw IPs are never stored. */
    private readonly salt: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  visitorId(ip: string): string {
    return createHash("sha256").update(`${this.salt}:${ip}`).digest("hex").slice(0, 16);
  }

  private keys(visitor: string, day: string) {
    return {
      visitor: `runs:${day}:v:${visitor}`,
      runs: `runs:${day}:all`,
      usd: `usd-micros:${day}`,
    };
  }

  private day(): string {
    return this.now().toISOString().slice(0, 10); // UTC day
  }

  async status(ip: string): Promise<LimitStatus> {
    const k = this.keys(this.visitorId(ip), this.day());
    const [visitorRuns, runs, usdMicros] = await Promise.all([this.store.get(k.visitor), this.store.get(k.runs), this.store.get(k.usd)]);
    const budgetRuns = Math.floor((this.limits.globalUsd * MICROS - usdMicros) / (this.limits.perRunUsd * MICROS));
    return {
      visitorRemaining: Math.max(0, this.limits.perVisitorRuns - visitorRuns),
      perVisitorRuns: this.limits.perVisitorRuns,
      globalRemaining: Math.max(0, Math.min(this.limits.globalRuns - runs, budgetRuns)),
    };
  }

  /** Claims a run slot before the run starts, so parallel requests can't slip past the limits. */
  async reserve(ip: string): Promise<ReserveResult> {
    if (this.active >= this.limits.maxConcurrent) {
      return { ok: false, reason: "busy", message: "The scout is busy with other runs. Try again in a minute." };
    }
    this.active++;
    const visitor = this.visitorId(ip);
    const day = this.day();
    const k = this.keys(visitor, day);
    const reservedMicros = Math.round(this.limits.perRunUsd * MICROS);
    const undo: [string, number][] = [];
    const reject = async (reason: LimitReason, message: string): Promise<ReserveResult> => {
      for (const [key, by] of undo) await this.store.incr(key, -by, TTL_SECONDS);
      this.active--;
      return { ok: false, reason, message };
    };

    undo.push([k.visitor, 1]);
    if ((await this.store.incr(k.visitor, 1, TTL_SECONDS)) > this.limits.perVisitorRuns) {
      return reject("visitor_limit", `You've used your ${this.limits.perVisitorRuns} live runs for today. The examples are always available.`);
    }
    undo.push([k.runs, 1]);
    if ((await this.store.incr(k.runs, 1, TTL_SECONDS)) > this.limits.globalRuns) {
      return reject("global_runs", "The demo has reached today's limit of live runs. The examples are always available.");
    }
    undo.push([k.usd, reservedMicros]);
    if ((await this.store.incr(k.usd, reservedMicros, TTL_SECONDS)) > this.limits.globalUsd * MICROS) {
      return reject("global_budget", "The demo has reached today's spending limit. The examples are always available.");
    }
    return { ok: true, reservation: { visitor, day, reservedMicros, settled: false } };
  }

  /**
   * Replaces the reserved amount with the actual cost. A run that cost nothing
   * (e.g. it failed before calling the model) gives its run slots back.
   */
  async settle(reservation: Reservation, costUsd: number): Promise<void> {
    if (reservation.settled) return;
    reservation.settled = true;
    this.active--;
    const k = this.keys(reservation.visitor, reservation.day);
    const actualMicros = Math.round(Math.max(0, costUsd) * MICROS);
    await this.store.incr(k.usd, actualMicros - reservation.reservedMicros, TTL_SECONDS);
    if (actualMicros === 0) {
      await this.store.incr(k.visitor, -1, TTL_SECONDS);
      await this.store.incr(k.runs, -1, TTL_SECONDS);
    }
  }
}
