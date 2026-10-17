/**
 * Goal validation, kept free of dependencies so the request-mode Netlify
 * Function can use it without bundling the agent core.
 */

export const MAX_GOAL_CHARS = 300;

/** Checks and normalizes a goal: plain text, one line, at most MAX_GOAL_CHARS. Returns undefined for an empty goal. */
export function normalizeGoal(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const goal = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!goal) return undefined;
  if (goal.length > MAX_GOAL_CHARS) throw new Error(`The goal is ${goal.length} characters; the limit is ${MAX_GOAL_CHARS}.`);
  return goal;
}
