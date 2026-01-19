// infra/lambda/auth/postConfirmation.ts
import { AwsClient } from "aws4fetch";

const USERS_STATE_TABLE = process.env.USERS_STATE_TABLE;
if (!USERS_STATE_TABLE) throw new Error("Missing env USERS_STATE_TABLE");

const REGION =
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "eu-central-1";

const DDB_ENDPOINT = `https://dynamodb.${REGION}.amazonaws.com/`;

const ddb = new AwsClient({
  region: REGION,
  service: "dynamodb",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
});

export async function handler(event: any) {
  // Only act on confirmed signup (email verification completed)
  if (event?.triggerSource !== "PostConfirmation_ConfirmSignUp") {
    return event;
  }

  const emailRaw = event?.request?.userAttributes?.email;
  const email = normalizeEmail(emailRaw);
  if (!email) return event;

  // Create users_state row only if it does not already exist.
  await createUserStateIfMissing({
    email,
    state: "ACTIVE",
    actor: "cognito-signup",
    reason: "SELF_SIGNUP",
  });

  return event;
}

// pk = USER#<email>
function userStateKey(email: string) {
  return { pk: { S: `USER#${email}` } };
}

function normalizeEmail(v: any) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (!s.includes("@")) return null;
  return s;
}

async function ddbCall(target: string, payload: any) {
  const res = await ddb.fetch(DDB_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": target,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    const msg =
      data?.message || data?.__type || `DynamoDB error (${res.status})`;
    const e: any = new Error(msg);
    e.statusCode = 500;
    e.details = data ?? text;
    throw e;
  }

  return data ?? {};
}

async function createUserStateIfMissing({
  email,
  state,
  actor,
  reason,
}: {
  email: string;
  state: "ACTIVE" | "SUSPENDED" | "DISABLED";
  actor: string;
  reason: string;
}) {
  const now = new Date().toISOString();

  // Idempotent create: only create if pk doesn't exist.
  // IMPORTANT: Do NOT update existing rows here (admin state is authoritative).
  await ddbCall("DynamoDB_20120810.PutItem", {
    TableName: USERS_STATE_TABLE,
    Item: {
      ...userStateKey(email),
      email: { S: email },
      state: { S: state },
      createdAt: { S: now },
      updatedAt: { S: now },
      createdBy: { S: actor },
      updatedBy: { S: actor },
      lastReason: { S: reason },
    },
    ConditionExpression: "attribute_not_exists(#pk)",
    ExpressionAttributeNames: { "#pk": "pk" },
  }).catch((err: any) => {
    // ConditionalCheckFailed is expected if row already exists.
    const type = err?.details?.__type || "";
    if (String(type).includes("ConditionalCheckFailed")) return;
    throw err;
  });
}
