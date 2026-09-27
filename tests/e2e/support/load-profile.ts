/**
 * Summaries for the dossier load profiler (#646, `pnpm profile:dossier`).
 * Kept apart from the Playwright spec so the arithmetic is unit tested.
 */

/**
 * One dossier load, every phase in milliseconds from navigation start. A phase
 * the load never reached is absent, never zero.
 */
export type LoadSample = Readonly<{
  /** The server shell's DOMContentLoaded. */
  shellMs: number;
  /**
   * The session check that held the first read back: `credentialHeadersForRequest`
   * confirms there is no account before sending keys saved in the browser.
   */
  sessionCheckStartMs?: number;
  sessionCheckEndMs?: number;
  /** The page asked for its first dossier read. */
  requestedMs?: number;
  /** That read's response headers arrived. */
  headersMs?: number;
  /** The first dossier API response the page received, fully read. */
  firstResponseMs: number;
  /** The connected-characters panel first in the DOM. */
  renderedMs: number;
  /**
   * When the worker published the evidence the load waited for, on the same
   * clock. Absent when the load gathered nothing.
   */
  publishedMs?: number;
  /** The first dossier response with no evidence still gathering. */
  settledMs?: number;
  /** The first dossier response's `Server-Timing` durations. */
  server: Readonly<Record<string, number>>;
  /** How many reads of each kind the page made before it settled. */
  requests?: Readonly<Record<string, number>>;
  /** The shell's inline script started the first read before hydration (#684). */
  earlyRead: boolean;
  /** The first read carried provider keys saved in the browser. */
  keysSent: boolean;
}>;

export type Spread = Readonly<{ p50: number; p95: number; max: number }>;

export type LoadSummary = Readonly<{
  count: number;
  earlyReads: number;
  keysSent: number;
  phases: Readonly<Partial<Record<Phase, Spread>>>;
  server: Readonly<Record<string, Spread>>;
  requests: Readonly<Record<string, Spread>>;
}>;

const phases = [
  "shellMs",
  "sessionCheckStartMs",
  "sessionCheckEndMs",
  "requestedMs",
  "headersMs",
  "firstResponseMs",
  "renderedMs",
  "publishedMs",
  "settledMs",
  "settleLagMs"
] as const;
type Phase = (typeof phases)[number];

/**
 * A phase's value for one load. `settleLagMs` is derived: how long after the
 * publish the page showed it (#690), so only a load with both has one.
 */
function phaseValue(sample: LoadSample, phase: Phase): number | undefined {
  if (phase !== "settleLagMs") return sample[phase];
  return sample.settledMs === undefined || sample.publishedMs === undefined
    ? undefined
    : sample.settledMs - sample.publishedMs;
}

export function parseServerTiming(
  header: string | null
): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const entry of (header ?? "").split(",")) {
    const [name, ...parameters] = entry.trim().split(";");
    const duration = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("dur="));
    if (!name || duration === undefined) continue;
    const value = Number(duration.slice("dur=".length));
    if (Number.isFinite(value)) metrics[name] = value;
  }
  return metrics;
}

/** A fetch the page started before its first dossier read. */
export type PreludeFetch = Readonly<{
  path: string;
  startMs: number;
  endMs?: number;
}>;

/**
 * The session check a read with saved keys waits on: the last
 * `GET /api/account/session` to finish before the read started. The account
 * hook sends the same request, so which one is the check cannot be told from
 * the request; the check is the one the read starts straight after. An
 * anonymous read starts before either finishes, so it has none.
 */
export function findSessionCheck(
  prelude: readonly PreludeFetch[],
  requestedMs: number | undefined
): { startMs: number; endMs: number } | undefined {
  if (requestedMs === undefined) return undefined;
  let found: { startMs: number; endMs: number } | undefined;
  for (const { path, startMs, endMs } of prelude) {
    if (path !== "GET /api/account/session" || endMs === undefined) continue;
    if (endMs > requestedMs) continue;
    if (!found || endMs > found.endMs) found = { startMs, endMs };
  }
  return found;
}

/** Linear interpolation between ranks, as `analyze:performance` does. */
function percentile(sorted: readonly number[], target: number): number {
  const position = ((sorted.length - 1) * target) / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (
    sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
  );
}

function spread(values: readonly number[]): Spread | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    max: Math.round(sorted.at(-1)!)
  };
}

/** Each key's spread over the records that carry it. */
function spreadEach(
  records: readonly Readonly<Record<string, number>>[]
): Record<string, Spread> {
  const keys = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const spreads: Record<string, Spread> = {};
  for (const key of keys) {
    const result = spread(
      records.flatMap((record) =>
        record[key] === undefined ? [] : [record[key]]
      )
    );
    if (result) spreads[key] = result;
  }
  return spreads;
}

export function summariseLoads(samples: readonly LoadSample[]): LoadSummary {
  const phaseSpreads: Partial<Record<Phase, Spread>> = {};
  for (const phase of phases) {
    const values = samples.flatMap((sample) => {
      const value = phaseValue(sample, phase);
      return value === undefined ? [] : [value];
    });
    const result = spread(values);
    if (result) phaseSpreads[phase] = result;
  }
  return {
    count: samples.length,
    earlyReads: samples.filter((sample) => sample.earlyRead).length,
    keysSent: samples.filter((sample) => sample.keysSent).length,
    phases: phaseSpreads,
    server: spreadEach(samples.map((sample) => sample.server)),
    requests: spreadEach(samples.map((sample) => sample.requests ?? {}))
  };
}

function row(label: string, value: Spread): string {
  const cell = (name: string, amount: number) =>
    `${name} ${String(amount).padStart(7)}`;
  return `  ${label.padEnd(20)}  ${cell("p50", value.p50)}  ${cell("p95", value.p95)}  ${cell("max", value.max)}`;
}

/**
 * `databaseRttMs` is the round trip the latency proxy added to the web's
 * database connection (#685), or undefined when there was no proxy. It is
 * required, and printed on every summary, so runs made at different settings
 * cannot be compared by mistake.
 */
export function formatLoadSummary(
  scenario: string,
  summary: LoadSummary,
  options: Readonly<{ databaseRttMs: number | undefined }>
): string {
  const rtt =
    options.databaseRttMs === undefined
      ? "no injected database RTT"
      : `database RTT +${options.databaseRttMs} ms injected`;
  const lines = [`${scenario} (${summary.count} loads, ${rtt})`];
  for (const phase of phases) {
    const value = summary.phases[phase];
    if (value) lines.push(row(phase.slice(0, -"Ms".length), value));
  }
  for (const [metric, value] of Object.entries(summary.server)) {
    lines.push(row(`server ${metric}`, value));
  }
  for (const [kind, value] of Object.entries(summary.requests)) {
    lines.push(row(`reads ${kind}`, value));
  }
  const count = (label: string, amount: number) =>
    `  ${label.padEnd(20)}  ${amount} of ${summary.count} loads`;
  lines.push(count("early read fired", summary.earlyReads));
  lines.push(count("saved keys sent", summary.keysSent));
  return lines.join("\n");
}
