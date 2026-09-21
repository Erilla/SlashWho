import pino, { type DestinationStream, type Logger } from "pino";

// This Set is the sole control keeping character names, realms, URLs,
// request bodies, and upstream payloads out of the logs. It is kept
// module-private and mutable; only a read-only view of it (below) is ever
// exported, so no consumer -- present or future -- can `.add`/`.delete` its
// way into changing what this service is willing to log.
const allowlist = new Set([
  "event",
  "correlationId",
  "endpoint",
  "status",
  "durationMs",
  "count",
  // The error class only. Messages, bodies, URLs, and payloads stay out by
  // construction: any field not named here is dropped before serialization.
  "errorName",
  // Performance totals. Integers and booleans only -- never identity.
  "raiderIoRankingsMs",
  "raiderIoRankingsCalls",
  "raiderIoRankingsMaxCallMs",
  "raiderIoRankingLogicalKeys",
  "raiderIoRankingPhysicalCalls",
  "raiderIoCharacterMs",
  "raiderIoCharacterCalls",
  "raiderIoCharacterMaxCallMs",
  "blizzardMs",
  "blizzardCalls",
  "blizzardMaxCallMs",
  "dbMs",
  "dbCalls",
  "dbMaxCallMs",
  // The `group.method` of the call that produced `dbMaxCallMs`. A string,
  // unlike every other performance field, but a static identifier built from
  // the repository property keys in `measuredRepositories` -- never from a
  // query argument -- so no character name, realm, or URL can arrive here.
  "dbMaxCallName",
  "limiterWaitMs",
  "runJoined",
  // upstream_throttle: a fixed literal from a closed provider set, and the
  // upstream's own Retry-After -- never user data.
  "provider",
  "retryAfterMs",
  "cacheHits",
  "cacheMisses",
  "cacheShared",
  "cacheFailures",
  "cacheCapacity"
]);

// Exported so the logger test can assert every listed field actually
// survives serialization, without the test's own list drifting from this
// allowlist (a typo here or there would otherwise pass silently). Typed as
// `ReadonlySet` -- not just a runtime freeze -- so an attempted mutation
// from outside this module is a compile error; `allowlistedLog` below reads
// from the same underlying `allowlist` instance, so there is only ever one
// source of truth.
export const allowedFields: ReadonlySet<string> = allowlist;

function allowlistedLog(
  value: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => allowlist.has(key))
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
