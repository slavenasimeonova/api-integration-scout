import { StatusBadge } from "@/components/Results";
import { Scout } from "@/components/Scout";
import styles from "./home.module.css";

// Real findings from the IPinfo example run (see /examples/ipinfo).
const SAMPLE = [
  {
    area: "Authentication",
    status: "documented" as const,
    finding: "Bearer token in the Authorization header",
    evidence: "“A Bearer token in the Authorization header (Authorization: Bearer $TOKEN)”",
    note: "quote found on ipinfo.io/developers",
  },
  {
    area: "Versioning",
    status: "inferred" as const,
    finding: "No version number; a legacy API is still maintained",
    evidence: "Docs contrast an updated schema with a legacy one but give no versioning or deprecation policy.",
    note: "the agent’s reasoning",
  },
  {
    area: "Pagination",
    status: "not_found" as const,
    finding: "Not covered by the pages read",
    evidence: "Reported as missing instead of guessed.",
    note: "",
  },
];

const STEPS = [
  { title: "Reads the docs", text: "Fetches up to 15 pages on the same site and keeps the raw text." },
  { title: "Labels every finding", text: "Auth, endpoints, pagination, rate limits, webhooks, errors, versioning." },
  { title: "Verifies in code", text: "Each “documented” quote must appear on the cited page, or it is downgraded." },
  { title: "Hands you a start", text: "Postman collection and environment, a sequence diagram, and the risks." },
];

export default function Home() {
  return (
    <main className="page">
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>AI agent for API integration work</p>
          <h1 className={styles.title}>
            Read the API docs.
            <br />
            Keep fact and guess apart.
          </h1>
          <p className={styles.lede}>
            Paste a link to public API docs. The agent reads them and writes an integration analysis plus a Postman collection.
            Every finding is labeled <b>Documented</b>, <b>Inferred</b> or <b>Not found in docs</b>, and documented quotes are
            checked against the page they came from.
          </p>
        </div>

        <figure className={`card ${styles.sample}`} aria-label="Sample findings from the IPinfo example">
          <figcaption className={styles.sampleHead}>
            <span>ipinfo.io/developers</span>
            <span>sample findings</span>
          </figcaption>
          {SAMPLE.map((row) => (
            <div key={row.area} className={styles.sampleRow}>
              <div className={styles.sampleTop}>
                <span className={styles.sampleArea}>{row.area}</span>
                <StatusBadge status={row.status} />
              </div>
              <div className={styles.sampleFinding}>{row.finding}</div>
              <div className={styles.sampleEvidence} data-status={row.status}>
                {row.evidence}
                {row.note && <span className={styles.sampleNote}> {row.note}</span>}
              </div>
            </div>
          ))}
        </figure>
      </section>

      <Scout />

      <section className={styles.steps} aria-label="How it works">
        {STEPS.map((step, i) => (
          <div key={step.title} className={styles.step}>
            <span className={styles.stepNo}>{String(i + 1).padStart(2, "0")}</span>
            <strong>{step.title}</strong>
            <span className="muted small">{step.text}</span>
          </div>
        ))}
      </section>
    </main>
  );
}
