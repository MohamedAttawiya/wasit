// infra/lambda/auth/index.js
// Control-plane Lambda: owns all /admin/* routes.
// Enforces PlatformAdmin via @wasit/authz and maps auth errors to 401/403 cleanly.
// Uses EMAIL as the admin-facing identifier.
// Creates users + assigns roles via Cognito Admin APIs (via SigV4 HTTP, no AWS SDK bundling issues).

import { getPrincipal, requireGroup, toHttpErrorResponse } from "@wasit/authz";
import { AwsClient } from "aws4fetch";

const USER_POOL_ID = process.env.USER_POOL_ID;
if (!USER_POOL_ID) throw new Error("Missing env USER_POOL_ID");

const REGION =
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "eu-central-1";

const PLATFORM_ADMIN_GROUP =
  process.env.PLATFORM_ADMIN_GROUP || "PlatformAdmin";

// exactly-one-of role groups (or none)
const ROLE_GROUPS = ["PlatformAdmin", "InternalOps", "Seller"];

// Cognito IDP endpoint (AWS JSON RPC)
const COGNITO_ENDPOINT = `https://cognito-idp.${REGION}.amazonaws.com/`;

// SigV4 client using Lambda's IAM role credentials automatically
 const aws = new AwsClient({
   region: REGION,
   service: "cognito-idp",
   accessKeyId: process.env.AWS_ACCESS_KEY_ID,
   secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
   sessionToken: process.env.AWS_SESSION_TOKEN, // important for Lambda
 });

// ---------- handler ----------

export async function handler(event) {
  try {
    const method = (event.requestContext?.http?.method || "").toUpperCase();
    const path = event.requestContext?.http?.path || event.rawPath || "";

    const principal = getPrincipal(event);

    // ---- enforce admin on all /admin/* ----
    if (path.startsWith("/admin/")) {
      requireGroup(principal, PLATFORM_ADMIN_GROUP);
    }

    // ---- debug (still admin-gated) ----
    if (method === "GET" && path === "/admin/_debug") {
      const auth = event?.requestContext?.authorizer || {};
      const jwtClaims = auth?.jwt?.claims || {};
      return json(200, {
        ok: true,
        route: "GET /admin/_debug",
        method,
        path,
        principalUserId: principal.userId,
        principalEmail: principal.email ?? null,
        principalGroups: principal.groups,
        token_use_jwt: jwtClaims.token_use,
        sub_jwt: jwtClaims.sub,
        username_jwt: jwtClaims["cognito:username"],
        email_jwt: jwtClaims.email,
        groups_jwt: jwtClaims["cognito:groups"],
        adminGroupEnforced: PLATFORM_ADMIN_GROUP,
      });
    }

    // ---- POST /admin/users : create user by email, optional role ----
    if (method === "POST" && path === "/admin/users") {
      const body = requireJsonBody(event);

      const email = normalizeEmail(body?.email);
      const role = body?.role ?? null; // PlatformAdmin | InternalOps | Seller | null
      const name = body?.name ? String(body.name).trim() : null;

      if (!email) return json(400, { error: "BAD_REQUEST", message: "email is required" });
      if (role !== null && role !== undefined && !ROLE_GROUPS.includes(role)) {
        return json(400, { error: "BAD_REQUEST", message: `role must be one of ${ROLE_GROUPS.join(", ")} or null` });
      }

      // If email already exists, do NOT create again.
      const existing = await findUserByEmail(email);
      if (existing) {
        return json(409, {
          error: "ALREADY_EXISTS",
          message: "User with this email already exists.",
          user: await enrichUser(existing.Username),
        });
      }

      // Make Cognito Username = email (clean + makes later admin ops easy)
      await cognitoAdminCreateUser({
        Username: email,
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          ...(name ? [{ Name: "name", Value: name }] : []),
        ],
        MessageAction: "SUPPRESS",
      });

      // Apply role (exactly one) if provided
      if (role) {
        await setSingleRoleByUsername(email, role);
      }

      return json(201, {
        ok: true,
        route: "POST /admin/users",
        user: await enrichUser(email),
      });
    }

    // ---- GET /admin/users : list users with groups/role ----
    if (method === "GET" && path === "/admin/users") {
      const qp = event?.queryStringParameters || {};
      const limit = clampInt(qp.limit, 1, 60, 25);
      const paginationToken = qp.paginationToken ? String(qp.paginationToken) : undefined;

      const res = await cognitoListUsers({ Limit: limit, PaginationToken: paginationToken });

      const users = res.Users ?? [];
      const out = [];
      for (const u of users) out.push(await enrichUser(u.Username));

      return json(200, {
        ok: true,
        route: "GET /admin/users",
        nextPaginationToken: res.PaginationToken ?? null,
        count: out.length,
        users: out,
      });
    }

    // ---- PATCH /admin/users/role : set role by EMAIL ----
    // Body: { "email": "...", "role": "InternalOps" | "Seller" | "PlatformAdmin" | null }
    if (method === "PATCH" && path === "/admin/users/role") {
      const body = requireJsonBody(event);

      const email = normalizeEmail(body?.email);
      const role = body?.role ?? null;

      if (!email) return json(400, { error: "BAD_REQUEST", message: "email is required" });
      if (role !== null && role !== undefined && !ROLE_GROUPS.includes(role)) {
        return json(400, { error: "BAD_REQUEST", message: `role must be one of ${ROLE_GROUPS.join(", ")} or null` });
      }

      const user = await findUserByEmail(email);
      if (!user) return json(404, { error: "NOT_FOUND", message: "No user with this email." });

      // Safety: prevent you locking yourself out by accident
      const selfEmail = (principal.email ?? "").toLowerCase();
      if (selfEmail && selfEmail === email && role !== PLATFORM_ADMIN_GROUP) {
        return json(400, {
          error: "BAD_REQUEST",
          message: `Refusing to remove ${PLATFORM_ADMIN_GROUP} from the current caller.`,
        });
      }

      if (role) await setSingleRoleByUsername(user.Username, role);
      else await clearRolesByUsername(user.Username);

      return json(200, {
        ok: true,
        route: "PATCH /admin/users/role",
        email,
        role: role ?? null,
        user: await enrichUser(user.Username),
      });
    }

    return json(404, { error: "Not Found", method, path });
  } catch (err) {
    return toHttpErrorResponse(err);
  }
}

// ---------- Cognito helpers (SigV4 JSON RPC) ----------

async function cognitoCall(target, payload) {
  const res = await aws.fetch(COGNITO_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": target,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }

  if (!res.ok) {
    const msg =
      data?.message ||
      data?.__type ||
      `Cognito error (${res.status})`;
    const e = new Error(msg);
    e.statusCode = 500;
    e.details = data ?? text;
    throw e;
  }
  return data ?? {};
}

async function cognitoListUsers({ Limit, PaginationToken, Filter } = {}) {
  return cognitoCall("AWSCognitoIdentityProviderService.ListUsers", {
    UserPoolId: USER_POOL_ID,
    ...(Limit ? { Limit } : {}),
    ...(PaginationToken ? { PaginationToken } : {}),
    ...(Filter ? { Filter } : {}),
  });
}

async function cognitoAdminGetUser({ Username }) {
  return cognitoCall("AWSCognitoIdentityProviderService.AdminGetUser", {
    UserPoolId: USER_POOL_ID,
    Username,
  });
}

async function cognitoAdminCreateUser({ Username, UserAttributes, MessageAction }) {
  return cognitoCall("AWSCognitoIdentityProviderService.AdminCreateUser", {
    UserPoolId: USER_POOL_ID,
    Username,
    UserAttributes,
    ...(MessageAction ? { MessageAction } : {}),
  });
}

async function cognitoAdminListGroupsForUser({ Username }) {
  return cognitoCall("AWSCognitoIdentityProviderService.AdminListGroupsForUser", {
    UserPoolId: USER_POOL_ID,
    Username,
  });
}

async function cognitoAdminAddUserToGroup({ Username, GroupName }) {
  return cognitoCall("AWSCognitoIdentityProviderService.AdminAddUserToGroup", {
    UserPoolId: USER_POOL_ID,
    Username,
    GroupName,
  });
}

async function cognitoAdminRemoveUserFromGroup({ Username, GroupName }) {
  return cognitoCall("AWSCognitoIdentityProviderService.AdminRemoveUserFromGroup", {
    UserPoolId: USER_POOL_ID,
    Username,
    GroupName,
  });
}

// ---------- user enrichment / role logic ----------

async function enrichUser(username) {
  const u = await cognitoAdminGetUser({ Username: username });

  const attrs = attrsToObject(u.UserAttributes || []);
  const email = attrs.email ?? null;
  const sub = attrs.sub ?? null;

  const groups = await listGroupsForUser(username);
  const role = pickRole(groups);

  return {
    username,
    email,
    sub,
    enabled: u.Enabled ?? null,
    status: u.UserStatus ?? null,
    createdAt: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : null,
    updatedAt: u.UserLastModifiedDate ? new Date(u.UserLastModifiedDate).toISOString() : null,
    groups,
    role,
  };
}

async function findUserByEmail(email) {
  // Cognito filter syntax: email = "a@b.com"
  const res = await cognitoListUsers({
    Filter: `email = "${escapeForCognitoFilter(email)}"`,
    Limit: 1,
  });
  const user = (res.Users ?? [])[0];
  return user || null;
}

async function listGroupsForUser(username) {
  const res = await cognitoAdminListGroupsForUser({ Username: username });
  return (res.Groups ?? []).map((g) => g.GroupName).filter(Boolean);
}

function pickRole(groups) {
  for (const g of ROLE_GROUPS) {
    if (groups.includes(g)) return g;
  }
  return null;
}

async function clearRolesByUsername(username) {
  const current = await listGroupsForUser(username);
  for (const g of ROLE_GROUPS) {
    if (current.includes(g)) {
      await cognitoAdminRemoveUserFromGroup({
        Username: username,
        GroupName: g,
      });
    }
  }
}

async function setSingleRoleByUsername(username, role) {
  await clearRolesByUsername(username);
  await cognitoAdminAddUserToGroup({
    Username: username,
    GroupName: role,
  });
}

// ---------- generic helpers ----------

function requireJsonBody(event) {
  const parsed = parseJsonBody(event);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed;
}

function parseJsonBody(event) {
  if (!event?.body) return null;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : String(event.body);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function normalizeEmail(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (!s.includes("@")) return null;
  return s;
}

function escapeForCognitoFilter(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function attrsToObject(attrs) {
  const out = {};
  for (const a of attrs) {
    if (a?.Name) out[a.Name] = a.Value;
  }
  return out;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
