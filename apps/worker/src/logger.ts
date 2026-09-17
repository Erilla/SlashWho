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
  // Visitor-supplied upstream credentials. Unlike the web service, this
  // logger is a denylist, so a credential reaching a record is censored only
  // if its key is named here. No record is supposed to carry one -- the
  // evidence handler decrypts into a local and never spreads the run -- so
  // this is the backstop for a field added later, not the primary control.
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
    Object.entries(value).map(([key, item]) => {
      const normalized = key.toLowerCase().replaceAll(/[^a-z]/g, "");
      const isSensitive =
        sensitiveKeys.has(normalized) ||
        sensitiveKeySubstrings.some((substring) =>
          normalized.includes(substring)
        );
      return [key, isSensitive ? "[Redacted]" : sanitize(item, visited)];
    })
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
