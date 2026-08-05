import pino, { type DestinationStream, type Logger } from "pino";

const sensitivePaths = [
  "authorization",
  "cookie",
  "ownerId",
  "profileGuess",
  "validationName",
  "*.authorization",
  "*.cookie",
  "*.ownerId",
  "*.profileGuess",
  "*.validationName",
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "req.body",
  "request.body",
  "res.body",
  "response.body",
  "body"
];

const sensitiveKeys = new Set([
  "authorization",
  "cookie",
  "body",
  "ownerid",
  "profileguess",
  "validationname",
  "rawpayload",
  "rawupstreampayload"
]);

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value !== "object" || value === null || value instanceof Date) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKeys.has(key.toLowerCase().replaceAll(/[^a-z]/g, ""))
        ? "[Redacted]"
        : sanitize(item)
    ])
  );
}

export function createWorkerLogger(destination?: DestinationStream): Logger {
  const options = {
    base: undefined,
    formatters: {
      log(object: Record<string, unknown>) {
        return sanitize(object) as Record<string, unknown>;
      }
    },
    redact: {
      paths: sensitivePaths,
      censor: "[Redacted]"
    }
  };
  return destination ? pino(options, destination) : pino(options);
}
