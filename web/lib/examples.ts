/** Precomputed runs served from public/examples (npm run build:examples). */
export const EXAMPLES = [
  {
    slug: "ipinfo",
    name: "IPinfo",
    url: "https://ipinfo.io/developers",
    highlight: "One token, three documented ways to send it",
  },
  {
    slug: "pushover",
    name: "Pushover",
    url: "https://pushover.net/api",
    highlight: "Credentials in the form body; a long page that gets truncated",
  },
  {
    slug: "postmark",
    name: "Postmark",
    url: "https://postmarkapp.com/developer/api/overview",
    highlight: "Custom auth header, webhooks, and a claim that failed verification",
  },
] as const;

export type ExampleSlug = (typeof EXAMPLES)[number]["slug"];
