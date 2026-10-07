"use client";

import styles from "./Downloads.module.css";

const DOWNLOADS: { file: string; label: string; primary?: boolean }[] = [
  { file: "postman_collection.json", label: "Postman collection", primary: true },
  { file: "postman_environment.json", label: "Postman environment", primary: true },
  { file: "analysis.md", label: "analysis.md" },
  { file: "analysis.json", label: "analysis.json" },
  { file: "sequence.mmd", label: "sequence.mmd" },
];

function download(name: string, content: string) {
  const type = name.endsWith(".json") ? "application/json" : "text/plain";
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Downloads({ slug, files, postmanErrors }: { slug: string; files: Record<string, string>; postmanErrors: string[] }) {
  return (
    <div className={styles.downloads}>
      <div className={styles.row}>
        {DOWNLOADS.filter((d) => files[d.file] !== undefined).map((d) => (
          <button
            key={d.file}
            type="button"
            className={d.primary ? "btn btn-primary" : "btn"}
            onClick={() => download(`${slug}.${d.file}`, files[d.file]!)}
          >
            ↓ {d.label}
          </button>
        ))}
      </div>
      {files["postman_collection.json"] === undefined && (
        <p className="error-box small">The Postman collection failed schema validation and wasn&rsquo;t generated: {postmanErrors.join("; ")}</p>
      )}
      <p className="muted small">Import both Postman files, select the environment, and paste your key into apiKey.</p>
    </div>
  );
}
