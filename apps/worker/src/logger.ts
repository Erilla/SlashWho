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
  "owner",
  "ownerid",
  "profile",
  "profileguess",
  "validationguess",
  "validationname",
  "rawurl",
  "rawpayload",
  "rawupstreampayload",
  "achievementid",
  "achievementids",
  "achievements",
  "achievementtimestamp",
  "completiontimestamp",
  "timestamps",
  "accesstoken",
  "refreshtoken",
  "token",
  "fingerprint",
  "fingerprintscore",
  "matchscore",
  "identicalpercent",
  "score"
]);

function sanitize(value: unknown, visited = new WeakSet<object>()): unknown {
  if (typeof value !== "object" || value === null || value instanceof Date) {
    return value;
  }
  if (visited.has(value)) return "[Circular]";
  visited.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, visited));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKeys.has(key.toLowerCase().replaceAll(/[^a-z]/g, ""))
        ? "[Redacted]"
        : sanitize(item, visited)
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
