export class UnauthorizedError extends Error {
  statusCode = 401;
}

export class ForbiddenError extends Error {
  statusCode = 403;
}

export function toHttpError(err: any) {
  if (err?.statusCode) {
    return {
      statusCode: err.statusCode,
      body: JSON.stringify({ error: err.message || "Access denied" }),
    };
  }

  return {
    statusCode: 500,
    body: JSON.stringify({ error: "Internal error" }),
  };
}
