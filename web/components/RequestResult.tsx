"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { assetUrl, REQUEST_API } from "@/lib/site";
import styles from "./RequestResult.module.css";
import { RunReplay } from "./RunReplay";

type Status = { status: "pending" | "done" | "declined"; url: string; goal?: string; createdAt: string; note?: string };

type View =
  | { kind: "loading" }
  | { kind: "result"; src: string }
  | { kind: "status"; status: Status }
  | { kind: "message"; text: string; error?: boolean };

const ID = /^[a-z0-9]{26}$/;
/** How often an open page checks whether the result was published (a static file on Pages, not the API). */
export const RESULT_CHECK_MS = 60_000;
const READY_TITLE = "✅ Ready – API Integration Scout";
const isPublished = (src: string) => fetch(src, { method: "HEAD", cache: "no-store" }).then((r) => r.ok, () => false);
const canNotify = () => typeof window !== "undefined" && "Notification" in window;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

/**
 * A requested run: the published result if there is one (a static file on this
 * site), otherwise the request's status from the request API. While a request
 * is waiting, the page checks for the result every minute, also in a background
 * tab, then shows a toast, marks the tab title and, if the visitor asked,
 * sends one browser notification.
 */
export function RequestResult() {
  const id = useSearchParams().get("id") ?? "";
  const [view, setView] = useState<View>({ kind: "loading" });
  const [ready, setReady] = useState(false);
  const [notify, setNotify] = useState<"off" | "on" | "denied">("off");
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    if (!ID.test(id)) {
      setView({ kind: "message", text: "This link is incomplete. Check that you copied all of it.", error: true });
      return;
    }
    let cancelled = false;
    (async () => {
      const src = assetUrl(`/results/${id}.json`);
      if (await isPublished(src)) return { kind: "result", src } as const;
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

  const waiting = view.kind === "status" && view.status.status !== "declined" && !ready;
  useEffect(() => {
    if (!waiting) return;
    const src = assetUrl(`/results/${id}.json`);
    const timer = setInterval(async () => {
      if (!(await isPublished(src))) return;
      clearInterval(timer);
      setReady(true);
      document.title = READY_TITLE;
      if (notifyRef.current === "on" && canNotify() && Notification.permission === "granted") {
        const n = new Notification("Your analysis is ready", { body: "API Integration Scout: open the tab to see it.", tag: id });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      }
    }, RESULT_CHECK_MS);
    return () => clearInterval(timer);
  }, [waiting, id]);

  async function askToNotify() {
    if (!canNotify()) return;
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    setNotify(permission === "granted" ? "on" : "denied");
  }

  function openResult() {
    setView({ kind: "result", src: assetUrl(`/results/${id}.json`) });
    window.scrollTo({ top: 0 });
  }

  const toast = ready && view.kind !== "result" && (
    <div className={styles.toast} role="status">
      <span>✅ Your analysis is ready</span>
      <button type="button" className={`btn ${styles.open}`} onClick={openResult}>
        Open
      </button>
    </div>
  );

  if (view.kind === "loading") return <p className="muted">Loading…</p>;
  if (view.kind === "result") return <RunReplay src={view.src} />;
  if (view.kind === "message") return <p className={view.error ? "error-box" : "muted"}>{view.text}</p>;

  const { status } = view;
  return (
    <section className="card" style={{ display: "grid", gap: "0.4rem" }}>
      <p style={{ margin: 0 }}>
        <strong>
          {ready && "Ready"}
          {!ready && status.status === "pending" && "Waiting for review"}
          {!ready && status.status === "done" && "Being published"}
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
        {ready && "Your analysis is published."}
        {!ready && status.status === "pending" && "I review each request and run it myself, usually within a day, and I'll message you when it's ready."}
        {!ready && status.status === "done" && "The run is finished and the result is being published."}
        {status.status === "declined" && (status.note ? `Reason: ${status.note}` : "This request won't be run.")}
      </p>
      {status.status !== "declined" && !ready && (
        <div className={`small ${styles.watch}`}>
          <span className="muted">While this page is open, it checks for the result every minute.</span>
          {canNotify() && notify === "off" && Notification.permission !== "denied" && (
            <button type="button" className="btn" onClick={askToNotify}>
              Notify me
            </button>
          )}
          {notify === "on" && <span>You&apos;ll get a notification when it&apos;s ready.</span>}
          {(notify === "denied" || (canNotify() && notify === "off" && Notification.permission === "denied")) && (
            <span className="muted">Notifications are blocked, but this page will still show a message.</span>
          )}
        </div>
      )}
      {ready && (
        <div className={styles.watch}>
          <button type="button" className="btn btn-primary" onClick={openResult}>
            Open analysis
          </button>
        </div>
      )}
      {toast}
    </section>
  );
}
