type JwtClaims = Record<string, any>;

export interface Principal {
  userId: string;
  email?: string;
  groups: string[];
  claims: JwtClaims;
}

export function parsePrincipal(event: any): Principal {
  const claims =
    event?.requestContext?.authorizer?.jwt?.claims ??
    event?.requestContext?.authorizer?.claims ??
    {};

  const userId = String(claims.sub ?? "").trim();
  if (!userId) {
    throw new Error("Missing JWT sub");
  }

  const email = claims.email ? String(claims.email).toLowerCase() : undefined;
  const groups = normalizeGroups(claims["cognito:groups"]);

  return { userId, email, groups, claims };
}

function normalizeGroups(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(",").map((s) => s.trim());
  return [];
}
