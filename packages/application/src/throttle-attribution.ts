import { AsyncLocalStorage } from "node:async_hooks";

import type { MeasurementScope } from "./measurement";

export type ThrottledProvider = "raiderio" | "blizzard" | "warcraftlogs";

/**
 * The identifier the unit of work's own record already carries, repeated on
 * the standalone `upstream_throttle` line so the two can be joined.
 */
export type ThrottleUnit = Readonly<
  { runId: string } | { correlationId: string }
>;

/**
 * Record field prefixes, matching the provider buckets the scopes already
 * time (`raiderIoMs`, `blizzardMs`, `warcraftLogsMs`).
 */
const fieldPrefix: Readonly<Record<ThrottledProvider, string>> = {
  raiderio: "raiderIo",
  blizzard: "blizzard",
  warcraftlogs: "warcraftLogs"
};

/**
 * Every field `recordThrottle` can add to a scope. Exported so the web
 * logger's allowlist can be checked against it rather than against a copy.
 */
export const throttleFields: readonly string[] = Object.values(
  fieldPrefix
).flatMap((prefix) => [`${prefix}Throttles`, `${prefix}RetryAfterMaxMs`]);

/**
 * The one piece of ambient state in the measurement path, and deliberately
 * narrow. Scopes are otherwise passed explicitly, but a throttle is detected
 * inside an upstream client that is a process-wide singleton and must never
 * receive a scope, so the unit of work it belongs to can only be recovered
 * from the async context the call is running in. Unlike a shared mutable
 * scope, async-local storage keeps concurrent units apart.
 *
 * The slot is opened by whoever dispatches the unit and filled by the unit
 * once it has created its scope, so a handler binds with one line instead of
 * running its whole body inside a callback.
 */
type Slot = { readonly unit: ThrottleUnit; scope: MeasurementScope | null };

const slots = new AsyncLocalStorage<Slot>();

/**
 * Runs `work` as `unit`: any upstream throttle it encounters names the unit
 * on its standalone line, and is counted on the scope `work` binds with
 * `bindThrottleScope`. The innermost enclosing unit wins.
 */
export function attributeThrottlesTo<T>(
  unit: ThrottleUnit,
  work: () => Promise<T>
): Promise<T> {
  return slots.run({ unit, scope: null }, work);
}

/**
 * Makes `scope` the one the enclosing unit's throttles are counted on. A
 * no-op outside any unit: the throttle line is then still emitted, without an
 * id, and nothing is counted.
 */
export function bindThrottleScope(scope: MeasurementScope): void {
  const slot = slots.getStore();
  if (slot) slot.scope = scope;
}

/**
 * Counts a throttle on the enclosing unit's scope and returns that unit, or
 * null when the call ran outside any attributed unit of work.
 */
export function recordThrottle(
  provider: ThrottledProvider,
  retryAfterMs: number | undefined
): ThrottleUnit | null {
  const slot = slots.getStore();
  if (!slot) return null;
  const prefix = fieldPrefix[provider];
  slot.scope?.increment(`${prefix}Throttles`);
  if (retryAfterMs !== undefined) {
    slot.scope?.observeMax(`${prefix}RetryAfterMaxMs`, retryAfterMs);
  }
  return slot.unit;
}

/**
 * The `upstream_throttle` log record for one throttled response, counting it
 * on the enclosing unit of work as a side effect. The line is kept alongside
 * the per-record counts because a throttle outside any unit would otherwise
 * be invisible; it carries the unit's id whenever there is one.
 */
export function upstreamThrottleRecord(
  provider: ThrottledProvider,
  event: Readonly<{ retryAfterMs: number | undefined }>
): Record<string, unknown> {
  const unit = recordThrottle(provider, event.retryAfterMs);
  return {
    event: "upstream_throttle",
    provider,
    retryAfterMs: event.retryAfterMs ?? null,
    ...unit
  };
}
