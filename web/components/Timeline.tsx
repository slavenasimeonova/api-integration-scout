"use client";

import { useEffect, useRef, useState } from "react";
import { formatSeconds, formatTokens, formatUsd, type RunFigures } from "@/lib/figures";
import { HIDDEN_STEPS, STEP_META } from "@/lib/steps";
import type { ProgressEvent } from "@/lib/types";
import styles from "./Timeline.module.css";

type Props = {
  events: ProgressEvent[];
  running: boolean;
  /** Live runs tick the clock; replays show the recorded times. */
  live: boolean;
  /** Authoritative numbers from the finished analysis; replace the live tallies. */
  final?: RunFigures;
};

/** "Watch the agent think": every progress event, plus token, page and time meters. */
export function Timeline({ events, running, live, final }: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const now = useNow(live && running);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [events.length]);

  const start = events[0] ? Date.parse(events[0].at) : 0;
  const lastAt = events.at(-1) ? Date.parse(events.at(-1)!.at) : start;
  const elapsedMs = live && running ? Math.max(0, now - start) : lastAt - start;

  // Live tallies from the events; once finished, the analysis is the source of truth.
  let tokens: { used: number; max: number } | undefined;
  let maxPages: number | undefined;
  let pagesRead = 0;
  let costUsd: number | undefined;
  for (const e of events) {
    if (e.step === "usage_update" || e.step === "budget_exceeded") tokens = { used: e.totalTokens, max: e.maxTokens };
    if (e.step === "page_fetched") {
      pagesRead++;
      maxPages = e.maxPages;
    }
    if (e.step === "run_completed") costUsd = e.costUsd;
  }
  if (final) {
    pagesRead = final.pagesRead;
    if (tokens) tokens = { ...tokens, used: final.budgetedTokens };
    costUsd = final.costUsd;
  }
  const shownMs = final ? final.durationMs : elapsedMs;
  const visible = events.filter((e) => !HIDDEN_STEPS.has(e.step));

  return (
    <section className={`card ${styles.wrap}`} aria-label="Agent progress">
      <div className={styles.meters}>
        <Meter label="Pages read" value={maxPages ? `${pagesRead} / ${maxPages}` : `${pagesRead}`} fraction={maxPages ? pagesRead / maxPages : 0} />
        <Meter
          label="Budgeted tokens (excl. cache reads)"
          value={tokens ? `${formatTokens(tokens.used)} / ${formatTokens(tokens.max)}` : "0"}
          fraction={tokens ? tokens.used / tokens.max : 0}
        />
        <Meter label="Time" value={formatSeconds(shownMs)} />
        <Meter label="Cost" value={costUsd !== undefined ? formatUsd(costUsd) : running ? "…" : "-"} />
      </div>

      <ol ref={listRef} className={styles.list} aria-live="polite">
        {visible.map((e, i) => {
          const meta = STEP_META[e.step];
          return (
            <li key={i} className={styles.item} data-tone={meta.tone}>
              <span className={styles.time}>+{((Date.parse(e.at) - start) / 1000).toFixed(1)}s</span>
              <span className={styles.tag}>{meta.label}</span>
              <span className={styles.detail}>{e.detail}</span>
            </li>
          );
        })}
        {running && (
          <li className={`${styles.item} ${styles.thinking}`}>
            <span className={styles.time} />
            <span className={styles.dots} aria-label="Agent is working">
              <i />
              <i />
              <i />
            </span>
          </li>
        )}
      </ol>
    </section>
  );
}

function Meter({ label, value, fraction }: { label: string; value: string; fraction?: number }) {
  return (
    <div className={styles.meter}>
      <div className={styles.meterLabel}>{label}</div>
      <div className={styles.meterValue}>{value}</div>
      {fraction !== undefined && (
        <div className={styles.bar}>
          <div style={{ width: `${Math.min(100, fraction * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}
