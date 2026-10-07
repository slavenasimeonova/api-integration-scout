import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlockedUrlError, checkUrl, checkUrlShape, createSafeFetcher, isBlockedAddress } from "../worker/safe-fetch.js";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.1.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00:ec2::254",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "34.117.59.81", "2606:4700:4700::1111"])("allows public %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("checkUrlShape", () => {
  it.each([
    ["file:///etc/passwd", /Only http and https/],
    ["ftp://docs.example.com/", /Only http and https/],
    ["https://user:pw@docs.example.com/", /credentials/],
    ["http://docs.example.com:8080/", /Port 8080/],
    ["http://localhost/", /not allowed/],
    ["http://metadata.google.internal/", /not allowed/],
    ["http://printer.local/", /not allowed/],
    ["http://intranet/", /not a public name/],
  ])("rejects %s", (url, message) => {
    expect(() => checkUrlShape(url)).toThrow(message);
  });

  it("accepts public http(s) URLs on default ports", () => {
    expect(checkUrlShape("https://docs.stripe.com/api").hostname).toBe("docs.stripe.com");
    expect(checkUrlShape("http://example.com:80/").hostname).toBe("example.com");
  });
});

describe("checkUrl", () => {
  const resolve = (map: Record<string, string[]>) => async (host: string) =>
    (map[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it("rejects names that resolve to private addresses", async () => {
    await expect(checkUrl("https://docs.evil.example/", { resolve: resolve({ "docs.evil.example": ["10.0.0.5"] }) })).rejects.toThrow(
      /non-public address \(10\.0\.0\.5\)/,
    );
  });

  it("rejects a name if any of its addresses is private", async () => {
    const r = resolve({ "mixed.example": ["93.184.215.14", "127.0.0.1"] });
    await expect(checkUrl("https://mixed.example/", { resolve: r })).rejects.toThrow(BlockedUrlError);
  });

  it("rejects IP literals, including disguised ones", async () => {
    await expect(checkUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/non-public/);
    // WHATWG URL parsing turns 2130706433 into 127.0.0.1.
    await expect(checkUrl("http://2130706433/")).rejects.toThrow(/non-public/);
    await expect(checkUrl("http://[::1]/")).rejects.toThrow(/non-public/);
  });

  it("rejects names that don't resolve", async () => {
    await expect(checkUrl("https://nowhere.example/", { resolve: resolve({}) })).rejects.toThrow(/Could not resolve/);
  });

  it("accepts public addresses", async () => {
    await expect(checkUrl("https://docs.example.com/", { resolve: resolve({ "docs.example.com": ["93.184.215.14"] }) })).resolves.toHaveLength(1);
  });
});

describe("createSafeFetcher (against a local server)", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const redirect = (to: string) => {
        res.writeHead(302, { Location: to });
        res.end();
      };
      switch (req.url) {
        case "/ok":
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<h1>Docs</h1><p>host=${req.headers.host}</p>`);
          return;
        case "/gzip":
          res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
          res.end(gzipSync("<h1>Compressed docs</h1>"));
          return;
        case "/redirect-ok":
          return redirect("/ok");
        case "/redirect-metadata":
          return redirect(`http://metadata.test:${port}/latest/meta-data/`);
        case "/redirect-port":
          return redirect("http://docs.test:6379/");
        case "/loop":
          return redirect("/loop");
        default:
          res.writeHead(404);
          res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // docs.test is the local server; metadata.test stands in for the cloud metadata host.
  const fetcher = () =>
    createSafeFetcher({
      timeoutMs: 2000,
      allowedPorts: [80, 443, port],
      resolve: async (host) =>
        host === "docs.test" ? [{ address: "127.0.0.1", family: 4 }]
        : host === "metadata.test" ? [{ address: "169.254.169.254", family: 4 }]
        : [],
      isBlocked: (ip) => ip !== "127.0.0.1" && isBlockedAddress(ip),
    });
  const base = () => `http://docs.test:${port}`;

  it("fetches a page through the pinned address and keeps the Host header", async () => {
    const res = await fetcher()(`${base()}/ok`);
    expect(res).toMatchObject({ status: 200, finalUrl: `${base()}/ok`, contentType: "text/html" });
    expect(res.body).toContain(`host=docs.test:${port}`);
  });

  it("decompresses gzip bodies", async () => {
    expect((await fetcher()(`${base()}/gzip`)).body).toContain("Compressed docs");
  });

  it("follows a safe redirect and reports the final URL", async () => {
    expect((await fetcher()(`${base()}/redirect-ok`)).finalUrl).toBe(`${base()}/ok`);
  });

  it("re-checks redirect targets: metadata address", async () => {
    await expect(fetcher()(`${base()}/redirect-metadata`)).rejects.toThrow(/non-public address \(169\.254\.169\.254\)/);
  });

  it("re-checks redirect targets: non-standard port", async () => {
    await expect(fetcher()(`${base()}/redirect-port`)).rejects.toThrow(/Port 6379/);
  });

  it("stops redirect loops", async () => {
    await expect(fetcher()(`${base()}/loop`)).rejects.toThrow(/Too many redirects/);
  });

  it("with default settings, refuses the local server outright", async () => {
    const strict = createSafeFetcher({ timeoutMs: 2000 });
    await expect(strict(`http://127.0.0.1:${port}/ok`)).rejects.toThrow(BlockedUrlError);
  });
});
