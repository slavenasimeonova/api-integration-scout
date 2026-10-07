import { Scout } from "@/components/Scout";

export default function Home() {
  return (
    <main className="page">
      <header style={{ marginBottom: "1.5rem" }}>
        <h1>API Integration Scout</h1>
        <p className="muted" style={{ maxWidth: "62ch", margin: 0 }}>
          An agent that reads public API docs and writes an integration analysis plus a Postman collection. Every finding is
          labeled <b>Documented</b> (with a quote checked against the page), <b>Inferred</b>, or <b>Not found in docs</b>.
        </p>
      </header>
      <Scout />
    </main>
  );
}
