import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE = process.env.STORES_TABLE!;
const GSI = process.env.STORES_HOSTNAME_GSI!;

function normalizeHost(host: string) {
  const h = (host || "").toLowerCase().trim();
  const noPort = h.split(":")[0];
  return noPort.endsWith(".") ? noPort.slice(0, -1) : noPort;
}

function headerGet(headers: Record<string, any> | undefined, name: string): string {
  if (!headers) return "";
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return String(headers[k] ?? "");
  }
  return "";
}

function makeCorrelationId(event: any): string {
  const incoming = headerGet(event?.headers, "x-correlation-id");
  if (incoming) return incoming;
  try {
    return crypto.randomUUID();
  } catch {
    return `cid_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  }
}

function logJson(obj: Record<string, any>) {
  console.log(JSON.stringify(obj));
}

export const handler = async (event: any) => {
  const start = Date.now();
  const correlationId = makeCorrelationId(event);

  // Best-effort request id varies by trigger type
  const awsRequestId =
    String(event?.requestContext?.requestId ?? "") ||
    String(event?.requestContext?.http?.requestId ?? "") ||
    "";

  const rawHost =
    event.queryStringParameters?.host ||
    headerGet(event?.headers, "host") ||
    "";

  const hostname = normalizeHost(rawHost);

  logJson({
    level: "INFO",
    service: "tenant-service",
    msg: "request_start",
    correlationId,
    awsRequestId,
    rawHost,
    hostname,
    path: event?.rawPath || event?.path || "/resolve",
    method: event?.requestContext?.http?.method || event?.httpMethod || "GET",
  });

  if (!hostname) {
    const statusCode = 400;
    logJson({
      level: "WARN",
      service: "tenant-service",
      msg: "missing_host",
      correlationId,
      awsRequestId,
      statusCode,
      latencyMs: Date.now() - start,
    });

    return {
      statusCode,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify({ error: "missing host", correlationId }),
    };
  }

  try {
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
      const statusCode = 200;
      logJson({
        level: "INFO",
        service: "tenant-service",
        msg: "tenant_not_found",
        correlationId,
        awsRequestId,
        hostname,
        exists: false,
        statusCode,
        latencyMs: Date.now() - start,
      });

      return {
        statusCode,
        headers: {
          "content-type": "application/json",
          "x-correlation-id": correlationId,
        },
        body: JSON.stringify({ exists: false, hostname, correlationId }),
      };
    }

    const storeId = item.storeId;
    const status = item.status || "ACTIVE";

    const statusCode = 200;
    logJson({
      level: "INFO",
      service: "tenant-service",
      msg: "tenant_resolved",
      correlationId,
      awsRequestId,
      hostname,
      exists: true,
      storeId,
      status,
      statusCode,
      latencyMs: Date.now() - start,
    });

    return {
      statusCode,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify({ exists: true, hostname, storeId, status, correlationId }),
    };
  } catch (err: any) {
    logJson({
      level: "ERROR",
      service: "tenant-service",
      msg: "tenant_resolve_failed",
      correlationId,
      awsRequestId,
      hostname,
      error: String(err?.message || err),
      latencyMs: Date.now() - start,
    });

    return {
      statusCode: 500,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify({ error: "internal_error", correlationId }),
    };
  }
};
