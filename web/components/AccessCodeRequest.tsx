"use client";

import Link from "next/link";
import { useState } from "react";
import { friendlyError } from "@/lib/api-errors";
import { BASE_PATH, MAX_GOAL_CHARS, REQUEST_API } from "@/lib/site";
import { GoalInterview, type Turn } from "./GoalInterview";
import styles from "./Scout.module.css";

type Step = "code" | "chat" | "confirm" | "sent";

const withScheme = (raw: string) => (/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);

/**
 * Request mode: a visitor with an access code asks for a run. The code is
 * checked first; then the goal assistant (a short chat) writes the goal, the
 * visitor edits it and sends the request. If the assistant is off, busy or
 * over a limit, the visitor writes the goal by hand. Requests are reviewed and
 * run by hand, and the result is published at /results/?id=...
 * Shown only in the static build when REQUEST_API is set.
 */
export function AccessCodeRequest() {
  const [step, setStep] = useState<Step>("code");
  const [code, setCode] = useState("");
  const [url, setUrl] = useState("");
  const [interviewId, setInterviewId] = useState<string>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [questionsLeft, setQuestionsLeft] = useState(0);
  const [goal, setGoal] = useState("");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sentId, setSentId] = useState<string>();

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`${REQUEST_API}/api/interview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim(), url: withScheme(url.trim()) }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; questionsLeft?: number; interview?: boolean; error?: string };
      if (res.status === 201 && body.id && body.message) {
        setInterviewId(body.id);
        setTurns([{ role: "assistant", text: body.message }]);
        setQuestionsLeft(body.questionsLeft ?? 0);
        setStep("chat");
      } else if ((res.ok && body.interview === false) || res.status === 404) {
        // Assistant off, or the API predates it: the code is checked when the request is sent.
        setStep("confirm");
      } else if (res.status === 429 && body.error?.startsWith("interview_limit")) {
        // The code is valid; only the assistant is out of conversations.
        setNotice(friendlyError(body.error, "interview"));
        setStep("confirm");
      } else {
        setError(friendlyError(body.error, "code"));
      }
    } catch {
      setError("Couldn't reach the request service. Please try again later.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`${REQUEST_API}/api/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          url: withScheme(url.trim()),
          ...(goal.trim() ? { goal: goal.trim() } : {}),
          ...(interviewId ? { interviewId } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; error?: string };
      if (res.ok && body.id) {
        setSentId(body.id);
        setStep("sent");
      } else {
        // An expired conversation only loses the link to its transcript; the goal is still in the box.
        if (body.error === "invalid_interview") setInterviewId(undefined);
        setError(friendlyError(body.error, "request"));
      }
    } catch {
      setError("Couldn't reach the request service. Please try again later.");
    } finally {
      setBusy(false);
    }
  }

  if (step === "sent" && sentId) {
    const href = `/results/?id=${sentId}`;
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
    <details className={`card ${styles.form}`} open={step !== "code" || undefined}>
      <summary className={styles.label} style={{ cursor: "pointer", marginBottom: 0 }}>
        Have an access code?
      </summary>

      {step === "code" && (
        <form onSubmit={start} style={{ marginTop: "0.8rem" }}>
          <p className="muted small" style={{ marginTop: 0 }}>
            Enter your code and an API docs URL. A short chat helps you describe what you&apos;re building; then I review the
            request, run it and publish the result for you.
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
              disabled={busy}
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
              disabled={busy}
            />
          </div>
          <div className={styles.actions}>
            <button type="submit" className="btn btn-primary" disabled={busy || !code.trim() || !url.trim()}>
              {busy ? "Checking…" : "Continue"}
            </button>
          </div>
          {error && <p className="error-box small">{error}</p>}
        </form>
      )}

      {step === "chat" && interviewId && (
        <div style={{ marginTop: "0.8rem" }}>
          <p className="muted small" style={{ marginTop: 0 }}>
            A few questions help write a focused goal. This conversation is kept for 14 days so I can review your request,
            then deleted. Please don&apos;t include confidential information (client names, internal systems, credentials).
          </p>
          <GoalInterview
            interviewId={interviewId}
            turns={turns}
            questionsLeft={questionsLeft}
            onTurns={(next, left) => {
              setTurns(next);
              setQuestionsLeft(left);
            }}
            onGoal={(proposed, message) => {
              setGoal(proposed);
              setNotice(message);
              setStep("confirm");
            }}
          />
        </div>
      )}

      {step === "confirm" && (
        <form onSubmit={submit} style={{ marginTop: "0.8rem" }}>
          {notice && <p className="muted small" style={{ marginTop: 0 }}>{notice}</p>}
          <label htmlFor="request-goal" className={styles.label}>
            {goal ? "Check and edit the goal" : "Goal (optional)"}
          </label>
          <textarea
            id="request-goal"
            placeholder="e.g. receive a webhook when a new issue is opened and verify its signature"
            maxLength={MAX_GOAL_CHARS}
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            className={`${styles.input} ${styles.goal}`}
            disabled={busy}
          />
          <p className="muted small" style={{ margin: "0.3rem 0 0" }}>
            With a goal, only the pages and endpoints it needs are analyzed. The goal is published with the result, so please
            don&apos;t include confidential information (client names, internal systems, credentials).
          </p>
          <div className={styles.actions}>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Sending…" : "Request a run"}
            </button>
          </div>
          {error && <p className="error-box small">{error}</p>}
        </form>
      )}
    </details>
  );
}
