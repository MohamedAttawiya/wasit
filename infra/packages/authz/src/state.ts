import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

export async function resolveUserState(
  email: string,
  tableName: string,
  ddb = new DynamoDBClient({})
): Promise<string | null> {
  const res = await ddb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: `USER#${email}` } },
      ConsistentRead: true,
    })
  );

  return res.Item?.state?.S ?? null;
}
