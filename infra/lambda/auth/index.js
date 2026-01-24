import {
  resolveAuthContextOptional,
  resolveAuthContextRequired,
  toHttpError,
} from "@wasit/authz";

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function getPath(event) {
  const p = event?.requestContext?.http?.path ?? event?.rawPath ?? "/";
  return String(p).split("?")[0];
}

function getMethod(event) {
  return String(event?.requestContext?.http?.method ?? event?.httpMethod ?? "GET").toUpperCase();
}

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export async function handler(event) {
  try {
    const path = getPath(event);
    const method = getMethod(event);

    const opts = {
      usersStateTable: requiredEnv("USERS_STATE_TABLE"),
      authzGrantsTable: requiredEnv("AUTHZ_GRANTS_TABLE"),
      authzCapabilitiesTable: requiredEnv("AUTHZ_CAPABILITIES_TABLE"),
    };

    // GET /me (OPTIONAL AUTH)
    if (method === "GET" && path === "/me") {
      const auth = await resolveAuthContextOptional(event, opts);
      return json(200, auth);
    }

    // Everything else (REQUIRED AUTH) - temporary debug behavior
    const auth = await resolveAuthContextRequired(event, opts);
    return json(200, auth);
  } catch (err) {
    try {
      return toHttpError(err);
    } catch {
      return json(500, { error: "InternalError", message: err?.message ?? "Unknown error" });
    }
  }
}
