// infra/lambda/auth/index.js
// Control-plane Lambda: owns all /admin/* routes.
// NOTE: This is a stub router. Next step is implementing the real operations.

exports.handler = async (event) => {
  const method = (event.requestContext?.http?.method || "").toUpperCase();
  const path = event.requestContext?.http?.path || event.rawPath || "";

  // Defense in depth: route is already JWT-authorized, but you should still check groups here later.
  // const claims = event.requestContext?.authorizer?.jwt?.claims || {};
  // const groups = claims["cognito:groups"] || [];

  if (method === "POST" && path === "/admin/users") {
    return json(200, { ok: true, route: "POST /admin/users", todo: "create user + set type + init UsersState" });
  }

  if (method === "PATCH" && path.startsWith("/admin/users/") && path.endsWith("/state")) {
    return json(200, { ok: true, route: "PATCH /admin/users/{userId}/state", todo: "update UsersState" });
  }

  if (method === "POST" && path === "/admin/grants") {
    return json(200, { ok: true, route: "POST /admin/grants", todo: "write authz grant" });
  }

  if (method === "DELETE" && path === "/admin/grants") {
    return json(200, { ok: true, route: "DELETE /admin/grants", todo: "revoke authz grant" });
  }

  return json(404, { error: "Not Found", method, path });
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
