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
  /** The page asked for its first dossier read. */
  requestedMs?: number;
  /** That read's response headers arrived. */
  headersMs?: number;
  /** The first dossier API response the page received, fully read. */
  firstResponseMs: number;
  /** The connected-characters panel first in the DOM. */
  renderedMs: number;
  /** The first dossier response with no evidence still gathering. */
  settledMs?: number;
  /** The first dossier response's `Server-Timing` durations. */
  server: Readonly<Record<string, number>>;
}>;

export type Spread = Readonly<{ p50: number; p95: number; max: number }>;

export type LoadSummary = Readonly<{
  count: number;
  phases: Readonly<Partial<Record<Phase, Spread>>>;
  server: Readonly<Record<string, Spread>>;
}>;

const phases = [
  "shellMs",
  "requestedMs",
  "headersMs",
  "firstResponseMs",
  "renderedMs",
  "settledMs"
] as const;
type Phase = (typeof phases)[number];

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

export function summariseLoads(samples: readonly LoadSample[]): LoadSummary {
  const phaseSpreads: Partial<Record<Phase, Spread>> = {};
  for (const phase of phases) {
    const values = samples.flatMap((sample) =>
      sample[phase] === undefined ? [] : [sample[phase]]
    );
    const result = spread(values);
    if (result) phaseSpreads[phase] = result;
  }
  const metrics = [
    ...new Set(samples.flatMap((sample) => Object.keys(sample.server)))
  ];
  const server: Record<string, Spread> = {};
  for (const metric of metrics) {
    const result = spread(
      samples.flatMap((sample) =>
        sample.server[metric] === undefined ? [] : [sample.server[metric]]
      )
    );
    if (result) server[metric] = result;
  }
  return { count: samples.length, phases: phaseSpreads, server };
}

function row(label: string, value: Spread): string {
  const cell = (name: string, amount: number) =>
    `${name} ${String(amount).padStart(7)}`;
  return `  ${label.padEnd(20)}  ${cell("p50", value.p50)}  ${cell("p95", value.p95)}  ${cell("max", value.max)}`;
}

export function formatLoadSummary(
  scenario: string,
  summary: LoadSummary
): string {
  const lines = [`${scenario} (${summary.count} loads)`];
  for (const phase of phases) {
    const value = summary.phases[phase];
    if (value) lines.push(row(phase.slice(0, -"Ms".length), value));
  }
  for (const [metric, value] of Object.entries(summary.server)) {
    lines.push(row(`server ${metric}`, value));
  }
  return lines.join("\n");
}
