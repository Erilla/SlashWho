import pino, { type DestinationStream, type Logger } from "pino";

export type AllowlistLoggerOptions = Readonly<{
  /**
   * Field names kept by shape rather than by name, each matched against the
   * whole name. For families built from source-authored prefixes, such as a
   * measurement scope's totals, which no fixed list can keep up with.
   */
  patterns?: readonly RegExp[];
  /**
   * Applied to the fields that were kept. A kept field can still hold an
   * object, so this is where a denylist backstop over nested values goes.
   */
  sanitize?: (record: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Names the dropped fields in `droppedFields`, so a field missing from the
   * allowlist shows up in the logs instead of vanishing. Names only, never a
   * value: every caller builds its records from fixed keys.
   */
  reportDropped?: boolean;
}>;

/**
 * The record a logger built with `fields` writes: only the named fields, and
 * whatever `patterns` admits, then `sanitize`.
 */
export function allowlistedRecord(
  fields: ReadonlySet<string>,
  options: AllowlistLoggerOptions = {}
): (record: Record<string, unknown>) => Record<string, unknown> {
  const patterns = options.patterns ?? [];
  const allowed = (key: string) =>
    fields.has(key) || patterns.some((pattern) => pattern.test(key));
  return (record) => {
    const kept: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(record)) {
      if (allowed(key)) kept[key] = value;
      else dropped.push(key);
    }
    const sanitized = options.sanitize ? options.sanitize(kept) : kept;
    return options.reportDropped && dropped.length > 0
      ? { ...sanitized, droppedFields: dropped.sort() }
      : sanitized;
  };
}

/**
 * A pino logger that writes only allowlisted fields. The allowlist is the
 * control: a field not named is dropped before serialization, so a record
 * that gains a character name, a URL or a credential does not print it just
 * because nobody thought to deny it.
 */
export function createAllowlistLogger(
  fields: ReadonlySet<string>,
  destination?: DestinationStream,
  options: AllowlistLoggerOptions = {}
): Logger {
  const loggerOptions = {
    base: null,
    formatters: { log: allowlistedRecord(fields, options) }
  };
  return destination ? pino(loggerOptions, destination) : pino(loggerOptions);
}
