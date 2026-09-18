/**
 * The observable part of a caught error, for a worker log record.
 *
 * An outcome of `unexpected_error` is not a cause. #290 lost eleven runs and
 * an hour's Warcraft Logs allowance to a single throw whose reason was nowhere
 * in the logs, because the record named the outcome and nothing else.
 *
 * What may be recorded is bounded by construction, because these records are
 * deliberately free of character names, realms, URLs and upstream payloads,
 * and an error message is unbounded text that can carry any of them.
 */
export type ErrorFields = Readonly<{
  errorName: string;
  errorCode: string | null;
}>;

/**
 * A code-authored identifier: a snake_case literal (`character_evidence_-
 * publication_invalid`, `evidence_points_budget_low`) or an all-digit SQLSTATE
 * (`23514`). Both shapes are closed sets written in source, not data.
 *
 * The underscore is the discriminator that makes this safe rather than merely
 * tidy: it admits every internal code in this codebase and excludes a bare
 * word, which is the shape a character name or realm would arrive in.
 */
const CODE_PATTERN = /^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[0-9]{1,10})$/;

function codeOf(value: unknown): string | null {
  return typeof value === "string" && CODE_PATTERN.test(value) ? value : null;
}

export function errorFields(error: unknown): ErrorFields {
  const name =
    error instanceof Error
      ? (error.constructor?.name ?? error.name)
      : typeof error;
  return {
    errorName: name.replaceAll(/[^A-Za-z0-9_]/g, "").slice(0, 64) || "unknown",
    // A driver's own code first: Postgres reports the cause as a SQLSTATE and
    // puts the offending row in the message, which is exactly the text this
    // must not carry.
    errorCode:
      error instanceof Error
        ? (codeOf((error as { code?: unknown }).code) ?? codeOf(error.message))
        : null
  };
}
