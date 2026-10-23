/**
 * Visitor-facing text for request and interview API errors. The panel shows
 * only these, never the API's own message: those are written for developers
 * ("Send JSON: { code, url }."), and an unknown error gets a generic line.
 * Error codes come from src/access/ (web/ can't import it).
 */

export type ApiErrorContext = "start" | "interview" | "request";

const MESSAGES: Record<string, string> = {
  invalid_code: "This access code isn't valid. Please check that you copied the whole code.",
  too_many_attempts: "Too many wrong codes from this network. Please try again in an hour.",
  paused: "Requests are paused right now. Please try again later.",
  invalid_url: "This URL can't be used. Please enter the address of a public API docs page.",
  invalid_goal: "Please keep the goal under 300 characters.",
  code_limit_day: "This code has used today's requests. Please try again tomorrow.",
  code_limit_total: "This code has used all its requests.",
  interview_limit_ip: "You've used today's goal assistant conversations. Please write the goal yourself.",
  interview_limit_global: "The goal assistant is busy today. Please write the goal yourself.",
  interview_idle: "This conversation timed out. Please write the goal yourself.",
  interview_finished: "This conversation is finished. Please edit the goal below.",
  interview_unavailable: "The goal assistant is unavailable. Please write the goal yourself.",
  assistant_unavailable: "The assistant didn't answer. Please try again, or write the goal yourself.",
  invalid_interview: "This conversation has expired, so it won't be attached. Your goal is kept; please send the request again.",
  message_too_long: "Please keep each answer under 500 characters.",
  empty_message: "Please type an answer.",
};

const FALLBACK: Record<ApiErrorContext, string> = {
  start: "Something went wrong while starting the goal assistant. Please try again in a few minutes.",
  interview: "The goal assistant ran into a problem. Please try again, or write the goal yourself.",
  request: "Something went wrong while sending your request. Please try again in a few minutes.",
};

export function friendlyError(error: unknown, context: ApiErrorContext): string {
  if (context === "interview" && error === "not_found") return "This conversation has expired. Please write the goal yourself.";
  return (typeof error === "string" && Object.hasOwn(MESSAGES, error) ? MESSAGES[error] : undefined) ?? FALLBACK[context];
}
