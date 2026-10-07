"use client";

import { useEffect, useState } from "react";
import type { ExampleBundle } from "@/lib/types";
import { runFigures } from "@/lib/figures";
import { Results } from "./Results";
import { Timeline } from "./Timeline";

/** Replay speed-up; long pauses (model thinking) are capped so a replay takes a few seconds. */
const SPEEDUP = 4;
const MAX_GAP_MS = 1200;

/** Replays a saved run's progress events, then shows its results. */
export function ExampleReplay({ slug }: { slug: string }) {
  const [bundle, setBundle] = useState<ExampleBundle>();
  const [shown, setShown] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/examples/${slug}.json`)
      .then((res) => (res.ok ? (res.json() as Promise<ExampleBundle>) : Promise.reject(new Error(String(res.status)))))
      .then((b) => !cancelled && setBundle(b))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!bundle || shown >= bundle.events.length) return;
    const prev = bundle.events[shown - 1];
    const next = bundle.events[shown]!;
    const gap = prev ? (Date.parse(next.at) - Date.parse(prev.at)) / SPEEDUP : 0;
    const id = setTimeout(() => setShown((n) => n + 1), Math.min(MAX_GAP_MS, gap));
    return () => clearTimeout(id);
  }, [bundle, shown]);

  if (error) return <p className="error-box">Couldn&rsquo;t load this example.</p>;
  if (!bundle) return <p className="muted">Loading…</p>;

  const done = shown >= bundle.events.length;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "0.8rem", justifyItems: "start" }}>
      <div style={{ width: "100%" }}>
        <Timeline events={bundle.events.slice(0, shown)} running={!done} live={false} final={done ? runFigures(bundle.analysis) : undefined} />
      </div>
      {!done && (
        <button type="button" className="btn" onClick={() => setShown(bundle.events.length)}>
          Skip to results
        </button>
      )}
      {done && (
        <div style={{ width: "100%" }}>
          <Results result={bundle} />
        </div>
      )}
    </div>
  );
}
