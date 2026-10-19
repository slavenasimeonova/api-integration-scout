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
