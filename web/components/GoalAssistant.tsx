"use client";

import Link from "next/link";
import { useState } from "react";
import { friendlyError } from "@/lib/api-errors";
import { BASE_PATH, MAX_GOAL_CHARS, REQUEST_API } from "@/lib/site";
import { GoalInterview, type Turn } from "./GoalInterview";
import { AUTHOR } from "./SiteChrome";
import styles from "./Scout.module.css";

type Step = "url" | "chat" | "confirm" | "sent";

const withScheme = (raw: string) => (/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);

/** Start errors about the visitor's input stay on the first step; any other failure only costs the assistant. */
const STAY_ON_URL = new Set(["invalid_url", "invalid_body", "paused"]);

/**
 * The public demo's first step: anyone enters a docs URL and the goal
 * assistant (a short chat) writes the goal. The access code is asked only at
 * the end, when the visitor requests the run, the part that costs money.
 * Requests are reviewed and run by hand, and the result is published at
 * /results/?id=... If the assistant is off, busy or over a limit, the visitor
 * writes the goal by hand. Shown only in the static build when REQUEST_API is set.
 */
export function GoalAssistant() {
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [interviewId, setInterviewId] = useState<string>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [questionsLeft, setQuestionsLeft] = useState(0);
  const [goal, setGoal] = useState("");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sentId, setSentId] = useState<string>();
  const [copied, setCopied] = useState(false);

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. an insecure context): the link is still on screen to copy by hand.
      window.prompt("Copy this link:", link);
    }
  }

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`${REQUEST_API}/api/interview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: withScheme(url.trim()) }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; questionsLeft?: number; interview?: boolean; error?: string };
      if (res.status === 201 && body.id && body.message) {
        setInterviewId(body.id);
        setTurns([{ role: "assistant", text: body.message }]);
        setQuestionsLeft(body.questionsLeft ?? 0);
        setStep("chat");
      } else if (res.ok && body.interview === false) {
        // The assistant is switched off: the visitor writes the goal.
        setStep("confirm");
      } else if (typeof body.error === "string" && STAY_ON_URL.has(body.error)) {
        setError(friendlyError(body.error, "start"));
      } else {
        // Over a limit, unavailable, or an API older than this page: the request still works without the assistant.
        setNotice(res.status === 429 ? friendlyError(body.error, "start") : "The goal assistant isn't available right now. Please write the goal yourself.");
        setStep("confirm");
      }
    } catch {
      setError("Couldn't reach the goal assistant. Please try again later.");
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
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
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

  function startOver() {
    setStep("url");
    setInterviewId(undefined);
    setTurns([]);
    setGoal("");
    setNotice(undefined);
    setError(undefined);
  }

  if (step === "sent" && sentId) {
    const href = `/results/?id=${sentId}`;
    const full = `${window.location.origin}${BASE_PATH}${href}`;
    return (
      <section className={`card ${styles.form} ${styles.assistant}`} aria-live="polite">
        <strong>Request received</strong>
        <p className="small">
          I review each request and run it myself, usually within a day, and I&apos;ll message you when it&apos;s ready. The
          result will appear at this link:
        </p>
        <div className={`small ${styles.linkRow}`}>
          <Link href={href} style={{ overflowWrap: "anywhere" }}>
            {full}
          </Link>
          <button type="button" className="btn" onClick={() => copyLink(full)}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={`card ${styles.form} ${styles.assistant}`} aria-label="Goal assistant">
      {step === "url" && (
        <form onSubmit={start}>
          <label htmlFor="assistant-url" className={styles.label}>
            Paste API docs URL
          </label>
          <p className="muted small" style={{ margin: "0 0 0.6rem" }}>
            A short chat with an AI assistant turns what you&apos;re building into a focused goal. You&apos;ll need an
            access code only to request the run.
          </p>
          <div className={styles.inputRow}>
            <input
              id="assistant-url"
              type="text"
              inputMode="url"
              autoComplete="url"
              placeholder="https://docs.example.com/api"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className={styles.input}
              disabled={busy}
            />
          </div>
          <div className={styles.actions}>
            <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}>
              {busy ? "Starting…" : "Start"}
            </button>
          </div>
          {error && <p className="error-box small">{error}</p>}
        </form>
      )}

      {step === "chat" && interviewId && (
        <div>
          <p className={styles.label} style={{ overflowWrap: "anywhere" }}>
            {url.trim()}
          </p>
          <p className="muted small" style={{ marginTop: 0 }}>
            This conversation is kept for 14 days so I can review your request, then deleted. Please don&apos;t include
            confidential information (client names, internal systems, credentials).
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
        <form onSubmit={submit}>
          <p className={styles.label} style={{ overflowWrap: "anywhere" }}>
            {url.trim()}
          </p>
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
          <p className="muted small" style={{ margin: "0.3rem 0 0.8rem" }}>
            With a goal, only the pages and endpoints it needs are analyzed. The goal is published with the result, so please
            don&apos;t include confidential information (client names, internal systems, credentials).
          </p>
          <label htmlFor="request-code" className={styles.label}>
            Access code
          </label>
          <div className={styles.inputRow}>
            <input
              id="request-code"
              placeholder="scout-xxxxx-xxxxx-xxxxx-xxxxx"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={styles.input}
              disabled={busy}
            />
          </div>
          <p className="muted small" style={{ margin: "0.3rem 0 0" }}>
            Runs cost money, so they need a code. No code?{" "}
            <a href={AUTHOR.linkedin} target="_blank" rel="noreferrer noopener">
              Request a code
            </a>
          </p>
          <div className={styles.actions}>
            <button type="button" className="btn" onClick={startOver} disabled={busy}>
              Start over
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>
              {busy ? "Sending…" : "Request a run"}
            </button>
          </div>
          {error && <p className="error-box small">{error}</p>}
        </form>
      )}
    </section>
  );
}
