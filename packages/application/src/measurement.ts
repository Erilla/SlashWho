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
  /**
   * Keeps the largest of durations timed elsewhere as `${field}Ms`, and the
   * label of the one that set it as `${field}Name`, by the same rule as
   * `time`'s longest call. For work only an upstream client can time, such as
   * a single request inside one gateway call. The label must be static, as
   * `time`'s is.
   */
  observeSlowest(field: string, value: number, label?: string): void;
  /** Adds to a counter, e.g. `rateLimitHits`. */
  increment(field: string, amount?: number): void;
  /** Sets a boolean flag, e.g. `runJoined`. */
  mark(field: string): void;
  /** Flat fields, ready to spread into a log record. */
  totals(): Readonly<Record<string, number | boolean | string>>;
};

export type MeasurementScopeOptions = {
  /**
   * How time is charged when timed calls overlap. `summed`, the default, adds
   * every call's own elapsed time to its bucket, so overlapping calls count
   * the same wall time more than once. `shared` splits each instant evenly
   * between the calls in progress at that instant, so the buckets together
   * never exceed the wall time the scope spanned; each call's own elapsed time
   * is then also summed as `${prefix}CallMs`, which keeps the mean per-call
   * duration readable. A scope that is only ever timed serially reads the
   * same either way.
   */
  overlapping?: "summed" | "shared";
};

type Frame = { charged: number };

export function createMeasurementScope(
  monotonic: () => number = () => performance.now(),
  options: MeasurementScopeOptions = {}
): MeasurementScope {
  const values = new Map<string, number>();
  const names = new Map<string, string>();
  const flags = new Set<string>();
  const shared = options.overlapping === "shared";
  // Shared mode only: the frames charging at this instant, and when the
  // elapsed time was last handed out between them.
  const charging = new Set<Frame>();
  const sharedTotals = new Map<string, number>();
  let chargedUntil = 0;

  const advance = (now: number) => {
    if (charging.size > 0) {
      const share = Math.max(0, now - chargedUntil) / charging.size;
      for (const frame of charging) frame.charged += share;
    }
    chargedUntil = now;
  };

  const add = (field: string, value: number) => {
    values.set(field, (values.get(field) ?? 0) + value);
  };

  const slowest = (field: string, value: number, label?: string) => {
    const maxField = `${field}Ms`;
    const previousMax = values.get(maxField);
    // Strictly greater, so a later call of equal duration does not steal
    // the name from the first call that reached the maximum.
    if (previousMax === undefined || value > previousMax) {
      values.set(maxField, value);
      if (label !== undefined) names.set(`${field}Name`, label);
    }
  };

  return {
    async time(prefix, work, label) {
      const startedAt = monotonic();
      const frame: Frame = { charged: 0 };
      if (shared) {
        advance(startedAt);
        charging.add(frame);
      }
      let excludedMs = 0;
      const excluded: ExcludeFromBucket = async (inner) => {
        const innerStartedAt = monotonic();
        if (shared) {
          advance(innerStartedAt);
          charging.delete(frame);
        }
        try {
          return await inner();
        } finally {
          const innerEndedAt = monotonic();
          excludedMs += Math.max(0, innerEndedAt - innerStartedAt);
          if (shared) {
            advance(innerEndedAt);
            charging.add(frame);
          }
        }
      };
      try {
        return await work(excluded);
      } finally {
        // finally, not a catch: a timed-out or failed upstream call is the
        // expensive case and must still contribute its duration.
        const endedAt = monotonic();
        const elapsed = Math.max(
          0,
          Math.round(endedAt - startedAt - excludedMs)
        );
        if (shared) {
          advance(endedAt);
          charging.delete(frame);
          sharedTotals.set(
            prefix,
            (sharedTotals.get(prefix) ?? 0) + frame.charged
          );
          add(`${prefix}CallMs`, elapsed);
        } else {
          add(`${prefix}Ms`, elapsed);
        }
        add(`${prefix}Calls`, 1);
        slowest(`${prefix}MaxCall`, elapsed, label);
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

    observeSlowest(field, value, label) {
      slowest(field, Math.max(0, Math.round(value)), label);
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
        // Rounded down, so the shared buckets together stay within the wall
        // time they were split from.
        ...Object.fromEntries(
          [...sharedTotals].map(([prefix, charged]) => [
            `${prefix}Ms`,
            Math.floor(charged)
          ])
        ),
        ...Object.fromEntries(names),
        ...Object.fromEntries([...flags].map((field) => [field, true]))
      };
    }
  };
}
