// infra/lambda/auth/admin.js
import { resolveAuthContextRequired, requireCapability } from "@wasit/authz";

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  try {
    const ctx = await resolveAuthContextRequired(event, {
      usersStateTable: process.env.USERS_STATE_TABLE,
      authzCapabilitiesTable: process.env.AUTHZ_CAPABILITIES_TABLE,
      authzGrantsTable: process.env.AUTHZ_GRANTS_TABLE,
    });

    // Required capability for now
    requireCapability(ctx, "admin");

    // TODO: add admin routing here (create user, attach capability, grant perms, etc.)
    return json(200, {
      ok: true,
      route: event?.rawPath ?? event?.path,
      method: event?.requestContext?.http?.method ?? event?.httpMethod,
      principal: ctx.principal,
      state: ctx.state,
      capabilities: ctx.capabilities,
    });
  } catch (err) {
    const msg = err?.message ?? "Unknown error";
    const status =
      msg.includes("Missing or invalid token") ? 401 :
      msg.includes("User not active") ? 403 :
      msg.includes("Missing capability") ? 403 :
      500;

    return json(status, { ok: false, error: msg });
  }
}
