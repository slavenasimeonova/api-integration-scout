import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { RequestResult } from "@/components/RequestResult";

export const metadata: Metadata = { title: "Your requested run · API Integration Scout", robots: { index: false } };

export default function ResultsPage() {
  return (
    <main className="page">
      <p className="small">
        <Link href="/">← API Integration Scout</Link>
      </p>
      <h1 style={{ fontSize: "1.3rem" }}>Your requested run</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <RequestResult />
      </Suspense>
    </main>
  );
}
