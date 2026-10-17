"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { assetUrl, REQUEST_API } from "@/lib/site";
import { RunReplay } from "./RunReplay";

type Status = { status: "pending" | "done" | "declined"; url: string; goal?: string; createdAt: string; note?: string };

type View =
  | { kind: "loading" }
  | { kind: "result"; src: string }
  | { kind: "status"; status: Status }
  | { kind: "message"; text: string; error?: boolean };

const ID = /^[a-z0-9]{26}$/;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

/**
 * A requested run: the published result if there is one (a static file on this
 * site), otherwise the request's status from the request API.
 */
export function RequestResult() {
  const id = useSearchParams().get("id") ?? "";
  const [view, setView] = useState<View>({ kind: "loading" });

  useEffect(() => {
    if (!ID.test(id)) {
      setView({ kind: "message", text: "This link is incomplete. Check that you copied all of it.", error: true });
      return;
    }
    let cancelled = false;
    (async () => {
      const src = assetUrl(`/results/${id}.json`);
      const published = await fetch(src, { method: "HEAD", cache: "no-store" }).then((r) => r.ok, () => false);
      if (published) return { kind: "result", src } as const;
      if (!REQUEST_API) return { kind: "message", text: "No result has been published for this link yet." } as const;
      const res = await fetch(`${REQUEST_API}/api/requests/${id}`, { cache: "no-store" });
      if (res.status === 404) return { kind: "message", text: "There's no request with this link.", error: true } as const;
      if (!res.ok) throw new Error(String(res.status));
      return { kind: "status", status: (await res.json()) as Status } as const;
    })().then(
      (v) => !cancelled && setView(v),
      () => !cancelled && setView({ kind: "message", text: "Couldn't check this request right now. Please try again later.", error: true }),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (view.kind === "loading") return <p className="muted">Loading…</p>;
  if (view.kind === "result") return <RunReplay src={view.src} />;
  if (view.kind === "message") return <p className={view.error ? "error-box" : "muted"}>{view.text}</p>;

  const { status } = view;
  return (
    <section className="card" style={{ display: "grid", gap: "0.4rem" }}>
      <p style={{ margin: 0 }}>
        <strong>
          {status.status === "pending" && "Waiting for review"}
          {status.status === "done" && "Being published"}
          {status.status === "declined" && "Declined"}
        </strong>
      </p>
      <p className="small" style={{ margin: 0, overflowWrap: "anywhere" }}>
        {status.url}
        <span className="muted"> · requested {when(status.createdAt)}</span>
      </p>
      {status.goal && (
        <p className="small" style={{ margin: 0 }}>
          <strong>Goal:</strong> {status.goal}
        </p>
      )}
      <p className="muted small" style={{ margin: 0 }}>
        {status.status === "pending" && "I review each request and run it myself, usually within a day. This page shows the result once it's published."}
        {status.status === "done" && "The run is finished and the result is being published. Check back in a few minutes."}
        {status.status === "declined" && (status.note ? `Reason: ${status.note}` : "This request won't be run.")}
      </p>
    </section>
  );
}
