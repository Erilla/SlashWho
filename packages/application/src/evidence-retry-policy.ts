/**
 * Whether a failed evidence attempt earns another one.
 *
 * `collect-character-evidence` carries a flat `retryLimit: 4`, and the handler
 * used to rethrow everything it caught, so the queue could not tell a
 * transient fault from a deterministic one and gave both four more attempts.
 * #292: one run, five attempts, the same throw each time, ~8,600 Warcraft Logs
 * points spent and nothing published.
 *
 * pg-boss has no per-job "do not retry" lever, so the only sound way to end a
 * job early is for the handler not to throw. This module is the decision it
 * applies -- pure, so the whole policy is testable without a queue, a gateway
 * or a database.
 */

/** What kind of fault this is, as far as another attempt is concerned. */
export type EvidenceFailureClassification =
  /** Our own admission refusal. Deliberate, delayed, and spends nothing. */
  | "points_budget_refusal"
  /** A graceful shutdown or a cancelled run. */
  | "cancelled"
  /** A fault that plausibly resolves on its own: connections, timeouts. */
  | "transient"
  /** The same input will throw the same way: constraints, programming errors. */
  | "deterministic"
  /** Nothing recognised it. */
  | "unclassified";

export type EvidenceRetryReason =
  | "retryable"
  | "cancelled"
  | "deterministic"
  | "cost_veto"
  | "attempts_exhausted"
  | "unclassified_exhausted";

export type EvidenceRetryDecision = Readonly<{
  action: "retry" | "stop";
  reason: EvidenceRetryReason;
}>;

/**
 * SQLSTATE classes that describe the connection rather than the statement.
 * 08 connection exception, 53 insufficient resources, 57 operator
 * intervention (`57P01` is what a Postgres restart sends a live client).
 */
const TRANSIENT_SQLSTATE_CLASSES = new Set(["08", "53", "57"]);

/** 23 is integrity constraint violation: the same rows violate it again. */
const DETERMINISTIC_SQLSTATE_CLASS = "23";

/** Node's socket-level failures, which arrive as an errno-shaped `code`. */
const TRANSIENT_ERRNO_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND"
]);

/**
 * Thrown by code, not by data: a violated invariant or a bad argument. These
 * are the shapes #290 arrived in (`RangeError`, from a publication guard).
 */
const DETERMINISTIC_ERROR_NAMES = new Set([
  "RangeError",
  "TypeError",
  "SyntaxError",
  "ReferenceError"
]);

/**
 * A code-authored identifier, the same shape `errorFields` records. A guard in
 * this codebase throws `new Error("character_evidence_publication_invalid")`,
 * and a message of that shape is a decision we made about the input rather
 * than something that happened to the transport.
 */
const AUTHORED_CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function codeOf(error: unknown): string | null {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === "string" ? value : null;
}

/**
 * Reads the raw error rather than the redacted `errorFields` pair: an errno
 * like `ECONNRESET` is deliberately not a loggable code, and classification
 * happens in process where that constraint does not apply. Nothing read here
 * reaches a log record.
 */
export function classifyEvidenceFailure(
  error: unknown,
  options: { aborted: boolean }
): EvidenceFailureClassification {
  if (options.aborted) return "cancelled";

  const code = codeOf(error);
  if (code === "points_budget_low") return "points_budget_refusal";
  if (code !== null) {
    if (TRANSIENT_ERRNO_CODES.has(code)) return "transient";
    // SQLSTATE is five characters, of which only the two-character class is
    // reliably numeric: `57P01` is what a Postgres restart sends.
    if (/^\d{2}[0-9A-Z]{3}$/.test(code)) {
      const sqlStateClass = code.slice(0, 2);
      if (TRANSIENT_SQLSTATE_CLASSES.has(sqlStateClass)) return "transient";
      if (sqlStateClass === DETERMINISTIC_SQLSTATE_CLASS)
        return "deterministic";
    }
  }

  if (error instanceof Error) {
    if (DETERMINISTIC_ERROR_NAMES.has(error.constructor?.name ?? error.name)) {
      return "deterministic";
    }
    if (AUTHORED_CODE_PATTERN.test(error.message)) return "deterministic";
  }

  return "unclassified";
}

export type EvidenceRetryInput = Readonly<{
  classification: EvidenceFailureClassification;
  /** 1-based, as `DiscoveryWorkContext` reports it. */
  attempt: number;
  maxAttempts: number;
  /** Points this attempt spent, or null when the measurement itself failed. */
  pointsSpent: number | null;
  /** Whether this attempt got as far as asking Warcraft Logs for history. */
  collectionBegan: boolean;
  /** `EVIDENCE_RETRY_COST_CEILING`; 0 disables the veto. */
  costCeiling: number;
}>;

/**
 * A retry that repeats a 2,500-point collection is not comparable to one that
 * repeats a cheap request, so cost vetoes a retry the classification would
 * otherwise allow.
 *
 * Unmeasured spend counts as expensive once collection began. If we cannot
 * tell what an attempt cost and we know it ran a scan, assuming it was cheap
 * is the assumption that produced #292.
 */
function tooExpensiveToRepeat(input: EvidenceRetryInput): boolean {
  if (input.costCeiling <= 0) return false;
  if (input.pointsSpent === null) return input.collectionBegan;
  return input.pointsSpent > input.costCeiling;
}

export function evidenceRetryDecision(
  input: EvidenceRetryInput
): EvidenceRetryDecision {
  // Refused before collecting, carrying its own delay, having spent nothing.
  // The handler's own terminal-attempt handling is what ends this chain.
  if (input.classification === "points_budget_refusal") {
    return { action: "retry", reason: "retryable" };
  }
  // A graceful deploy is the definition of transient, and a staged collection
  // means the retry re-publishes rather than re-collects.
  if (input.classification === "cancelled") {
    return { action: "retry", reason: "cancelled" };
  }
  if (input.attempt >= input.maxAttempts) {
    return { action: "stop", reason: "attempts_exhausted" };
  }
  if (tooExpensiveToRepeat(input)) {
    return { action: "stop", reason: "cost_veto" };
  }
  if (input.classification === "deterministic") {
    return { action: "stop", reason: "deterministic" };
  }
  if (input.classification === "transient") {
    return { action: "retry", reason: "retryable" };
  }
  // Unclassified: one more attempt, because a second identical failure is
  // evidence of determinism and the first is not.
  return input.attempt <= 1
    ? { action: "retry", reason: "retryable" }
    : { action: "stop", reason: "unclassified_exhausted" };
}
