import pino, { type DestinationStream, type Logger } from "pino";

const allowedFields = new Set([
  "event",
  "correlationId",
  "endpoint",
  "status",
  "durationMs",
  "count"
]);

function allowlistedLog(
  value: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => allowedFields.has(key))
  );
}

export function createWebLogger(destination?: DestinationStream): Logger {
  const options = {
    base: undefined,
    formatters: { log: allowlistedLog },
    redact: {
      paths: [
        "authorization",
        "cookie",
        "request.body",
        "response.body",
        "battleTag",
        "discordProfile",
        "profileGuess",
        "rawUpstreamBody"
      ],
      censor: "[Redacted]"
    }
  };
  return destination ? pino(options, destination) : pino(options);
}

export const webLogger =
  process.env.NODE_ENV === "test"
    ? pino({ enabled: false })
    : createWebLogger();
