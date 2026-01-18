// infra/lambda/auth/index.js
// Control-plane Lambda: owns all /admin/* routes.
// Now enforces GodAdmin via @wasit/authz and maps auth errors to 401/403 cleanly.

import {
  getPrincipal,
  requireGroup,
  toHttpErrorResponse,
} from "@wasit/authz";

export async function handler(event) {
  try {
    const method = (event.requestContext?.http?.method || "").toUpperCase();
    const path = event.requestContext?.http?.path || event.rawPath || "";

    // Extract principal from API Gateway JWT authorizer claims
    const principal = getPrincipal(event);

    // Enforce platform admin access on ALL admin routes
    if (path.startsWith("/admin/")) {
      requireGroup(principal, "GodAdmin");
    }

    if (method === "POST" && path === "/admin/users") {
      return json(200, {
        ok: true,
        route: "POST /admin/users",
        todo: "create user + set type + init UsersState",
      });
    }

    if (method === "PATCH" && path.startsWith("/admin/users/") && path.endsWith("/state")) {
      return json(200, {
        ok: true,
        route: "PATCH /admin/users/{userId}/state",
        todo: "update UsersState",
      });
    }

    if (method === "POST" && path === "/admin/grants") {
      return json(200, {
        ok: true,
        route: "POST /admin/grants",
        todo: "write authz grant",
      });
    }

    if (method === "DELETE" && path === "/admin/grants") {
      return json(200, {
        ok: true,
        route: "DELETE /admin/grants",
        todo: "revoke authz grant",
      });
    }
if (method === "GET" && path === "/admin/users") {
  return json(200, {
    ok: true,
    route: "GET /admin/users",
    todo: "list users (Cognito + UsersState)",
  });
}

if (method === "GET" && path.startsWith("/admin/users/")) {
  const parts = path.split("/");
  const userId = parts[3]; // /admin/users/{userId}

  return json(200, {
    ok: true,
    route: "GET /admin/users/{userId}",
    userId,
    todo: "get user details + state",
  });
}

if (method === "GET" && path === "/admin/grants") {
  return json(200, {
    ok: true,
    route: "GET /admin/grants",
    todo: "list authz grants (optionally filter by principal/resource)",
  });
}

    return json(404, { error: "Not Found", method, path });
  } catch (err) {
    return toHttpErrorResponse(err);
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
