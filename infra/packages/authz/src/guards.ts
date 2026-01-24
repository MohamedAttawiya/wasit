import { ForbiddenError } from "./errors.js";

export function requireCapability(auth: any, cap: string) {
  if (!auth.capabilities.includes(cap)) {
    throw new ForbiddenError(`Missing capability: ${cap}`);
  }
}

export function can(auth: any, perm: string, resource?: string) {
  if (auth.capabilities.includes(perm)) return true;

  if (!resource) return false;

  return auth.grants.some(
    (g: any) => g.perm === perm && g.resource === resource
  );
}
