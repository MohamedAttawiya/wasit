import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE = process.env.STORES_TABLE!;
const GSI = process.env.STORES_HOSTNAME_GSI!;

function normalizeHost(host: string) {
  // lower, trim, strip port, strip trailing dot
  const h = (host || "").toLowerCase().trim();
  const noPort = h.split(":")[0];
  return noPort.endsWith(".") ? noPort.slice(0, -1) : noPort;
}

export const handler = async (event: any) => {
  try {
    const rawHost =
      event.queryStringParameters?.host ||
      event.headers?.host ||
      event.headers?.Host ||
      "";

    const hostname = normalizeHost(rawHost);

    if (!hostname) {
      return {
        statusCode: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "missing host" }),
      };
    }

    // Expect your META item to carry hostname + status, projected via ALL on the GSI
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: GSI,
        KeyConditionExpression: "#h = :h",
        ExpressionAttributeNames: { "#h": "hostname" },
        ExpressionAttributeValues: { ":h": hostname },
        Limit: 1,
      })
    );

    const item = res.Items?.[0];

    if (!item) {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ exists: false, hostname }),
      };
    }

    // You decide where status lives. This assumes your META row has status + storeId.
    const storeId = item.storeId;
    const status = item.status || "ACTIVE";

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exists: true, hostname, storeId, status }),
    };
  } catch (err: any) {
    console.error("tenant-resolve failed", err);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "internal_error" }),
    };
  }
};
