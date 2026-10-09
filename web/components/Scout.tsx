"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { EXAMPLES } from "@/lib/examples";
import { runFigures } from "@/lib/figures";
import { readNdjson } from "@/lib/ndjson";
import { STATIC_DEMO } from "@/lib/site";
import type { LimitStatus, ProgressEvent, RunResult, RunStreamLine } from "@/lib/types";
import { Results } from "./Results";
import { Timeline } from "./Timeline";
import { AUTHOR } from "./SiteChrome";
import styles from "./Scout.module.css";

type Phase = "idle" | "running" | "done" | "failed" | "cancelled";

function normalizeUrl(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Input, live run and results. A run starts only on a click, never on page load or refresh. */
export function Scout() {
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [result, setResult] = useState<RunResult>();
  const [error, setError] = useState<string>();
  const [limits, setLimits] = useState<LimitStatus | null>();
  const controller = useRef<AbortController | null>(null);

  const refreshLimits = useCallback(async () => {
    try {
      const res = await fetch("/api/limits", { cache: "no-store" });
      setLimits(res.ok ? ((await res.json()) as LimitStatus) : null);
    } catch {
      setLimits(null);
    }
  }, []);

  useEffect(() => {
    if (!STATIC_DEMO) void refreshLimits();
    return () => controller.current?.abort();
  }, [refreshLimits]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (STATIC_DEMO) return;
    const url = normalizeUrl(input);
    if (!url) {
      setError("Enter a full http(s) URL of an API docs page.");
      return;
    }
    controller.current = new AbortController();
    setPhase("running");
    setEvents([]);
    setResult(undefined);
    setError(undefined);

    let gotResult = false;
    let gotEvents = false;
    let failure: string | undefined;
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: controller.current.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `The scout worker answered HTTP ${res.status}.`);
        setPhase("idle");
        return;
      }
      for await (const line of readNdjson<RunStreamLine>(res.body)) {
        if (line.type === "event") {
          gotEvents = true;
          setEvents((prev) => [...prev, line.event]);
        }
        else if (line.type === "result") {
          gotResult = true;
          setResult({ analysis: line.analysis, slug: line.slug, files: line.files, postmanErrors: line.postmanErrors });
        } else failure = line.message;
      }
      if (gotResult) setPhase("done");
      else {
        setError(failure ?? "The connection ended before the run finished.");
        setPhase("failed");
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") setPhase("cancelled");
      else {
        setError("Couldn't reach the scout worker. Is it running?");
        setPhase(gotEvents ? "failed" : "idle");
      }
    } finally {
      controller.current = null;
      void refreshLimits();
    }
  }

  function reset() {
    setPhase("idle");
    setEvents([]);
    setResult(undefined);
    setError(undefined);
  }

  const running = phase === "running";
  const outOfRuns = limits ? limits.visitorRemaining === 0 || limits.globalRemaining === 0 : false;

  return (
    <>
      <form className={`card ${styles.form}`} onSubmit={start}>
        <label htmlFor="docs-url" className={styles.label}>
          Paste API docs URL
        </label>
        <div className={styles.inputRow}>
          <input
            id="docs-url"
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="https://docs.example.com/api"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={running || STATIC_DEMO}
            className={styles.input}
          />
          {running ? (
            <button type="button" className="btn" onClick={() => controller.current?.abort()}>
              Cancel
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={STATIC_DEMO || !input.trim() || outOfRuns || limits === null}>
              Scout it
            </button>
          )}
        </div>
        <p className="muted small">
          {STATIC_DEMO ? (
            <>
              Live runs are disabled in this public demo to control API costs.{" "}
              <a href={AUTHOR.github} target="_blank" rel="noreferrer noopener">
                Clone the repo
              </a>{" "}
              to run it locally.
            </>
          ) : (
            <LimitsNote limits={limits} />
          )}
        </p>
        {error && phase === "idle" && <p className="error-box small">{error}</p>}
      </form>

      <section className={styles.examples} aria-label="Examples">
        <p className="muted small">Or open a saved run: instant, no API call.</p>
        <div className={styles.exampleGrid}>
          {EXAMPLES.map((ex) => (
            <Link key={ex.slug} href={`/examples/${ex.slug}`} className={`card ${styles.example}`}>
              <strong>{ex.name}</strong>
              <span className="muted small">{ex.highlight}</span>
            </Link>
          ))}
        </div>
      </section>

      {phase !== "idle" && (
        <div className={styles.run}>
          <Timeline events={events} running={running} live final={result ? runFigures(result.analysis) : undefined} />
          {phase === "failed" && <p className="error-box">{error}</p>}
          {phase === "cancelled" && <p className="muted">Run cancelled. Nothing more will be spent on it.</p>}
          {(phase === "failed" || phase === "cancelled" || phase === "done") && (
            <button type="button" className="btn" onClick={reset}>
              Scout another API
            </button>
          )}
        </div>
      )}

      {phase === "done" && result && <Results result={result} />}
    </>
  );
}

function LimitsNote({ limits }: { limits: LimitStatus | null | undefined }) {
  if (limits === undefined) return <>Checking live-run availability…</>;
  if (limits === null) return <>Live runs are unavailable right now. The examples below still work.</>;
  if (limits.globalRemaining === 0) return <>The demo has used today&rsquo;s live runs. Try the examples, or come back tomorrow.</>;
  return (
    <>
      {limits.visitorRemaining} of {limits.perVisitorRuns} live runs left today. A run takes about 30 seconds.
    </>
  );
}
