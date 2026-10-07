import Link from "next/link";
import styles from "./SiteChrome.module.css";

export const AUTHOR = {
  name: "Slavena Simeonova",
  role: "Integration architect, 7 years in enterprise telecom",
  github: "https://github.com/slavenasimeonova/api-integration-scout",
  linkedin: "https://www.linkedin.com/in/slavenasimeonova",
};

function Mark() {
  // A magnifier over a document: reading the docs closely.
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" className={styles.mark}>
      <rect x="3" y="2.5" width="12" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6 7h6M6 10h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="15.5" cy="15" r="4" fill="var(--surface)" stroke="currentColor" strokeWidth="1.6" />
      <path d="M18.4 17.9 21 20.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand}>
          <Mark />
          <span>API Integration Scout</span>
        </Link>
        <nav className={styles.nav} aria-label="Author links">
          <span className={styles.byline}>by {AUTHOR.name}</span>
          <a href={AUTHOR.github} target="_blank" rel="noreferrer noopener">
            GitHub
          </a>
          <a href={AUTHOR.linkedin} target="_blank" rel="noreferrer noopener">
            LinkedIn
          </a>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <p>
          Built by <strong>{AUTHOR.name}</strong>, {AUTHOR.role.charAt(0).toLowerCase() + AUTHOR.role.slice(1)}. TypeScript, Claude Agent SDK, Next.js.
        </p>
        <p>
          <a href={AUTHOR.github} target="_blank" rel="noreferrer noopener">
            Source on GitHub
          </a>
          {" · "}
          <a href={AUTHOR.linkedin} target="_blank" rel="noreferrer noopener">
            linkedin.com/in/slavenasimeonova
          </a>
        </p>
      </div>
    </footer>
  );
}
