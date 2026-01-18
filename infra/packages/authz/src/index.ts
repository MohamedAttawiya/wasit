import {
  DynamoDBClient,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/client-dynamodb";

type JwtClaims = Record<string, any>;

export type WasitGroup = "GodAdmin" | "InternalOps" | "Seller";

export interface Principal {
  userId: string;     // Cognito "sub"
  email?: string;
  groups: string[];   // Cognito groups
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

// ---- principal extraction ----
// Works with API Gateway HTTP API (v2) + HttpJwtAuthorizer
export function getPrincipal(event: any): Principal {
  const claims: JwtClaims =
    event?.requestContext?.authorizer?.jwt?.claims ?? {};

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
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string") {
    // sometimes comes as "A,B" or '["A","B"]' depending on upstream
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const arr = JSON.parse(s);
        return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
      } catch {
        return [s];
      }
    }
    if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
    return [s];
  }
  return [String(v)];
}

// ---- group/role guards ----
export function hasGroup(principal: Principal, group: WasitGroup | string): boolean {
  return principal.groups.includes(group);
}

export function requireGroup(principal: Principal, group: WasitGroup | string): void {
  if (!hasGroup(principal, group)) {
    throw new AuthzError(
      403,
      "FORBIDDEN",
      `Requires group '${group}'.`
    );
  }
}

export function requireAnyGroup(principal: Principal, groups: (WasitGroup | string)[]): void {
  for (const g of groups) {
    if (hasGroup(principal, g)) return;
  }
  throw new AuthzError(
    403,
    "FORBIDDEN",
    `Requires one of groups: ${groups.join(", ")}.`
  );
}

// ---- ownership / grants checks ----
// Expected schema:
//   pk = PRINCIPAL#USER#<sub>
//   sk = RESOURCE#STORE#<storeId>#PERM#OWNER   (example)
// You can encode other permissions similarly.
export interface GrantsClientOptions {
  tableName: string;
  ddb?: DynamoDBClient;
}

export async function hasGrant(
  principal: Principal,
  resourceSkPrefix: string,
  opts: GrantsClientOptions
): Promise<boolean> {
  const ddb = opts.ddb ?? new DynamoDBClient({});

  const pk = `PRINCIPAL#USER#${principal.userId}`;

  const input: QueryCommandInput = {
    TableName: opts.tableName,
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
    ExpressionAttributeNames: {
      "#pk": "pk",
      "#sk": "sk",
    },
    ExpressionAttributeValues: {
      ":pk": { S: pk },
      ":sk": { S: resourceSkPrefix },
    },
    Limit: 1,
  };

  const res = await ddb.send(new QueryCommand(input));
  return (res.Count ?? 0) > 0;
}

// Convenience: exact “store owner” check
export async function requireStoreOwner(
  principal: Principal,
  storeId: string,
  opts: GrantsClientOptions
): Promise<void> {
  // you standardize store resource keys; this assumes: RESOURCE#STORE#<id>#PERM#OWNER
  const skPrefix = `RESOURCE#STORE#${storeId}#PERM#OWNER`;
  const ok = await hasGrant(principal, skPrefix, opts);

  // GodAdmin override is often useful
  if (ok || hasGroup(principal, "GodAdmin")) return;

  throw new AuthzError(
    403,
    "FORBIDDEN",
    `User does not own store '${storeId}'.`
  );
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
  // unknown error
  return {
    statusCode: 500,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: "INTERNAL", message: "Internal server error" }),
  };
}
