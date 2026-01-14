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

export const handler = async (event: any) => {
  const host = normalizeHost(event.headers?.host || event.headers?.Host || "");

  if (!host) {
    return {
      statusCode: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: html("Bad Request", `<h1>Missing host</h1>`),
    };
  }

  // Call tenant service
  const url = `${TENANT_API_URL}/resolve?host=${encodeURIComponent(host)}`;
  let data: any;
  try {
    const res = await fetch(url, { method: "GET" });
    data = await res.json();
  } catch (e) {
    console.error("tenant lookup failed", e);
    return {
      statusCode: 503,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: html(
        "Service Unavailable",
        `<h1>Temporary error</h1><p class="muted">Tenant service unreachable.</p><span class="badge">${host}</span>`
      ),
    };
  }

  if (!data.exists) {
    return {
      statusCode: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: html(
        "Store Not Found",
        `<h1>This store doesn’t exist</h1><p class="muted">No tenant mapped for this hostname.</p><span class="badge">${host}</span>`
      ),
    };
  }

  if ((data.status || "").toUpperCase() === "SUSPENDED") {
    return {
      statusCode: 403,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: html(
        "Store Suspended",
        `<h1>This store is suspended</h1><p class="muted">StoreId: <b>${data.storeId}</b></p><span class="badge">${host}</span>`
      ),
    };
  }

  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: html(
      "Store Exists",
      `<h1>This store exists</h1><p class="muted">StoreId: <b>${data.storeId}</b></p><span class="badge">${host}</span>`
    ),
  };
};
