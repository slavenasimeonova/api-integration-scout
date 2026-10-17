import type { AgentOutput } from "../../src/core/schema.js";
import { RAW_SPEC } from "./fixtures.js";

export const PARCEL_GOAL = "Subscribe to tracking events for a parcel and receive them by webhook";
const doc = (quote: string) => ({ status: "documented" as const, sources: [{ url: RAW_SPEC, quote }] });
const notFound = { status: "not_found" as const, value: null, sources: [] };

/** What the agent might return after reading the Parcelpost spec (with some claims Scout must reject). */
export const PARCEL_OUTPUT: AgentOutput = {
  apiName: "Parcelpost Alerts",
  summary: "Pushes tracking events for subscribed parcels to your webhook.",
  baseUrl: { ...doc("https://api.parcelpost.example/api/alerts/{version}"), value: "https://api.parcelpost.example/api/alerts/{version}" },
  auth: {
    ...doc("tokenUrl: https://api.parcelpost.example/security/v1/oauth/token"),
    value: {
      type: "oauth2",
      location: "header",
      grantType: "client_credentials",
      tokenUrl: "https://api.parcelpost.example/security/v1/oauth/token",
      description: "OAuth 2.0 client credentials",
    },
  },
  authAlternatives: [],
  endpoints: [
    {
      ...doc("Create subscriptions by tracking number."),
      value: {
        method: "POST",
        path: "/subscription/{type}/package",
        purpose: "Create subscriptions by tracking number",
        keyParams: [{ name: "version", in: "path", required: true, description: "API version" }],
        // The spec's YAML example as JSON, keys in another order: every key and value is in the spec,
        // but not as one sequence, so it counts as converted.
        exampleBody: JSON.stringify({
          destination: { credentialType: "Bearer", credential: "secret", url: "https://example.com/hooks/parcel" },
          trackingNumberList: ["1PP0000000000001"],
        }),
        exampleBodyFrom: "verbatim", // claimed by the model; Scout must set this itself
      },
    },
    {
      ...doc("Parcelpost sends this POST to the destination URL for every new tracking event."),
      value: {
        method: "POST",
        path: "/subscriptions/{id}/pause",
        purpose: "Pause a subscription",
        keyParams: [],
        // A value the spec doesn't contain.
        exampleBody: JSON.stringify({ subscriptionId: "sub_123", reason: "holiday" }),
        exampleBodyFrom: "verbatim",
      },
    },
  ],
  pagination: notFound,
  rateLimits: notFound,
  webhooks: {
    ...doc("Parcelpost sends this POST to the destination URL for every new tracking event."),
    value: {
      supported: true,
      events: ["TrackingEvent"],
      description: "One POST per tracking event.",
      examplePayload: JSON.stringify({ trackingNumber: "1PP0000000000001", activityStatus: "Delivered" }),
      payloadFields: [
        { name: "trackingNumber", type: "string", description: "The parcel" },
        { name: "activityStatus", type: "string", description: "Latest status" },
      ],
    },
  },
  errorFormat: notFound,
  versioning: notFound,
  risks: [{ severity: "medium", title: "Subscriptions expire", detail: "Subscriptions last 14 days." }],
  openQuestions: ["How are webhook deliveries retried?"],
  environments: [
    { ...doc("url: https://sandbox.parcelpost.example/api/alerts/{version}"), value: { name: "Sandbox", url: "https://sandbox.parcelpost.example/api/alerts/{version}" } },
    { ...doc("url: https://api.parcelpost.example/api/alerts/{version}"), value: { name: "Production", url: "https://api.parcelpost.example/api/alerts/{version}" } },
    // Quote verifies, but this URL is nowhere on the page.
    { ...doc("description: Sandbox"), value: { name: "Staging", url: "https://staging.parcelpost.example/api" } },
  ],
  flow: [
    { ...doc("tokenUrl: https://api.parcelpost.example/security/v1/oauth/token"), value: { action: "Get an access token", direction: "app_to_api", endpoint: "POST /security/v1/oauth/token" } },
    { ...doc("Create subscriptions by tracking number."), value: { action: "Subscribe the parcel", direction: "app_to_api", endpoint: "post  /subscription/{type}/package" } },
    {
      status: "inferred",
      reasoning: "The webhook needs a quick 2xx.",
      sources: [{ url: RAW_SPEC }],
      value: { action: "Acknowledge each event", direction: "api_to_webhook" },
    },
  ],
  pagesConsidered: [{ url: RAW_SPEC, relevant: true, reason: "The Alerts spec." }],
};
