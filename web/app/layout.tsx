import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import "./globals.css";

// Self-hosted at build time by next/font; no request to Google from the browser.
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sans" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "API Integration Scout",
  description:
    "An agent that reads public API docs and writes an integration analysis where every finding is Documented (with a verified quote), Inferred, or Not found. Built by Slavena Simeonova.",
  authors: [{ name: "Slavena Simeonova", url: "https://www.linkedin.com/in/slavenasimeonova" }],
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
