"use client";

import { useEffect, useId, useRef, useState } from "react";

/** Renders the sequence diagram. Mermaid is loaded only when a result is shown. */
export function MermaidDiagram({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        // strict: labels come from model output, so no HTML or click handlers.
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, id]);

  return (
    <div className="card">
      {failed ? <p className="muted small">The diagram couldn&rsquo;t be rendered; the source is below.</p> : <div ref={ref} style={{ overflowX: "auto" }} />}
      <details>
        <summary>Mermaid source</summary>
        <pre style={{ overflowX: "auto" }}>{code}</pre>
      </details>
    </div>
  );
}
