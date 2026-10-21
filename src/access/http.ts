/** JSON responses with CORS for the allowed browser origins; shared by the request and interview APIs. */
export function jsonResponder(req: Request, allowedOrigins: string[]) {
  const origin = req.headers.get("origin");
  const cors: Record<string, string> =
    origin && allowedOrigins.includes(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" }
      : {};
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });
  return {
    json,
    fail: (status: number, error: string, message: string) => json(status, { error, message }),
    preflight: () => new Response(null, { status: 204, headers: { ...cors, "access-control-max-age": "600" } }),
  };
}

/** For logs when a body is rejected: its content type and each field's type and length, never the content. */
export function describeBody(req: Request, body: unknown): string {
  const shape =
    body === undefined
      ? "not JSON"
      : body && typeof body === "object" && !Array.isArray(body)
        ? Object.entries(body).map(([k, v]) => `${k.slice(0, 30)}:${typeof v}${typeof v === "string" ? `(${v.length})` : ""}`).join(", ") || "{}"
        : `a JSON ${Array.isArray(body) ? "array" : body === null ? "null" : typeof body}`;
  return `content-type ${req.headers.get("content-type") ?? "none"}, body ${shape}`;
}
