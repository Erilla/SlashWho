import { createAllowlistLogger, throttleFields } from "@slashwho/application";
import type { DestinationStream, Logger } from "pino";

// The fields a worker record may carry. Like the web service's, this is the
// primary control: a field not named here, or admitted by the measurement
// pattern below, is dropped before serialization, and its name is logged in
// `droppedFields` so a record that outgrows the list says so. The denylist
// further down is the backstop for a kept field that holds an object.
const allowlist = new Set([
  "event",
  "runId",
  "correlationId",
  "attempt",
  "outcome",
  "state",
  "phase",
  "reason",
  "status",
  "failure",
  "errorName",
  "errorCode",
  "durationMs",
  "queueWaitMs",
  // Process lifecycle.
  "signal",
  "port",
  // upstream_throttle: a closed provider set and the upstream's Retry-After.
  "provider",
  "retryAfterMs",
  // discovery_run names the root it researched, as it always has.
  "region",
  "realm",
  "name",
  "characterCount",
  "guildReadsDropped",
  "limitationCode",
  "fingerprintQueueWaitMs",
  "fingerprintReservedRequests",
  "fingerprintUsedRequests",
  "fingerprintDurationMs",
  // Fingerprint admission and reservation pressure.
  "blockedForMs",
  "committedRequests",
  "hourlyBudget",
  // evidence_job, whose shape is fixed up front so every field is present on
  // every record. `origin` is a closed class of reserving path (#708).
  "origin",
  "parseLimitationCode",
  "killCount",
  "raiderIoHistoricOutcome",
  "verifiedKillsSearched",
  "verifiedKillsSkippedEmpty",
  "attendanceRecoveredKills",
  "tierSearchRaidId",
  "tierSearchOutcome",
  "tierSearchRecoveredKills",
  "tierSearchRecoveredWipes",
  "terminalTierCount",
  "requestCapUsed",
  "parseRequestCapUsed",
  "pointsLimitPerHour",
  "pointsRemainingBefore",
  "pointsSpentByRun",
  "pointsRemainingAfter",
  "retryDecision",
  "retryReason",
  "stopDisposition",
  "limitationQuery",
  // The five-minute sweep: queue depths by queue name, and its counts.
  "queues",
  "resumed",
  "released",
  "republished",
  // The applicant watcher's poll and drain counts.
  "baseline",
  "rebaselined",
  "created",
  "backlog",
  "invalid",
  "truncated",
  "failures",
  "admitted",
  "suppressed",
  "deferred",
  // Maintenance cleanup counts.
  "removedEvidenceRuns",
  "removedCollectionStages",
  "removedRunCosts",
  // Character groups recompute and write (#738).
  "groupsRecomputed",
  "cycleCompleted",
  "cyclesCompleted",
  // character_groups_merged: a count of multi-member groups joined.
  "mergedGroups",
  "ungroupedAssigned",
  "unknownCharacters",
  // `write` or `recompute`: which part of a character groups write failed;
  // `publication` or `maintenance`: which recompute merged groups.
  "stage",
  // Webhook delivery failures name the alert, never the webhook.
  "alertEvent",
  // Measurement totals outside the provider-prefixed families below.
  "limiterWaitMs",
  "retryAfterMaxMs",
  "rateLimitHits",
  "runJoined",
  ...throttleFields
]);

/**
 * A measurement scope's totals: numbers, flags and the static label of the
 * slowest call, under a provider prefix authored in source. Named by shape
 * because the prefixes multiply -- one per timed call site and request class
 * -- and a list would always be one behind. A name ending in `Name` is kept
 * only as the slowest call's label, so a future `...CharacterName` is not.
 */
const measurementField =
  /^(blizzard|db|raiderIo|warcraftLogs)[A-Za-z]*(Ms|Calls|Requests|Limited|Throttles|Keys|MaxCallName|MaxRequestName)$/;

/** Exported so the logger test can pin the list rather than a copy of it. */
export const allowedFields: ReadonlySet<string> = allowlist;

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
  // Visitor-supplied upstream credentials. No record is supposed to carry
  // one -- the evidence handler decrypts into a local and never spreads the
  // run -- and the allowlist would drop the field anyway, so this is the
  // backstop for one nested inside a field that is kept.
  "clientid",
  "clientsecret",
  "accesskey",
  "apikey",
  "secret",
  "credential",
  "credentials",
  // Matching is exact on the normalized key, so the provider-prefixed names
  // the evidence run actually uses need naming in their own right.
  "wclclientid",
  "wclclientsecret",
  "wclclientidencrypted",
  "wclclientsecretencrypted",
  "fingerprint",
  "fingerprintscore",
  "matchscore",
  "identicalpercent",
  "score",
  "databaseurl"
]);

// Exact matching alone can never be robust against a provider-prefixed
// credential name (blizzardClientId, warcraftLogsClientSecret, a future
// raiderIoAccessKey, ...): the normalized key changes with every prefix, so
// each one would need its own entry above, forever one step behind whatever
// name gets added next. These substrings catch the credential-shaped
// concern generally, wherever it appears in a normalized key, while staying
// narrow enough not to catch unrelated fields such as providerName or
// correlationId.
const sensitiveKeySubstrings = [
  "clientid",
  "clientsecret",
  "accesskey",
  "apikey",
  "credential",
  "encryptionkey",
  "decryptionkey",
  // A webhook URL carries its secret in the path, so the whole value is a
  // credential however it is named.
  "webhook"
];

/**
 * The denylist backstop: every key above, at any depth, censored. Exported so
 * its coverage is tested directly; in the logger it runs over the fields the
 * allowlist kept, which is where a nested object can still carry one.
 */
export function redactSensitive(
  value: unknown,
  visited = new WeakSet<object>()
): unknown {
  if (typeof value !== "object" || value === null || value instanceof Date) {
    return value;
  }
  if (visited.has(value)) return "[Circular]";
  visited.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, visited));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const normalized = key.toLowerCase().replaceAll(/[^a-z]/g, "");
      const isSensitive =
        sensitiveKeys.has(normalized) ||
        sensitiveKeySubstrings.some((substring) =>
          normalized.includes(substring)
        );
      return [key, isSensitive ? "[Redacted]" : redactSensitive(item, visited)];
    })
  );
}

export function createWorkerLogger(destination?: DestinationStream): Logger {
  return createAllowlistLogger(allowlist, destination, {
    patterns: [measurementField],
    sanitize: (record) => redactSensitive(record) as Record<string, unknown>,
    reportDropped: true
  });
}
