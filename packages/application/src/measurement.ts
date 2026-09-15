/**
 * One unit of work's accumulated performance totals. A scope is deliberately a
 * plain accumulator with an injected clock rather than ambient context: this
 * codebase injects its clocks and observers everywhere else, and the service
 * containers are process-wide singletons, so an implicitly shared scope could
 * not attribute time to one request.
 *
 * Field names are derived uniformly from a prefix so that no rename map is
 * needed here or in the analysis script.
 */
export type MeasurementScope = {
  /** Times `work` against `prefix`, recording duration even when it throws. */
  time<T>(prefix: string, work: () => Promise<T>): Promise<T>;
  /** Adds to a running total, e.g. `limiterWaitMs`. */
  observe(field: string, value: number): void;
  /** Keeps the largest value seen, e.g. `retryAfterMaxMs`. */
  observeMax(field: string, value: number): void;
  /** Adds to a counter, e.g. `rateLimitHits`. */
  increment(field: string, amount?: number): void;
  /** Sets a boolean flag, e.g. `runJoined`. */
  mark(field: string): void;
  /** Flat fields, ready to spread into a log record. */
  totals(): Readonly<Record<string, number | boolean>>;
};

export function createMeasurementScope(
  monotonic: () => number = () => performance.now()
): MeasurementScope {
  const values = new Map<string, number>();
  const flags = new Set<string>();

  const add = (field: string, value: number) => {
    values.set(field, (values.get(field) ?? 0) + value);
  };

  return {
    async time(prefix, work) {
      const startedAt = monotonic();
      try {
        return await work();
      } finally {
        // finally, not a catch: a timed-out or failed upstream call is the
        // expensive case and must still contribute its duration.
        const elapsed = Math.max(0, Math.round(monotonic() - startedAt));
        add(`${prefix}Ms`, elapsed);
        add(`${prefix}Calls`, 1);
        const maxField = `${prefix}MaxCallMs`;
        values.set(maxField, Math.max(values.get(maxField) ?? 0, elapsed));
      }
    },

    observe(field, value) {
      add(field, Math.max(0, Math.round(value)));
    },

    observeMax(field, value) {
      values.set(
        field,
        Math.max(values.get(field) ?? 0, Math.max(0, Math.round(value)))
      );
    },

    increment(field, amount = 1) {
      add(field, amount);
    },

    mark(field) {
      flags.add(field);
    },

    totals() {
      return {
        ...Object.fromEntries(values),
        ...Object.fromEntries([...flags].map((field) => [field, true]))
      };
    }
  };
}
