import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatOutline, specOutline } from "../src/core/spec-outline.js";

const spec = (file: string) => readFileSync(new URL(`./fixtures/specs/${file}`, import.meta.url), "utf8");

describe("specOutline (YAML)", () => {
  const text = spec("parcelpost-alerts.yaml");
  const items = specOutline(text)!;

  it("lists servers, operations with summaries, security schemes and schemas", () => {
    expect(items.map((i) => `${i.section}: ${i.label}`)).toEqual([
      "server: https://sandbox.parcelpost.example/api/alerts/{version}",
      "server: https://api.parcelpost.example/api/alerts/{version}",
      "path: POST /subscription/{type}/package: Create subscriptions by tracking number.",
      // Some real specs put the webhook (wrongly) under paths; it is still listed.
      "path: POST TrackingEvent: Tracking Event",
      "security: oauth2",
      "schema: SubscriptionRequest",
      "schema: TrackingEventPayload",
    ]);
  });

  it("records where each item is, so the agent can pick the right part", () => {
    for (const item of items) {
      const word = item.section === "server" ? "url:" : item.section === "path" ? "post:" : `${item.label}:`;
      expect(text.slice(item.offset)).toMatch(new RegExp(`^\\s*-?\\s*${word.replace(/[{}.]/g, "\\$&")}`));
    }
    const paths = items.find((i) => i.section === "path")!;
    expect(paths.offset).toBeGreaterThan(text.indexOf("Business rule 30"));
  });

  it("formats the outline with part numbers", () => {
    const out = formatOutline(items, (offset) => (offset < 4000 ? 1 : 2));
    expect(out).toContain("Servers:\n- https://sandbox.parcelpost.example/api/alerts/{version} (part 1)");
    expect(out).toContain("- POST TrackingEvent: Tracking Event (part 2)");
    expect(out).toContain("Schemas (2): SubscriptionRequest (part 2), TrackingEventPayload (part 2)");
  });

  it("ignores documents that aren't API specs", () => {
    expect(specOutline("title: Release notes\npaths:\n  /a:\n    get:\n")).toBeNull();
    expect(specOutline("# Parcelpost\nSome markdown.")).toBeNull();
    expect(specOutline('{"name": "package.json"}')).toBeNull();
  });

  it("caps long schema lists", () => {
    const many = Array.from({ length: 90 }, (_, i) => ({ section: "schema" as const, label: `S${i}`, offset: i }));
    expect(formatOutline(many, () => 1)).toMatch(/Schemas \(90\): S0 \(part 1\), .*S79 \(part 1\), and 10 more$/);
  });
});

describe("specOutline (JSON)", () => {
  it("lists the same sections from a JSON spec, in document order", () => {
    const text = spec("parcelpost-alerts.json");
    const items = specOutline(text)!;
    expect(items.map((i) => `${i.section}: ${i.label}`)).toEqual([
      "server: https://sandbox.parcelpost.example/v2",
      "server: https://api.parcelpost.example/v2",
      "path: GET /subscriptions: List subscriptions",
      "path: POST /subscriptions: Create a subscription",
      "webhook: POST trackingEvent: Tracking event",
      "security: oauth2",
      "schema: Subscription",
      "schema: TrackingEvent",
    ]);
    const offsets = items.map((i) => i.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(text.slice(items[3]!.offset)).toMatch(/^"post"/);
  });
});
