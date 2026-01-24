import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});

export async function resolveUserState(email: string, tableName: string) {
  const res = await ddb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: `USER#${email}` } },
    })
  );

  return res.Item?.state?.S || null;
}
