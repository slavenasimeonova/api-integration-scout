"use client";

import Link from "next/link";
import { useState } from "react";
import { BASE_PATH, MAX_GOAL_CHARS, REQUEST_API } from "@/lib/site";
import styles from "./Scout.module.css";

type Sent = { id: string };

/**
 * Request mode: a visitor with an access code asks for a run. The request is
 * reviewed and run by hand, and the result is published at /results/?id=...
 * Shown only in the static build when REQUEST_API is set.
 */
export function AccessCodeRequest() {
  const [code, setCode] = useState("");
  const [url, setUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<Sent>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(undefined);
    try {
      const raw = url.trim();
      const res = await fetch(`${REQUEST_API}/api/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          url: /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`,
          ...(goal.trim() ? { goal: goal.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (res.ok && body.id) setSent({ id: body.id });
      else setError(body.message ?? `The request failed (HTTP ${res.status}).`);
    } catch {
      setError("Couldn't reach the request service. Please try again later.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    const href = `/results/?id=${sent.id}`;
    const full = `${window.location.origin}${BASE_PATH}${href}`;
    return (
      <section className={`card ${styles.form}`} aria-live="polite">
        <strong>Request received</strong>
        <p className="small">
          I review each request and run it myself, usually within a day. Bookmark this link; the result appears there:
        </p>
        <p className="small">
          <Link href={href} style={{ overflowWrap: "anywhere" }}>
            {full}
          </Link>
        </p>
      </section>
    );
  }

  return (
    <details className={`card ${styles.form}`}>
      <summary className={styles.label} style={{ cursor: "pointer", marginBottom: 0 }}>
        Have an access code?
      </summary>
      <form onSubmit={submit} style={{ marginTop: "0.8rem" }}>
        <p className="muted small" style={{ marginTop: 0 }}>
          Enter your code and an API docs URL. I review each request, run it and publish the result for you.
        </p>
        <div className={styles.inputRow}>
          <input
            aria-label="Access code"
            placeholder="scout-xxxxx-xxxxx-xxxxx-xxxxx"
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={styles.input}
            disabled={sending}
          />
        </div>
        <div className={styles.inputRow} style={{ marginTop: "0.5rem" }}>
          <input
            aria-label="API docs URL"
            type="text"
            inputMode="url"
            placeholder="https://docs.example.com/api"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={styles.input}
            disabled={sending}
          />
        </div>
        <textarea
          aria-label="Goal (optional)"
          placeholder="Goal (optional), e.g. receive tracking events by webhook"
          maxLength={MAX_GOAL_CHARS}
          rows={2}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          className={`${styles.input} ${styles.goal}`}
          disabled={sending}
        />
        <p className="muted small" style={{ margin: "0.3rem 0 0" }}>
          With a goal, only the pages and endpoints it needs are analyzed. The goal is published with the result, so please
          don&apos;t include confidential information (client names, internal systems, credentials).
        </p>
        <div className={styles.inputRow} style={{ marginTop: "0.5rem" }}>
          <button type="submit" className="btn btn-primary" disabled={sending || !code.trim() || !url.trim()}>
            {sending ? "Sending…" : "Request a run"}
          </button>
        </div>
        {error && <p className="error-box small">{error}</p>}
      </form>
    </details>
  );
}
