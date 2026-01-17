    "use strict";

const zlib = require("zlib");

/**
 * Firehose data transform Lambda
 * Event shape: https://docs.aws.amazon.com/firehose/latest/dev/data-transformation.html
 */

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function pickString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function normalizeLower(s, fallback) {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  return t ? t.toLowerCase() : fallback;
}

function coerceNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

exports.handler = async (event) => {
  const records = (event?.records || []).map((r) => {
    try {
      // r.data is base64-encoded gzipped JSON (CW Logs subscription payload)
      const gz = Buffer.from(r.data, "base64");
      const payloadStr = zlib.gunzipSync(gz).toString("utf8");
      const payload = JSON.parse(payloadStr);

      const logGroup = payload?.logGroup ?? null;
      const logStream = payload?.logStream ?? null;
      const owner = payload?.owner ?? null;
      const messageType = payload?.messageType ?? null;

      const events = Array.isArray(payload?.logEvents) ? payload.logEvents : [];

      let derivedEnv = null;
      let derivedService = null;

      const lines = [];

      for (const e of events) {
        const msgRaw = typeof e?.message === "string" ? e.message : "";

        // Try JSON parse the application log line
        const msgObj = safeJsonParse(msgRaw);

        // Promote standard fields if present
        const env = pickString(msgObj, ["env", "environment", "stage"]);
        const service = pickString(msgObj, ["service", "svc", "serviceName"]);
        const level = pickString(msgObj, ["level", "lvl", "severity"]);
        const correlationId = pickString(msgObj, [
          "correlationId",
          "correlation_id",
          "cid",
          "traceId",
          "trace_id",
          "requestId",
          "request_id",
        ]);

        // Choose timestamp: app ts/timestamp, else CloudWatch event timestamp
        const ts =
          coerceNumber(msgObj?.ts) ??
          coerceNumber(msgObj?.timestamp) ??
          coerceNumber(e?.timestamp) ??
          null;

        // Derive partitions opportunistically
        if (!derivedEnv && env) derivedEnv = env;
        if (!derivedService && service) derivedService = service;

        // Keep details compact: full JSON object as string when available
        // (Avoids Athena schema churn and keeps core columns small.)
        const details = msgObj ? JSON.stringify(msgObj) : null;

        const msg =
          msgObj
            ? (typeof msgObj.msg === "string" && msgObj.msg) ||
              (typeof msgObj.message === "string" && msgObj.message) ||
              null
            : (msgRaw || null);

        const row = {
          ts,
          env: env ?? null,
          service: service ?? null,
          level: level ?? null,
          correlationId: correlationId ?? null,
          msg,
          details,

          // CloudWatch context (useful for backtracking)
          cw: {
            messageType,
            owner,
            logGroup,
            logStream,
            id: e?.id ?? null,
            cwTimestamp: coerceNumber(e?.timestamp),
          },
        };

        lines.push(JSON.stringify(row));
      }

      // If no events, emit empty data but succeed (keeps Firehose happy)
      const ndjson = lines.length ? lines.join("\n") + "\n" : "";

    const pkEnv = normalizeLower(derivedEnv, process.env.DEFAULT_ENV || "dev");
      const pkService = normalizeLower(derivedService, "unknown");

      return {
        recordId: r.recordId,
        result: "Ok",
        data: Buffer.from(ndjson, "utf8").toString("base64"),
        metadata: {
          partitionKeys: {
            env: pkEnv,
            service: pkService,
          },
        },
      };
    } catch (err) {
      // Fail this record; Firehose will route to error prefix if configured
      return {
        recordId: r.recordId,
        result: "ProcessingFailed",
        data: r.data,
      };
    }
  });

  return { records };
};
