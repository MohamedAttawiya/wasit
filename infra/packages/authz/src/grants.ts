// packages/authz/src/grants.ts

import {
  DynamoDBClient,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/client-dynamodb";

import { AuthzError, Principal, hasGroup } from "./core.js";

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
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
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
  const skPrefix = `RESOURCE#STORE#${storeId}#PERM#OWNER`;
  const ok = await hasGrant(principal, skPrefix, opts);

  // PlatformAdmin override (matches your actual system)
  if (ok || hasGroup(principal, "PlatformAdmin")) return;

  throw new AuthzError(403, "FORBIDDEN", `User does not own store '${storeId}'.`);
}
