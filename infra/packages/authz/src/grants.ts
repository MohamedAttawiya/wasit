import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});

export async function resolveGrants(userId: string, table: string) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": { S: `PRINCIPAL#USER#${userId}` },
      },
    })
  );

  return (
    res.Items?.map((i) => ({
      resource: i.resource.S!,
      perm: i.perm.S!,
    })) || []
  );
}
