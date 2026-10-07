import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "API Integration Scout",
  description:
    "Reads public API docs and writes an integration analysis where every finding is Documented (with a verified quote), Inferred, or Not found.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
