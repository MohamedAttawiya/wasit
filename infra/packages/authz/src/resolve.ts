import {
  resolvePrincipalOptional,
  resolvePrincipalRequired,
} from "./principal.js";
import { resolveUserStateBySub } from "./state.js";
import { resolveCapabilities } from "./capabilities.js";
import { resolveGrants } from "./grants.js";
import { ForbiddenError } from "./errors.js";

type Opts = {
  usersStateTable: string;
  authzCapabilitiesTable: string;
  authzGrantsTable: string;
};

async function resolve(principal: any, opts: Opts) {

const state = principal
  ? await resolveUserStateBySub(principal.userId, opts.usersStateTable)
  : null;

  const capabilities = principal
    ? await resolveCapabilities(principal.groups, opts.authzCapabilitiesTable)
    : [];

  const grants = principal
    ? await resolveGrants(principal.userId, opts.authzGrantsTable)
    : [];

  return {
    principal,
    state,
    capabilities,
    grants,
  };
}

export async function resolveAuthContextOptional(event: any, opts: Opts) {
  const principal = await resolvePrincipalOptional(event);
  return resolve(principal, opts);
}

export async function resolveAuthContextRequired(event: any, opts: Opts) {
  const principal = await resolvePrincipalRequired(event);
  const ctx = await resolve(principal, opts);

  if (ctx.state !== "ACTIVE") {
    throw new ForbiddenError("User not active");
  }

  return ctx;
}
