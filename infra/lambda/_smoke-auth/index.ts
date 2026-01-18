// Minimal smoke-test Lambda to verify @wasit/authz can be imported and used by other functions.
import { getPrincipal, requireGroup, toHttpErrorResponse } from "@wasit/authz";

const DEFAULT_REQUIRED_GROUP =
  process.env.SMOKE_GROUP && process.env.SMOKE_GROUP.trim()
    ? process.env.SMOKE_GROUP.trim()
    : "PlatformAdmin";

export async function handler(event: any) {
  try {
    const principal = getPrincipal(event);

    // Allow overriding via querystring for ad-hoc testing.
    const requestedGroup =
      event?.queryStringParameters?.requiredGroup ??
      event?.pathParameters?.requiredGroup ??
      DEFAULT_REQUIRED_GROUP;

    const requiredGroup = String(requestedGroup || "").trim() || DEFAULT_REQUIRED_GROUP;
    requireGroup(principal, requiredGroup);

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        userId: principal.userId,
        groups: principal.groups,
        requiredGroup,
      }),
    };
  } catch (err) {
    return toHttpErrorResponse(err);
  }
}
