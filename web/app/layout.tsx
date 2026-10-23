import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

// Self-hosted at build time by next/font; no request to Google from the browser.
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sans" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono" });

const TITLE = "API Integration Scout";
const DESCRIPTION =
  "An agent that reads public API docs and writes an integration analysis where every finding is Documented (with a verified quote), Inferred, or Not found. Built by Slavena Simeonova.";
// Link previews (LinkedIn, Slack, X): crawlers need absolute URLs. Image source: web/og/card.html.
const PREVIEW = { url: `${SITE_URL}/og.png`, width: 1200, height: 630, alt: "Read the API docs. Keep fact and guess apart. Documented, Inferred, Not found in docs." };

export const metadata: Metadata = {
  metadataBase: new URL(`${SITE_URL}/`),
  title: TITLE,
  description: DESCRIPTION,
  authors: [{ name: "Slavena Simeonova", url: "https://www.linkedin.com/in/slavena-simeonova-a39868233/" }],
  openGraph: { type: "website", url: `${SITE_URL}/`, siteName: TITLE, title: TITLE, description: DESCRIPTION, images: [PREVIEW] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [PREVIEW] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
