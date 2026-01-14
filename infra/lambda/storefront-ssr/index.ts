// lambda/storefront-ssr/index.ts
// Drop-in replacement: adds correlationId + JSON structured logs + propagates correlationId to Tenant API.
// Keeps your current behavior: requires x-forwarded-host (CloudFront or Phase-0 test header).

const TENANT_API_URL = process.env.TENANT_API_URL!;

function normalizeHost(host: string) {
  const h = (host || "").toLowerCase().trim();
  const noPort = h.split(":")[0];
  return noPort.endsWith(".") ? noPort.slice(0, -1) : noPort;
}

function html(title: string, body: string) {
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body{font-family:system-ui, -apple-system, Segoe UI, Roboto, Arial; padding:48px; color:#111}
  .box{max-width:720px}
  .muted{color:#666}
  .badge{display:inline-block; padding:6px 10px; border:1px solid #ddd; border-radius:999px; font-size:12px}
</style>
</head>
<body>
  <div class="box">
    ${body}
  </div>
</body></html>`;
}

// ---------- small helpers (no deps) ----------
function headerGet(headers: Record<string, any> | undefined, name: string): string {
  if (!headers) return "";
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return String(headers[k] ?? "");
  }
  return "";
}

function nowMs() {
  return Date.now();
}

function logJson(obj: Record<string, any>) {
  // CloudWatch-friendly: one line JSON
  console.log(JSON.stringify(obj));
}

function makeCorrelationId(event: any): string {
  const incoming = headerGet(event?.headers, "x-correlation-id");
  if (incoming) return incoming;

  // Node 20: crypto.randomUUID() available
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require("crypto");
    return crypto.randomUUID();
  } catch {
    return `cid_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  }
}

function getAwsRequestId(event: any): string {
  // Varies by trigger shape; best-effort
  return (
    String(event?.requestContext?.requestId ?? "") ||
    String(event?.requestContext?.http?.requestId ?? "") ||
    ""
  );
}

function getMethod(event: any): string {
  return (
    String(event?.requestContext?.http?.method ?? "") ||
    String(event?.httpMethod ?? "") ||
    "GET"
  );
}

function getPath(event: any): string {
  return String(event?.rawPath ?? event?.path ?? "/");
}

// ---------- handler ----------
export const handler = async (event: any) => {
  const start = nowMs();

  const correlationId = makeCorrelationId(event);
  const awsRequestId = getAwsRequestId(event);

  // Hard requirement: CloudFront must set this (or Phase-0 tests pass it)
  const rawHost =
    headerGet(event?.headers, "x-forwarded-host") ||
    headerGet(event?.headers, "x-forwarded-host".toUpperCase()) ||
    headerGet(event?.headers, "X-Forwarded-Host");

  const host = normalizeHost(rawHost);

  logJson({
    level: "INFO",
    service: "storefront-ssr",
    msg: "request_start",
    correlationId,
    awsRequestId,
    method: getMethod(event),
    path: getPath(event),
    host,
  });

  if (!host) {
    const statusCode = 400;

    logJson({
      level: "WARN",
      service: "storefront-ssr",
      msg: "missing_x_forwarded_host",
      correlationId,
      awsRequestId,
      statusCode,
      latencyMs: nowMs() - start,
    });

    return {
      statusCode,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-correlation-id": correlationId,
      },
      body: html(
        "Bad Request",
        `<h1>Missing x-forwarded-host</h1>
         <p class="muted">This endpoint is designed to be called via CloudFront.</p>`
      ),
    };
  }

  const url = `${TENANT_API_URL}/resolve?host=${encodeURIComponent(host)}`;

  let data: any;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "x-correlation-id": correlationId, // propagate to tenant service
      },
    });

    // If tenant service returns non-JSON or errors, this will throw and go to catch
    data = await res.json();
  } catch (e: any) {
    logJson({
      level: "ERROR",
      service: "storefront-ssr",
      msg: "tenant_lookup_failed",
      correlationId,
      awsRequestId,
      host,
      error: String(e?.message || e),
      latencyMs: nowMs() - start,
    });

    return {
      statusCode: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-correlation-id": correlationId,
      },
      body: html(
        "Service Unavailable",
        `<h1>Temporary error</h1>
         <p class="muted">Tenant service unreachable.</p>
         <span class="badge">${host}</span>`
      ),
    };
  }

  // Decide response
  let statusCode = 200;
  let title = "Store Exists";
  let body = `<h1>This store exists</h1>
       <p class="muted">StoreId: <b>${data.storeId}</b></p>
       <span class="badge">${host}</span>`;

  if (!data.exists) {
    statusCode = 404;
    title = "Store Not Found";
    body = `<h1>This store doesn’t exist</h1>
         <p class="muted">No tenant mapped for this hostname.</p>
         <span class="badge">${host}</span>`;
  } else if ((String(data.status || "")).toUpperCase() === "SUSPENDED") {
    statusCode = 403;
    title = "Store Suspended";
    body = `<h1>This store is suspended</h1>
         <p class="muted">StoreId: <b>${data.storeId}</b></p>
         <span class="badge">${host}</span>`;
  }

  logJson({
    level: "INFO",
    service: "storefront-ssr",
    msg: "request_end",
    correlationId,
    awsRequestId,
    host,
    storeId: data?.storeId ?? null,
    tenantStatus: data?.status ?? null,
    exists: Boolean(data?.exists),
    statusCode,
    latencyMs: nowMs() - start,
  });

  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-correlation-id": correlationId,
    },
    body: html(title, body),
  };
};
