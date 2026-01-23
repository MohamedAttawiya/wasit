import {
  DynamoDBClient,
  BatchGetItemCommand,
} from "@aws-sdk/client-dynamodb";

export async function resolveCapabilities(
  groups: string[],
  tableName: string,
  ddb = new DynamoDBClient({})
): Promise<Set<string>> {
  if (!groups.length) return new Set();

  const keys = groups.map((g) => ({
    pk: { S: `GROUP#${g}` },
  }));

  const res = await ddb.send(
    new BatchGetItemCommand({
      RequestItems: {
        [tableName]: { Keys: keys },
      },
    })
  );

  const caps = new Set<string>();

  for (const item of res.Responses?.[tableName] ?? []) {
    for (const c of item.capabilities?.SS ?? []) {
      caps.add(c);
    }
  }

  return caps;
}
