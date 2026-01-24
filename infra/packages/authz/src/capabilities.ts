import { DynamoDBClient, BatchGetItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});

export async function resolveCapabilities(groups: string[], table: string) {
  if (!groups.length) return [];

  const keys = groups.map((g) => ({
    pk: { S: `GROUP#${g}` },
  }));

  const res = await ddb.send(
    new BatchGetItemCommand({
      RequestItems: {
        [table]: {
          Keys: keys,
        },
      },
    })
  );

  const items = res.Responses?.[table] || [];

  const set = new Set<string>();
  for (const i of items) {
    for (const c of i.capabilities?.SS || []) {
      set.add(c);
    }
  }

  return [...set];
}
