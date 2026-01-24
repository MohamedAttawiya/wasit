// packages/authz/src/errors.ts

export class UnauthorizedError extends Error {
  statusCode = 401;
  name = "UnauthorizedError";
}

export class ForbiddenError extends Error {
  statusCode = 403;
  name = "ForbiddenError";
}

function looksLikeJwtError(err: any): boolean {
  const msg = String(err?.message ?? "").toLowerCase();
  const name = String(err?.name ?? "").toLowerCase();

  // aws-jwt-verify throws variants like JwtExpiredError, JwtInvalidSignatureError, etc.
  return (
    name.includes("jwt") ||
    msg.includes("jwt") ||
    msg.includes("token") ||
    msg.includes("signature") ||
    msg.includes("expired") ||
    msg.includes("invalid")
  );
}

export function toHttpError(err: any) {
  // If it’s one of ours
  if (err?.statusCode) {
    return {
      statusCode: err.statusCode,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: err.name, message: err.message }),
    };
  }

  // Treat verifier failures as 401 (not 500)
  if (looksLikeJwtError(err)) {
    return {
      statusCode: 401,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Unauthorized", message: "Invalid or expired token" }),
    };
  }

  return {
    statusCode: 500,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: "InternalError" }),
  };
}
