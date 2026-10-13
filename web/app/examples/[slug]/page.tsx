import Link from "next/link";
import { notFound } from "next/navigation";
import { RunReplay } from "@/components/RunReplay";
import { EXAMPLES } from "@/lib/examples";
import { assetUrl } from "@/lib/site";

export function generateStaticParams() {
  return EXAMPLES.map((ex) => ({ slug: ex.slug }));
}

export const dynamicParams = false;

export default async function ExamplePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const example = EXAMPLES.find((ex) => ex.slug === slug);
  if (!example) notFound();

  return (
    <main className="page">
      <p className="small">
        <Link href="/">← API Integration Scout</Link>
      </p>
      <h1 style={{ fontSize: "1.3rem" }}>Example: {example.name}</h1>
      <p className="muted small" style={{ marginTop: 0 }}>
        A saved run against {example.url}, replayed from its recorded progress events. No API call is made.
      </p>
      <RunReplay src={assetUrl(`/examples/${example.slug}.json`)} />
    </main>
  );
}
