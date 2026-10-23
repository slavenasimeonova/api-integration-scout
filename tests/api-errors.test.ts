import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { friendlyError } from "../web/lib/api-errors.js";

const accessDir = path.join(import.meta.dirname, "..", "src", "access");
/** Every error code the request and interview APIs (and the shared code check) can send. */
const apiErrorCodes = [
  ...new Set(
    readdirSync(accessDir)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => [...readFileSync(path.join(accessDir, f), "utf8").matchAll(/(?:fail\(\d+, |error: )"([a-z_]+)"/g)].map((m) => m[1]!)),
  ),
];

describe("friendlyError", () => {
  it("never shows the API's developer message", () => {
    expect(friendlyError("invalid_body", "start")).toBe("Something went wrong while starting the goal assistant. Please try again in a few minutes.");
    expect(friendlyError(undefined, "request")).toBe("Something went wrong while sending your request. Please try again in a few minutes.");
    expect(friendlyError("toString", "interview")).toBe("The goal assistant ran into a problem. Please try again, or write the goal yourself.");
  });

  it("has visitor text for every error a visitor can cause", () => {
    expect(apiErrorCodes.length).toBeGreaterThan(15);
    // invalid_body is a client bug and not_found only means something for a conversation; both get a general line.
    const generic = new Set(["Something went wrong while starting the goal assistant. Please try again in a few minutes."]);
    for (const code of apiErrorCodes.filter((c) => c !== "invalid_body" && c !== "not_found")) {
      expect(generic.has(friendlyError(code, "start")), code).toBe(false);
    }
    expect(friendlyError("not_found", "interview")).toBe("This conversation has expired. Please write the goal yourself.");
  });

  it("explains a wrong code without echoing anything from the API", () => {
    expect(friendlyError("invalid_code", "start")).toBe("This access code isn't valid. Please check that you copied the whole code.");
  });
});
