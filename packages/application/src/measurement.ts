/**
 * One unit of work's accumulated performance totals. A scope is deliberately a
 * plain accumulator with an injected clock rather than ambient context: this
 * codebase injects its clocks and observers everywhere else, and the service
 * containers are process-wide singletons, so an implicitly shared scope could
 * not attribute time to one request. The one exception is throttle
 * attribution (`throttle-attribution.ts`), which cannot be threaded through
 * the singleton clients and uses async-local storage for that reason.
 *
 * Field names are derived uniformly from a prefix so that no rename map is
 * needed here or in the analysis script.
 */
/**
 * Runs `inner` inside an enclosing `time` frame without charging its duration
 * to that frame's bucket. The only legitimate use is a callback an upstream
 * client invokes mid-request (Blizzard's profile-request observer, which writes
 * to the database), where the nested work cannot be hoisted out of the call.
 * Kept as a per-frame parameter rather than ambient state so concurrent timed
 * calls cannot interfere with one another.
 */
export type ExcludeFromBucket = <R>(inner: () => Promise<R>) => Promise<R>;

export type MeasurementScope = {
  /**
   * Times `work` against `prefix`, recording duration even when it throws.
   * An optional `label` names the individual call: the label of whichever
   * call turns out to be the longest is reported as `${prefix}MaxCallName`,
   * so an aggregate total can be attributed to the call that dominated it.
   * Labels must be static identifiers -- never derived from arguments --
   * because they reach the log records, which carry no request data.
   */
  time<T>(
    prefix: string,
    work: (excluded: ExcludeFromBucket) => Promise<T>,
    label?: string
  ): Promise<T>;
  /** Adds to a running total, e.g. `limiterWaitMs`. */
  observe(field: string, value: number): void;
  /** Keeps the largest value seen, e.g. `retryAfterMaxMs`. */
  observeMax(field: string, value: number): void;
  /** Adds to a counter, e.g. `rateLimitHits`. */
  increment(field: string, amount?: number): void;
  /** Sets a boolean flag, e.g. `runJoined`. */
  mark(field: string): void;
  /** Flat fields, ready to spread into a log record. */
  totals(): Readonly<Record<string, number | boolean | string>>;
};

export function createMeasurementScope(
  monotonic: () => number = () => performance.now()
): MeasurementScope {
  const values = new Map<string, number>();
  const names = new Map<string, string>();
  const flags = new Set<string>();

  const add = (field: string, value: number) => {
    values.set(field, (values.get(field) ?? 0) + value);
  };

  return {
    async time(prefix, work, label) {
      const startedAt = monotonic();
      let excludedMs = 0;
      const excluded: ExcludeFromBucket = async (inner) => {
        const innerStartedAt = monotonic();
        try {
          return await inner();
        } finally {
          excludedMs += Math.max(0, monotonic() - innerStartedAt);
        }
      };
      try {
        return await work(excluded);
      } finally {
        // finally, not a catch: a timed-out or failed upstream call is the
        // expensive case and must still contribute its duration.
        const elapsed = Math.max(
          0,
          Math.round(monotonic() - startedAt - excludedMs)
        );
        add(`${prefix}Ms`, elapsed);
        add(`${prefix}Calls`, 1);
        const maxField = `${prefix}MaxCallMs`;
        const previousMax = values.get(maxField);
        // Strictly greater, so a later call of equal duration does not steal
        // the name from the first call that reached the maximum.
        if (previousMax === undefined || elapsed > previousMax) {
          values.set(maxField, elapsed);
          if (label !== undefined) names.set(`${prefix}MaxCallName`, label);
        }
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
        ...Object.fromEntries(names),
        ...Object.fromEntries([...flags].map((field) => [field, true]))
      };
    }
  };
}
