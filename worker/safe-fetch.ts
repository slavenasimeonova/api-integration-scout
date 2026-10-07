import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Fetcher } from "../src/core/index.js";

/**
 * SSRF-safe Fetcher for the public web app. fetch_page fetches URLs chosen by
 * the model from user-supplied docs, so every hop is checked:
 * - http(s) only, default ports only, no credentials in the URL
 * - DNS is resolved first and every address must be public; the connection is
 *   pinned to the checked address, so DNS rebinding can't swap it afterwards
 * - redirects are followed by hand and each target is checked again
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

// Separate lists: a BlockList applies IPv4-mapped IPv6 rules (::ffff:0:0/96)
// to plain IPv4 addresses too, which would block every IPv4 address.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  blockedV4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::ffff:0:0", 96], // IPv4-mapped: could hide a private IPv4 address
  ["64:ff9b::", 96], // NAT64: same
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: embeds an IPv4 address
  ["fc00::", 7], // unique local (includes AWS fd00:ec2::254)
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blockedV6.addSubnet(net, prefix, "ipv6");
}

/** True for loopback, private, link-local, metadata and other non-public addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, "ipv4");
  if (family === 6) return blockedV6.check(address, "ipv6");
  return true; // not an IP address at all
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type ResolvedAddress = { address: string; family: number };

export type SafeFetchOptions = {
  timeoutMs: number;
  /** DNS resolver; tests inject one. Defaults to the system resolver. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Address check; tests relax it to reach a local server. */
  isBlocked?: (address: string) => boolean;
  /** Ports allowed when written explicitly in a URL. Default ports are always allowed. */
  allowedPorts?: number[];
};

const systemResolve = (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true });

/** Checks a URL's shape (scheme, port, credentials, host name). Throws BlockedUrlError. */
export function checkUrlShape(raw: string, allowedPorts: number[] = [80, 443]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Only http and https URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) throw new BlockedUrlError("URLs with credentials are not allowed");
  if (url.port && !allowedPorts.includes(Number(url.port))) {
    throw new BlockedUrlError(`Port ${url.port} is not allowed`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedUrlError(`Host ${host} is not allowed`);
  }
  if (!isIP(host) && !host.includes(".")) throw new BlockedUrlError(`Host ${host} is not a public name`);
  return url;
}

/**
 * Full check of a URL, including DNS: every address the name resolves to must
 * be public. Returns the addresses that were checked.
 */
export async function checkUrl(raw: string, opts: Omit<SafeFetchOptions, "timeoutMs"> = {}): Promise<ResolvedAddress[]> {
  const url = checkUrlShape(raw, opts.allowedPorts);
  const isBlocked = opts.isBlocked ?? isBlockedAddress;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  let addresses: ResolvedAddress[];
  if (literal) {
    addresses = [{ address: host, family: literal }];
  } else {
    try {
      addresses = await (opts.resolve ?? systemResolve)(host);
    } catch {
      throw new BlockedUrlError(`Could not resolve ${host}`);
    }
  }
  if (addresses.length === 0) throw new BlockedUrlError(`Could not resolve ${host}`);
  const bad = addresses.find((a) => isBlocked(a.address));
  if (bad) throw new BlockedUrlError(`${host} resolves to a non-public address (${bad.address})`);
  return addresses;
}

/** A lookup that only ever returns the addresses checkUrl already approved. */
function pinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
}

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(url: URL, addresses: ResolvedAddress[], timeoutMs: number): Promise<RawResponse> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        lookup: pinnedLookup(addresses),
        timeout: timeoutMs,
        headers: {
          "User-Agent": "api-integration-scout/1.0 (+docs analysis)",
          Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Redirect bodies are not needed; the caller checks Location.
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, headers: res.headers, body: "" });
          return;
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          encoding === "gzip" ? res.pipe(createGunzip())
          : encoding === "deflate" ? res.pipe(createInflate())
          : encoding === "br" ? res.pipe(createBrotliDecompress())
          : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error(`Response too large (over ${MAX_BODY_BYTES} bytes)`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        stream.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

export function createSafeFetcher(opts: SafeFetchOptions): Fetcher {
  return async (start) => {
    let current = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const addresses = await checkUrl(current, opts);
      const res = await request(new URL(current), addresses, opts.timeoutMs);
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return {
        finalUrl: current,
        status: res.status,
        contentType: String(res.headers["content-type"] ?? ""),
        body: res.body,
      };
    }
    throw new BlockedUrlError(`Too many redirects (more than ${MAX_REDIRECTS})`);
  };
}
