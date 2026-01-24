// packages/authz/src/state.ts
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});

export async function resolveUserStateBySub(userId: string, tableName: string) {
  const res = await ddb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: `USER#${userId}` } },
    })
  );

  return res.Item?.state?.S || null;
}
