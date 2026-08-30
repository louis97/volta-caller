const API_URL =
  process.env.VOLTA_API_URL ??
  (process.env.NODE_ENV === "production"
    ? "https://volta-api-jkax.onrender.com"
    : "http://localhost:3001");
const ORGANIZATION_ID =
  process.env.VOLTA_ORGANIZATION_ID ?? "textiles-pacifico";
const DASHBOARD_USER_ID =
  process.env.VOLTA_DASHBOARD_USER_ID ?? "volta-dashboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type ProxyContext = {
  params: Promise<{ path: string[] }>;
};

async function proxy(request: Request, context: ProxyContext) {
  const { path } = await context.params;
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(
    `/api/${path.map(encodeURIComponent).join("/")}`,
    API_URL
  );
  targetUrl.search = incomingUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("host");
  headers.set("x-volta-org-id", ORGANIZATION_ID);
  headers.set("x-volta-user-id", DASHBOARD_USER_ID);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    cache: "no-store",
    redirect: "manual"
  });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
    responseHeaders.set("Cache-Control", "no-cache, no-transform");
    responseHeaders.set("Connection", "keep-alive");
    responseHeaders.set("X-Accel-Buffering", "no");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
