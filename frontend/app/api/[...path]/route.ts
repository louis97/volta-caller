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

/**
 * An empty but well-formed event stream.
 *
 * EventSource only retries on its own when a stream it had accepted drops. A
 * response that is not `text/event-stream` — the 500 this route used to
 * produce whenever the API was restarting or cold-starting — is fatal: the
 * browser closes the connection for good and the console stops updating until
 * someone reloads the page. Answering with a valid stream that says "come back
 * in three seconds" keeps that from ever happening.
 */
function retryLater(): Response {
  return new Response("retry: 3000\n\n", {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

async function proxy(request: Request, context: ProxyContext) {
  const { path } = await context.params;
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(
    `/api/${path.map(encodeURIComponent).join("/")}`,
    API_URL
  );
  targetUrl.search = incomingUrl.search;

  const wantsEventStream =
    path.join("/") === "events" ||
    (request.headers.get("accept")?.includes("text/event-stream") ?? false);

  const headers = new Headers(request.headers);
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("host");
  headers.set("x-volta-org-id", ORGANIZATION_ID);
  headers.set("x-volta-user-id", DASHBOARD_USER_ID);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      cache: "no-store",
      redirect: "manual"
    });
  } catch (error) {
    if (wantsEventStream) return retryLater();
    throw error;
  }

  // A stream the API refused — cold start, a 502 from Render, an auth blip —
  // is the same problem as one it could not answer at all.
  if (wantsEventStream && !upstream.ok) {
    void upstream.body?.cancel();
    return retryLater();
  }

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
