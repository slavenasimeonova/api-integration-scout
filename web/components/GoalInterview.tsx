"use client";

import { useEffect, useRef, useState } from "react";
import { REQUEST_API } from "@/lib/site";
import styles from "./Scout.module.css";

export type Turn = { role: "assistant" | "visitor"; text: string };

/** Same limit as src/access/interview.ts (web/ can't import it). */
const MAX_MESSAGE_CHARS = 500;

type Props = {
  interviewId: string;
  turns: Turn[];
  questionsLeft: number;
  onTurns: (turns: Turn[], questionsLeft: number) => void;
  /** The conversation is over: a proposed goal ("" = the visitor writes it), and an optional notice. */
  onGoal: (goal: string, notice?: string) => void;
};

/**
 * The goal assistant's chat. Replies are shown as plain text (React escapes
 * them; no markdown, no links), so a model reply can't inject markup.
 */
export function GoalInterview({ interviewId, turns, questionsLeft, onTurns, onGoal }: Props) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const end = useRef<HTMLLIElement>(null);

  // A block body: newer browsers return a Promise from scrollIntoView, which React would call as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns.length]);

  async function send(finish: boolean) {
    const text = message.trim();
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`${REQUEST_API}/api/interview/${interviewId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(text ? { message: text } : {}), ...(finish ? { finish: true } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string; goal?: string; questionsLeft?: number; error?: string };
      if (res.ok && body.message) {
        const next: Turn[] = [...turns, ...(text ? [{ role: "visitor" as const, text }] : []), { role: "assistant", text: body.message }];
        setMessage("");
        onTurns(next, body.questionsLeft ?? 0);
        if (body.status === "goal") onGoal(body.goal ?? "");
      } else if (res.status === 502 || res.status === 400) {
        // Nothing was saved: the visitor can retry or shorten the answer.
        setError(body.message ?? `The assistant didn't answer (HTTP ${res.status}).`);
      } else {
        onGoal("", body.message ?? "The conversation ended. Please write the goal yourself.");
      }
    } catch {
      setError("Couldn't reach the goal assistant. Try again, or write the goal yourself.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ol className={styles.chat} aria-live="polite">
        {turns.map((t, i) => (
          <li key={i} className={t.role === "assistant" ? styles.bubbleAssistant : styles.bubbleVisitor}>
            <span className={styles.srOnly}>{t.role === "assistant" ? "Assistant: " : "You: "}</span>
            {t.text}
          </li>
        ))}
        <li ref={end} aria-hidden="true" />
      </ol>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(false);
        }}
      >
        <textarea
          aria-label="Your answer"
          placeholder="Your answer"
          maxLength={MAX_MESSAGE_CHARS}
          rows={2}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && message.trim() && !busy) {
              e.preventDefault();
              void send(false);
            }
          }}
          className={`${styles.input} ${styles.goal}`}
          disabled={busy}
        />
        <div className={styles.chatActions}>
          <span className="muted small">
            {busy ? "Thinking…" : questionsLeft > 0 ? `Up to ${questionsLeft} more question${questionsLeft === 1 ? "" : "s"}` : "Last answer"}
          </span>
          <span className={styles.chatButtons}>
            <button type="button" className="btn" disabled={busy} onClick={() => void send(true)}>
              Write the goal now
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !message.trim()}>
              Send
            </button>
          </span>
        </div>
        {error && (
          <p className="error-box small">
            {error}{" "}
            <button type="button" className={styles.linkButton} onClick={() => onGoal("")}>
              Write the goal myself
            </button>
          </p>
        )}
      </form>
    </div>
  );
}
