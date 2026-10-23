import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { KvStore } from "./store.js";

/**
 * Access codes: one per person, e.g. "recruiter-acme". The site never sees the
 * list; the server holds only SHA-256 hashes in the ACCESS_CODES secret:
 *
 *   ACCESS_CODES=recruiter-acme:3:10:<sha256>,friend-bob:1:3:<sha256>
 *
 * Fields: name, requests per day (UTC), requests in total, hash of the code.
 * Codes are random (about 100 bits), so a fast hash is enough; slow hashing
 * only matters for human-chosen passwords. Removing an entry revokes that code.
 */

export type AccessCode = { name: string; perDay: number; total: number; hash: string };

const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const HASH = /^[0-9a-f]{64}$/;
// No 0/O, 1/I/L: codes are typed by hand.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** A whole code inside longer text, e.g. the message it was sent in. */
const CODE_IN_TEXT = /(?<![a-z0-9])scout(?:-[a-z0-9]{4,6}){4}(?![a-z0-9])/g;

/**
 * Codes are compared case- and space-insensitively. Codes copied from a chat
 * app or a document can carry invisible characters, typographic dashes or the
 * text around them, so those are cleaned up and a single code in the text is
 * taken. Generated codes are plain ASCII, so their hashes are unaffected.
 */
export function normalizeCode(code: string): string {
  const cleaned = code.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\p{Pd}/gu, "-").toLowerCase();
  const found = cleaned.match(CODE_IN_TEXT);
  return found?.length === 1 ? found[0]! : cleaned.trim().replace(/\s+/g, "");
}

/** Longest code input accepted, so a code pasted with its message still works. */
export const MAX_CODE_INPUT = 1000;
/** Longest docs URL accepted. */
export const MAX_URL_CHARS = 2000;

export function hashCode(code: string): string {
  return createHash("sha256").update(normalizeCode(code)).digest("hex");
}

/** A new code like "scout-k7mq-2rtp-wv4e-9fxn": 20 random characters, about 100 bits. */
export function generateCode(): string {
  const groups = Array.from({ length: 4 }, () =>
    Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""),
  );
  return `scout-${groups.join("-")}`;
}

export function validateName(name: string): string {
  if (!NAME.test(name)) {
    throw new Error(`Code name "${name}" must be 2 to 40 characters: lowercase letters, digits and dashes`);
  }
  return name;
}

export function formatEntry(code: AccessCode): string {
  return `${code.name}:${code.perDay}:${code.total}:${code.hash}`;
}

/** Parses ACCESS_CODES. Throws on a malformed entry, so a typo can't silently disable a code. */
export function parseAccessCodes(raw: string | undefined): AccessCode[] {
  const codes: AccessCode[] = [];
  for (const entry of (raw ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    const [name = "", perDay = "", total = "", hash = "", ...rest] = entry.split(":");
    const label = `ACCESS_CODES entry "${name || entry.slice(0, 20)}"`;
    if (rest.length || !NAME.test(name) || !HASH.test(hash)) {
      throw new Error(`${label} must look like name:perDay:total:sha256`);
    }
    const day = Number(perDay);
    const all = Number(total);
    if (!Number.isInteger(day) || day < 1 || !Number.isInteger(all) || all < 1) {
      throw new Error(`${label}: perDay and total must be positive whole numbers`);
    }
    if (codes.some((c) => c.name === name)) throw new Error(`${label} appears twice`);
    codes.push({ name, perDay: day, total: all, hash });
  }
  return codes;
}

/** The entry for a typed code, or undefined. Compares every hash in constant time. */
export function findCode(codes: AccessCode[], input: string): AccessCode | undefined {
  const typed = Buffer.from(hashCode(input), "hex");
  let found: AccessCode | undefined;
  for (const code of codes) {
    if (timingSafeEqual(typed, Buffer.from(code.hash, "hex"))) found = code;
  }
  return found;
}

/** A salted hash of the client IP for counter keys, so raw IPs are never stored. */
export function hashIp(salt: string, ip: string | undefined): string {
  return createHash("sha256").update(`${salt}:${ip ?? "unknown"}`).digest("hex").slice(0, 32);
}

/** Wrong codes allowed per IP per hour before the IP is throttled. */
export const MAX_BAD_CODES_PER_HOUR = 10;

export type CodeCheck = { code: AccessCode } | { status: number; error: string; message: string };

/**
 * Checks a typed access code. Wrong codes are counted per hashed IP per hour,
 * and an IP over the limit is refused before the code is even looked at.
 * Shared by the request and interview APIs, so both count toward one limit.
 */
export async function checkAccessCode(
  deps: { store: KvStore; codes: AccessCode[]; clientIp?: string; ipSalt: string },
  input: string,
  at: Date,
): Promise<CodeCheck> {
  const hour = at.toISOString().slice(0, 13);
  const ipHash = hashIp(deps.ipSalt, deps.clientIp);
  const throttleKey = `throttle/${hour}/${ipHash}`;
  const badCodes = (await deps.store.getJSON<{ count: number }>(throttleKey))?.count ?? 0;
  if (badCodes >= MAX_BAD_CODES_PER_HOUR) {
    return { status: 429, error: "too_many_attempts", message: "Too many wrong codes from this network. Try again in an hour." };
  }
  const code = findCode(deps.codes, input);
  if (!code) {
    await deps.store.setJSON(throttleKey, { count: badCodes + 1 });
    return { status: 401, error: "invalid_code", message: "This access code isn't valid." };
  }
  return { code };
}
