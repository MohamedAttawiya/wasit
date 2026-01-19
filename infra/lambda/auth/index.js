//js
// infra/lambda/auth/index.js
// Control-plane Lambda: owns all /admin/* routes.
// Enforces PlatformAdmin via @wasit/authz and maps auth errors to 401/403 cleanly.
// Uses EMAIL as the admin-facing identifier.
// Cognito Admin APIs via SigV4 JSON-RPC (aws4fetch) — no AWS SDK bundling issues.
//
// Enforcements added:
// - users_state is REQUIRED and authoritative for lifecycle state.
// - Every /admin/* request requires caller to be ACTIVE in users_state (self-heals caller row).
// - Created users always get users_state with state=ACTIVE by default.
// - State transitions enforce Cognito enable/disable for DISABLED/ACTIVE.
// - GET /admin/users self-heals missing users_state rows (default ACTIVE).
// - PATCH /admin/users/groups mirrors groups into users_state (best-effort).
//
// Routes:
// - GET    /admin/_debug
// - GET    /admin/users
// - POST   /admin/users
// - PATCH  /admin/users/groups
// - PATCH  /admin/users/state
// - DELETE /admin/users

import { getPrincipal, requireGroup, toHttpErrorResponse } from "@wasit/authz";
import { AwsClient } from "aws4fetch";

const USER_POOL_ID = process.env.USER_POOL_ID;
if (!USER_POOL_ID) throw new Error("Missing env USER_POOL_ID");

const USERS_STATE_TABLE = process.env.USERS_STATE_TABLE;
if (!USERS_STATE_TABLE) throw new Error("Missing env USERS_STATE_TABLE");

const REGION =
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "eu-central-1";

const PLATFORM_ADMIN_GROUP =
  process.env.PLATFORM_ADMIN_GROUP || "PlatformAdmin";

const ROLE_GROUPS = ["PlatformAdmin", "InternalOps", "Seller"];
const USER_STATES = ["ACTIVE", "SUSPENDED", "DISABLED"];

const COGNITO_ENDPOINT = `https://cognito-idp.${REGION}.amazonaws.com/`;
const DDB_ENDPOINT = `https://dynamodb.${REGION}.amazonaws.com/`;

const cognito = new AwsClient({
  region: REGION,
  service: "cognito-idp",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
});

const ddb = new AwsClient({
  region: REGION,
  service: "dynamodb",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
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

      // ---- enforce caller is ACTIVE in users_state (self-heal) ----
      await requireActiveCaller(principal);
    }

    // ---- debug (still admin-gated) ----
    if (method === "GET" && path === "/admin/_debug") {
      const auth = event?.requestContext?.authorizer || {};
      const jwtClaims = auth?.jwt?.claims || {};
      const callerState = principal.email
        ? await getUserState(principal.email).catch(() => null)
        : null;

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
        caller_state: callerState?.state ?? null,
        caller_state_updatedAt: callerState?.updatedAt ?? null,
      });
    }

    // ---- POST /admin/users : create user by email, optional name, optional groups ----
    // Body: { email, name?, groups?: string[] | string | null }
    // NOTE: Created users are ALWAYS state=ACTIVE (ignore body.state if supplied).
    if (method === "POST" && path === "/admin/users") {
      const body = requireJsonBody(event);

      const email = normalizeEmail(body?.email);
      const name = body?.name ? String(body.name).trim() : null;
      const groups = normalizeGroups(body?.groups);

      if (!email) {
        return json(400, {
          error: "BAD_REQUEST",
          message: "email is required",
        });
      }

      // Validate groups against known list (tight control plane)
      const invalid = groups.filter((g) => !ROLE_GROUPS.includes(g));
      if (invalid.length) {
        return json(400, {
          error: "BAD_REQUEST",
          message: `groups contain invalid value(s): ${invalid.join(", ")}. Allowed: ${ROLE_GROUPS.join(", ")}`,
        });
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

      // Make Cognito Username = email (intentional)
      await cognitoAdminCreateUser({
        Username: email,
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          ...(name ? [{ Name: "name", Value: name }] : []),
        ],
        MessageAction: "SUPPRESS",
      });

      // Apply groups (multi-group) if provided
      if (groups.length) {
        await setGroupsByUsername(email, groups);
      }

      // Authoritative state row: ALWAYS create ACTIVE
      await ensureUserState({
        email,
        desiredState: "ACTIVE",
        actorEmail: principal.email ?? null,
        // mirror groups best-effort
        groups: groups.length ? groups : undefined,
        reason: "USER_CREATED",
      });

      return json(201, {
        ok: true,
        route: "POST /admin/users",
        user: await enrichUser(email),
      });
    }

    // ---- GET /admin/users : list users with groups + derived role + state ----
    // Also self-heals missing users_state rows (default ACTIVE).
    if (method === "GET" && path === "/admin/users") {
      const qp = event?.queryStringParameters || {};
      const limit = clampInt(qp.limit, 1, 60, 25);
      const paginationToken = qp.paginationToken ? String(qp.paginationToken) : undefined;

      const res = await cognitoListUsers({
        Limit: limit,
        PaginationToken: paginationToken,
      });

      const users = res.Users ?? [];
      const out = [];

      for (const u of users) {
        if (!u?.Username) continue;
        const enriched = await enrichUser(u.Username);

        // If users_state missing, create ACTIVE (authoritative default)
        if (enriched.email && !enriched.state) {
          await ensureUserState({
            email: enriched.email,
            desiredState: "ACTIVE",
            actorEmail: principal.email ?? null,
            groups: enriched.groups ?? undefined,
            reason: "SELF_HEAL_LIST",
          }).catch(() => {});
          // Re-enrich to reflect new state
          const refreshed = await enrichUser(u.Username);
          out.push(refreshed);
        } else {
          out.push(enriched);
        }
      }

      return json(200, {
        ok: true,
        route: "GET /admin/users",
        nextPaginationToken: res.PaginationToken ?? null,
        count: out.length,
        users: out,
      });
    }

    // ---- PATCH /admin/users/groups : multi-group membership management by EMAIL ----
    // Body supports either:
    //   { email, set: ["PlatformAdmin","Seller"] }
    // or { email, add: [...], remove: [...] }
    // Also mirrors groups into users_state (best-effort).
    if (method === "PATCH" && path === "/admin/users/groups") {
      const body = requireJsonBody(event);

      const email = normalizeEmail(body?.email);
      if (!email) return json(400, { error: "BAD_REQUEST", message: "email is required" });

      const user = await findUserByEmail(email);
      if (!user) return json(404, { error: "NOT_FOUND", message: "No user with this email." });

      const selfEmail = (principal.email ?? "").toLowerCase();
      const isSelf = !!selfEmail && selfEmail === email;

      const current = await listGroupsForUser(user.Username);
      let desired = current.slice();

      if (body?.set !== undefined) {
        const set = normalizeGroups(body.set);
        const invalid = set.filter((g) => !ROLE_GROUPS.includes(g));
        if (invalid.length) {
          return json(400, {
            error: "BAD_REQUEST",
            message: `set contains invalid value(s): ${invalid.join(", ")}. Allowed: ${ROLE_GROUPS.join(", ")}`,
          });
        }
        desired = uniq(set);
      } else {
        const add = normalizeGroups(body?.add);
        const remove = normalizeGroups(body?.remove);

        const invalid = [...add, ...remove].filter((g) => !ROLE_GROUPS.includes(g));
        if (invalid.length) {
          return json(400, {
            error: "BAD_REQUEST",
            message: `add/remove contain invalid value(s): ${uniq(invalid).join(", ")}. Allowed: ${ROLE_GROUPS.join(", ")}`,
          });
        }

        desired = uniq([...current, ...add]).filter((g) => !remove.includes(g));
      }

      // Safety: prevent locking yourself out by removing PlatformAdmin from self
      if (isSelf && !desired.includes(PLATFORM_ADMIN_GROUP)) {
        return json(400, {
          error: "BAD_REQUEST",
          message: `Refusing to remove ${PLATFORM_ADMIN_GROUP} from the current caller.`,
        });
      }

      await setGroupsByUsername(user.Username, desired);

      // Mirror groups into users_state (authoritative state stays as-is)
      await ensureUserState({
        email,
        actorEmail: principal.email ?? null,
        groups: desired,
        reason: "GROUPS_UPDATED",
      });

      return json(200, {
        ok: true,
        route: "PATCH /admin/users/groups",
        email,
        groups: desired,
        user: await enrichUser(user.Username),
      });
    }

    // ---- PATCH /admin/users/state : update users_state row + enforce Cognito enable/disable when needed ----
    // Body: { email, state: "ACTIVE"|"SUSPENDED"|"DISABLED" }
    if (method === "PATCH" && path === "/admin/users/state") {
      const body = requireJsonBody(event);

      const email = normalizeEmail(body?.email);
      const state = normalizeState(body?.state);

      if (!email) return json(400, { error: "BAD_REQUEST", message: "email is required" });
      if (!state) {
        return json(400, {
          error: "BAD_REQUEST",
          message: `state is required and must be one of: ${USER_STATES.join(", ")}`,
        });
      }

      const user = await findUserByEmail(email);
      if (!user) return json(404, { error: "NOT_FOUND", message: "No user with this email." });

      // Enforce Cognito for DISABLED/ACTIVE (suspended is app-level only)
      if (state === "DISABLED") {
        await cognitoAdminDisableUser({ Username: user.Username });
      } else if (state === "ACTIVE") {
        await cognitoAdminEnableUser({ Username: user.Username });
      }

      // Authoritative state write (ensures row exists)
      await ensureUserState({
        email,
        desiredState: state,
        actorEmail: principal.email ?? null,
        reason: "STATE_UPDATED",
      });

      return json(200, {
        ok: true,
        route: "PATCH /admin/users/state",
        email,
        state,
        user: await enrichUser(user.Username),
      });
    }

    // ---- DELETE /admin/users : delete user by EMAIL ----
    // Body: { email }
    if (method === "DELETE" && path === "/admin/users") {
      const body = requireJsonBody(event);
      const email = normalizeEmail(body?.email);

      if (!email) return json(400, { error: "BAD_REQUEST", message: "email is required" });

      const selfEmail = (principal.email ?? "").toLowerCase();
      if (selfEmail && selfEmail === email) {
        return json(400, { error: "BAD_REQUEST", message: "Refusing to delete the current caller." });
      }

      const user = await findUserByEmail(email);
      if (!user) return json(404, { error: "NOT_FOUND", message: "No user with this email." });

      // Safety: best-effort prevent deleting the last PlatformAdmin (sample-based)
      const groups = await listGroupsForUser(user.Username);
      const isAdmin = groups.includes(PLATFORM_ADMIN_GROUP);
      if (isAdmin) {
        const sample = await cognitoListUsers({ Limit: 60 });
        let otherAdminFound = false;
        for (const u of sample.Users ?? []) {
          if (!u?.Username) continue;
          if (String(u.Username).toLowerCase() === email) continue;
          const gs = await listGroupsForUser(u.Username);
          if (gs.includes(PLATFORM_ADMIN_GROUP)) {
            otherAdminFound = true;
            break;
          }
        }
        if (!otherAdminFound) {
          return json(400, {
            error: "BAD_REQUEST",
            message: `Refusing to delete; no other ${PLATFORM_ADMIN_GROUP} found in sample set. (Implement full last-admin protection if needed.)`,
          });
        }
      }

      await cognitoAdminDeleteUser({ Username: user.Username });

      // Delete users_state row (best-effort)
      await deleteUserState({ email }).catch(() => {});

      return json(200, {
        ok: true,
        route: "DELETE /admin/users",
        email,
        deleted: true,
      });
    }

    return json(404, { error: "Not Found", method, path });
  } catch (err) {
    return toHttpErrorResponse(err);
  }
}

// ---------- enforcement: caller must be ACTIVE ----------

async function requireActiveCaller(principal) {
  const email = normalizeEmail(principal?.email);
  if (!email) {
    const e = new Error("Missing email on principal");
    e.statusCode = 401;
    throw e;
  }

  // Ensure caller row exists and default it to ACTIVE
  const stateRow = await ensureUserState({
    email,
    desiredState: "ACTIVE",
    actorEmail: email,
    reason: "SELF_HEAL_CALLER",
  });

  const state = stateRow?.state ?? null;
  if (state !== "ACTIVE") {
    const e = new Error(`User is not ACTIVE (state=${state ?? "unknown"})`);
    e.statusCode = 403;
    e.body = { error: "FORBIDDEN", message: "User is not active", state };
    throw e;
  }
}

// ---------- Cognito helpers (SigV4 JSON RPC) ----------

async function cognitoCall(target, payload) {
  const res = await cognito.fetch(COGNITO_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": target,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }

  if (!res.ok) {
    const msg = data?.message || data?.__type || `Cognito error (${res.status})`;
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

async function cognitoAdminDeleteUser({ Username }) {
  return cognitoCall("AWSCognitoIdentityProviderService.AdminDeleteUser", {
    UserPoolId: USER_POOL_ID,
    Username,
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

async function cognitoAdminDisableUser({ Username }) {
  return cognitoCall("AWSCognitoIdentityProviderService.AdminDisableUser", {
    UserPoolId: USER_POOL_ID,
    Username,
  });
}

async function cognitoAdminEnableUser({ Username }) {
  return cognitoCall("AWSCognitoIdentityProviderService.AdminEnableUser", {
    UserPoolId: USER_POOL_ID,
    Username,
  });
}

// ---------- DynamoDB helpers (SigV4 JSON RPC) ----------

async function ddbCall(target, payload) {
  const res = await ddb.fetch(DDB_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": target,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }

  if (!res.ok) {
    const msg = data?.message || data?.__type || `DynamoDB error (${res.status})`;
    const e = new Error(msg);
    e.statusCode = 500;
    e.details = data ?? text;
    throw e;
  }
  return data ?? {};
}

// pk = USER#<email>
function userStateKey(email) {
  return { pk: { S: `USER#${email}` } };
}

async function getUserState(email) {
  const res = await ddbCall("DynamoDB_20120810.GetItem", {
    TableName: USERS_STATE_TABLE,
    Key: userStateKey(email),
    ConsistentRead: true,
  });

  const item = res.Item || null;
  if (!item) return null;

  return {
    email: item.email?.S ?? email,
    state: item.state?.S ?? null,
    updatedAt: item.updatedAt?.S ?? null,
    groups: item.groups?.SS ?? [],
  };
}

// Creates row if missing, updates only provided fields otherwise.
// Returns the current row (best-effort).
async function ensureUserState({ email, desiredState, actorEmail, groups, reason }) {
  const now = new Date().toISOString();

  // First attempt: create row if missing
  if (desiredState) {
    await ddbCall("DynamoDB_20120810.PutItem", {
      TableName: USERS_STATE_TABLE,
      Item: {
        ...userStateKey(email),
        email: { S: email },
        state: { S: desiredState },
        createdAt: { S: now },
        updatedAt: { S: now },
        ...(actorEmail ? { createdBy: { S: String(actorEmail) } } : {}),
        ...(actorEmail ? { updatedBy: { S: String(actorEmail) } } : {}),
        ...(reason ? { lastReason: { S: String(reason) } } : {}),
        ...(groups && groups.length ? { groups: { SS: uniq(groups) } } : {}),
      },
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "pk" },
    }).catch((err) => {
      const type = err?.details?.__type || "";
      if (String(type).includes("ConditionalCheckFailed")) return {};
      throw err;
    });
  } else {
    // Still create missing row with default ACTIVE if we weren't asked for a state
    await ddbCall("DynamoDB_20120810.PutItem", {
      TableName: USERS_STATE_TABLE,
      Item: {
        ...userStateKey(email),
        email: { S: email },
        state: { S: "ACTIVE" },
        createdAt: { S: now },
        updatedAt: { S: now },
        ...(actorEmail ? { createdBy: { S: String(actorEmail) } } : {}),
        ...(actorEmail ? { updatedBy: { S: String(actorEmail) } } : {}),
        ...(reason ? { lastReason: { S: String(reason) } } : {}),
        ...(groups && groups.length ? { groups: { SS: uniq(groups) } } : {}),
      },
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "pk" },
    }).catch((err) => {
      const type = err?.details?.__type || "";
      if (String(type).includes("ConditionalCheckFailed")) return {};
      throw err;
    });
  }

  // Then: update fields if provided (state and/or groups)
  const updates = [];
  const ean = { "#updatedAt": "updatedAt", "#updatedBy": "updatedBy" };
  const eav = {
    ":u": { S: now },
    ":b": { S: String(actorEmail ?? "unknown") },
  };

  if (desiredState) {
    updates.push("#state = :s");
    ean["#state"] = "state";
    eav[":s"] = { S: desiredState };
  }

  if (groups !== undefined) {
    updates.push("#groups = :g");
    ean["#groups"] = "groups";
    eav[":g"] = { SS: uniq(groups) };
  }

  if (reason) {
    updates.push("#lastReason = :r");
    ean["#lastReason"] = "lastReason";
    eav[":r"] = { S: String(reason) };
  }

  // Always touch updatedAt/updatedBy when called
  updates.push("#updatedAt = :u");
  updates.push("#updatedBy = :b");

  await ddbCall("DynamoDB_20120810.UpdateItem", {
    TableName: USERS_STATE_TABLE,
    Key: userStateKey(email),
    UpdateExpression: `SET ${updates.join(", ")}`,
    ExpressionAttributeNames: ean,
    ExpressionAttributeValues: eav,
    ReturnValues: "ALL_NEW",
  }).catch(() => {});

  const row = await getUserState(email).catch(() => null);
  return row;
}

async function deleteUserState({ email }) {
  return ddbCall("DynamoDB_20120810.DeleteItem", {
    TableName: USERS_STATE_TABLE,
    Key: userStateKey(email),
  });
}

// ---------- user enrichment / group logic ----------

async function enrichUser(username) {
  const u = await cognitoAdminGetUser({ Username: username });

  const attrs = attrsToObject(u.UserAttributes || []);
  const email = attrs.email ?? null;
  const sub = attrs.sub ?? null;

  const groups = await listGroupsForUser(username);
  const role = pickRole(groups);

  let state = null;
  if (email) {
    const s = await getUserState(email).catch(() => null);
    state = s?.state ?? null;
  }

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
    state,
  };
}

async function findUserByEmail(email) {
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

async function setGroupsByUsername(username, desiredGroups) {
  const desired = uniq(desiredGroups).filter((g) => ROLE_GROUPS.includes(g));
  const current = await listGroupsForUser(username);

  const toAdd = desired.filter((g) => !current.includes(g));
  const toRemove = current.filter((g) => ROLE_GROUPS.includes(g) && !desired.includes(g));

  for (const g of toRemove) {
    await cognitoAdminRemoveUserFromGroup({ Username: username, GroupName: g });
  }
  for (const g of toAdd) {
    await cognitoAdminAddUserToGroup({ Username: username, GroupName: g });
  }
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

function normalizeGroups(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).map((x) => x.trim()).filter(Boolean);
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map(String).map((x) => x.trim()).filter(Boolean);
      } catch {
        const inner = s.slice(1, -1).trim();
        if (!inner) return [];
        return inner.split(",").map((x) => x.trim()).filter(Boolean);
      }
    }
    return [s];
  }
  return [String(v)].map((x) => x.trim()).filter(Boolean);
}

function normalizeState(v) {
  if (!v) return null;
  const s = String(v).trim().toUpperCase();
  if (!USER_STATES.includes(s)) return null;
  return s;
}

function uniq(arr) {
  return Array.from(new Set((arr ?? []).map(String).map((x) => x.trim()).filter(Boolean)));
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
