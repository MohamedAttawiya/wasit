import { parsePrincipal } from "./principal.js";
import { resolveUserState } from "./state.js";
import { resolveCapabilities } from "./capabilities.js";
import { createGrantResolver } from "./grants.js";

export interface ResolveAuthContextOptions {
  usersStateTable: string;
  authzGrantsTable: string;
  authzCapabilitiesTable: string;
}

export async function resolveAuthContext(
  event: any,
  opts: ResolveAuthContextOptions
) {
  const principal = parsePrincipal(event);

  const state = principal.email
    ? await resolveUserState(principal.email, opts.usersStateTable)
    : null;

  const capabilities = await resolveCapabilities(
    principal.groups,
    opts.authzCapabilitiesTable
  );

  const grants = createGrantResolver(
    principal.userId,
    opts.authzGrantsTable
  );

  return {
    principal,
    state,
    capabilities,
    grants,
  };
}
