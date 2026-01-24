import { verifyAccessToken } from "./verify.js";
import { UnauthorizedError } from "./errors.js";

export type Principal = {
  userId: string;
  email?: string;
  groups: string[];
  claims: Record<string, any>;
};

function extractBearer(event: any): string | null {
  const h = event?.headers?.authorization || event?.headers?.Authorization;
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m?.[1] || null;
}

export async function resolvePrincipalOptional(event: any): Promise<Principal | null> {
  const token = extractBearer(event);
  if (!token) return null;

  const claims = await verifyAccessToken(token);

  return {
    userId: claims.sub,
    email: claims.email?.toLowerCase(),
    groups: claims["cognito:groups"] || [],
    claims,
  };
}

export async function resolvePrincipalRequired(event: any): Promise<Principal> {
  const principal = await resolvePrincipalOptional(event);
  if (!principal) throw new UnauthorizedError("Missing or invalid token");
  return principal;
}
