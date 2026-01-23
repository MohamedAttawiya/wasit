export class AuthzError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function toHttpErrorResponse(err: any) {
  if (err instanceof AuthzError) {
    return {
      statusCode: err.statusCode,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: err.code, message: err.message }),
    };
  }

  return {
    statusCode: 500,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      error: "INTERNAL",
      message: "Internal server error",
    }),
  };
}
