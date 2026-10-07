// Minimal types for the part of newman's API used here (newman ships no types).
declare module "newman" {
  export type NewmanRunOptions = {
    collection: object;
    environment?: object;
    envVar?: { key: string; value: string }[];
    delayRequest?: number;
    timeoutRequest?: number;
    reporters?: string[];
  };

  export type NewmanAssertion = { assertion: string; skipped?: boolean; error?: { message?: string } };

  export type NewmanExecution = {
    item: { name: string };
    request?: { method?: string };
    response?: { code: number; responseTime: number };
    requestError?: { message?: string };
    assertions?: NewmanAssertion[];
  };

  export type NewmanRunSummary = { run: { executions: NewmanExecution[] } };

  export function run(options: NewmanRunOptions, callback: (err: Error | null, summary: NewmanRunSummary) => void): unknown;

  const newman: { run: typeof run };
  export default newman;
}
