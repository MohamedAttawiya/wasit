import {
  DynamoDBClient,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";

export function createGrantResolver(
  principalUserId: string,
  tableName: string,
  ddb = new DynamoDBClient({})
) {
  const pk = `PRINCIPAL#USER#${principalUserId}`;

  async function has(resource: string, perm: string): Promise<boolean> {
    const sk = `RESOURCE#${resource}#PERM#${perm}`;

    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk AND #sk = :sk",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": { S: pk },
          ":sk": { S: sk },
        },
        Limit: 1,
      })
    );

    return (res.Count ?? 0) > 0;
  }

  return { has };
}
