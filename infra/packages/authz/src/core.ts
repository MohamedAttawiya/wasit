// packages/authz/src/core.ts

type JwtClaims = Record<string, any>;

export interface Principal {
  userId: string;     // Cognito "sub"
  email?: string;
  groups: string[];   // cognito:groups
  claims: JwtClaims;  // raw claims for debugging/extending
}

export class AuthzError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// Works with API Gateway HTTP API (v2) + HttpJwtAuthorizer
export function getPrincipal(event: any): Principal {
  const claims: JwtClaims =
    event?.requestContext?.authorizer?.jwt?.claims ??
    event?.requestContext?.authorizer?.claims ??
    {};

  const userId = String(claims.sub ?? "").trim();
  if (!userId) {
    throw new AuthzError(401, "UNAUTHENTICATED", "Missing JWT subject (sub).");
  }

  const email = claims.email ? String(claims.email) : undefined;
  const rawGroups = claims["cognito:groups"];
  const groups = normalizeGroups(rawGroups);

  return { userId, email, groups, claims };
}

function normalizeGroups(v: any): string[] {
  if (!v) return [];

  if (Array.isArray(v)) {
    return v.map(String).map((x) => x.trim()).filter(Boolean);
  }

  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];

    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) {
          return parsed.map(String).map((x) => x.trim()).filter(Boolean);
        }
      } catch {
        const inner = s.slice(1, -1).trim();
        if (!inner) return [];
        return inner.split(",").map((x) => x.trim()).filter(Boolean);
      }
    }

    if (s.includes(",")) {
      return s.split(",").map((x) => x.trim()).filter(Boolean);
    }

    return [s];
  }

  return [String(v)].map((x) => x.trim()).filter(Boolean);
}

// ---- group/role guards ----
export function hasGroup(principal: Principal, group: string): boolean {
  return principal.groups.includes(group);
}

export function requireGroup(principal: Principal, group: string): void {
  if (!hasGroup(principal, group)) {
    throw new AuthzError(403, "FORBIDDEN", `Requires group '${group}'.`);
  }
}

export function requireAnyGroup(principal: Principal, groups: string[]): void {
  for (const g of groups) {
    if (hasGroup(principal, g)) return;
  }
  throw new AuthzError(403, "FORBIDDEN", `Requires one of groups: ${groups.join(", ")}.`);
}

// ---- helper for Lambda responses ----
export function toHttpErrorResponse(err: any) {
  if (err instanceof AuthzError) {
    return {
      statusCode: err.statusCode,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: err.code, message: err.message }),
    };
  }
  return {
    statusCode: 500,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: "INTERNAL", message: "Internal server error" }),
  };
}
