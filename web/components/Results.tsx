"use client";

import { formatSeconds, formatTokens, formatUsd, runFigures } from "@/lib/figures";
import { glanceRows, safeHref, shortPath, STATUS_LABEL } from "@/lib/format";
import type { Finding, FindingStatus, Risk, RunResult } from "@/lib/types";
import { Downloads } from "./Downloads";
import { MermaidDiagram } from "./MermaidDiagram";
import styles from "./Results.module.css";

const SEVERITY_ORDER: Record<Risk["severity"], number> = { high: 0, medium: 1, low: 2 };

export function Results({ result }: { result: RunResult }) {
  const a = result.analysis;
  const fig = runFigures(a);
  const auths = [{ primary: true, f: a.auth }, ...a.authAlternatives.map((f) => ({ primary: false, f }))].filter((x) => x.f.value);
  const endpoints = a.endpoints.filter((e) => e.value);
  const risks = [...a.risks].sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);
  const docsHref = safeHref(a.docsUrl);

  return (
    <div className={styles.results}>
      <header className={styles.header}>
        <div>
          <h1>{a.apiName}</h1>
          <p className={styles.summary}>{a.summary}</p>
          <p className="muted small">
            From {docsHref ? <a href={docsHref} target="_blank" rel="noreferrer noopener">{a.docsUrl}</a> : a.docsUrl} · {a.run.model}
            <br />
            {fig.pagesRead} {fig.pagesRead === 1 ? "page" : "pages"} read · {formatSeconds(fig.durationMs)} · {formatTokens(fig.totalTokens)} tokens (
            {formatTokens(fig.budgetedTokens)} budgeted + {formatTokens(fig.cacheReadTokens)} cache reads) · {formatUsd(fig.costUsd)}
          </p>
        </div>
        <Downloads slug={result.slug} files={result.files} postmanErrors={result.postmanErrors} />
      </header>

      <Legend />

      <h2>At a glance</h2>
      <div className={`card table-wrap ${styles.flush}`}>
        <table>
          <thead>
            <tr>
              <th>Area</th>
              <th>Finding</th>
              <th>Status</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {glanceRows(a).map((row) => (
              <tr key={row.area}>
                <td className={styles.area}>{row.area}</td>
                <td>{row.finding.status === "not_found" ? <span className="muted">-</span> : row.text}</td>
                <td>
                  <StatusBadge status={row.finding.status} />
                </td>
                <td>
                  <Evidence finding={row.finding} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Authentication methods</h2>
      <p className="muted small">
        Every method the docs state. The Postman collection uses the first documented one; the others get a sample request in the
        &ldquo;Auth alternatives&rdquo; folder.
      </p>
      <div className={`card table-wrap ${styles.flush}`}>
        {auths.length ? (
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>Type</th>
                <th>Sent in</th>
                <th>Parameter</th>
                <th>Status</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {auths.map(({ primary, f }, i) => (
                <tr key={i}>
                  <td>
                    {f.value!.description}
                    {primary && <span className={styles.primary}>primary</span>}
                  </td>
                  <td>
                    <code>{f.value!.type}</code>
                  </td>
                  <td>{f.value!.location ?? "-"}</td>
                  <td>{f.value!.parameterName ? <code>{f.value!.parameterName}</code> : "-"}</td>
                  <td>
                    <StatusBadge status={f.status} />
                  </td>
                  <td>
                    <Evidence finding={f} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={styles.pad}>
            <StatusBadge status="not_found" /> No authentication method found in the pages read.
          </p>
        )}
      </div>

      <h2>Endpoints</h2>
      <div className={`card table-wrap ${styles.flush}`}>
        {endpoints.length ? (
          <table>
            <thead>
              <tr>
                <th>Request</th>
                <th>Purpose</th>
                <th>Status</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((e, i) => (
                <tr key={i}>
                  <td className={styles.request}>
                    <code>
                      <b>{e.value!.method}</b> {e.value!.path}
                    </code>
                    {e.hostCheck?.status === "corrected" && <div className={styles.flag}>Host taken from the docs&rsquo; example URL</div>}
                    {e.hostCheck?.status === "ambiguous" && (
                      <div className={styles.flag}>Host unclear: {e.hostCheck.candidates.join(", ")}</div>
                    )}
                  </td>
                  <td>
                    {e.value!.purpose}
                    {e.value!.keyParams.length > 0 && (
                      <div className="muted small">
                        {e.value!.keyParams.map((p) => `${p.name} (${p.in}${p.required ? ", required" : ""})`).join(", ")}
                      </div>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={e.status} />
                  </td>
                  <td>
                    <Evidence finding={e} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={styles.pad}>No endpoints found in the pages read.</p>
        )}
      </div>

      <div className={styles.columns}>
        <section>
          <h2>Risks</h2>
          {risks.length ? (
            <ul className={styles.risks}>
              {risks.map((risk, i) => (
                <li key={i} className="card">
                  <span className={styles.severity} data-severity={risk.severity}>
                    {risk.severity}
                  </span>
                  <strong>{risk.title}</strong>
                  <p>{risk.detail}</p>
                  {risk.origin !== "agent" && <p className="muted small">Raised by the {risk.origin} check, not the model.</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No risks identified.</p>
          )}
        </section>
        <section>
          <h2>Open questions</h2>
          {a.openQuestions.length ? (
            <ul className={styles.questions}>
              {a.openQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">None.</p>
          )}
          {a.warnings.length > 0 && (
            <>
              <h2>Warnings</h2>
              <ul className={styles.questions}>
                {a.warnings.map((w, i) => (
                  <li key={i} className="small">
                    {w}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <h2>Integration flow</h2>
      <MermaidDiagram code={result.files["sequence.mmd"] ?? ""} />
    </div>
  );
}

export function StatusBadge({ status }: { status: FindingStatus }) {
  return (
    <span className={styles.badge} data-status={status}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Legend() {
  return (
    <div className={styles.legend}>
      <span>
        <StatusBadge status="documented" /> stated in the docs; the quote was checked against the fetched page
      </span>
      <span>
        <StatusBadge status="inferred" /> the agent&rsquo;s reasoning, not a fact
      </span>
      <span>
        <StatusBadge status="not_found" /> not covered by the pages read
      </span>
    </div>
  );
}

/** Source quotes (verified for documented findings) and the agent's reasoning. */
function Evidence({ finding }: { finding: Finding<unknown> }) {
  const quoted = finding.sources.filter((s) => s.quote);
  if (!finding.sources.length && !finding.reasoning) return <span className="muted">-</span>;
  return (
    <details className={styles.evidence}>
      <summary>
        {quoted.length ? `${quoted.length} quote${quoted.length > 1 ? "s" : ""}` : finding.reasoning ? "Reasoning" : "Source"}
      </summary>
      {finding.sources.map((s, i) => {
        const href = safeHref(s.url);
        return (
          <div key={i}>
            {s.quote && <blockquote>&ldquo;{s.quote}&rdquo;</blockquote>}
            <div className="small">
              {href ? (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {shortPath(s.url)}
                </a>
              ) : (
                s.url
              )}
            </div>
          </div>
        );
      })}
      {finding.reasoning && (
        <p className="small">
          <em>Reasoning:</em> {finding.reasoning}
        </p>
      )}
    </details>
  );
}

