/**
 * Reads captured SlashWho log lines on stdin and reports p50/p95/max for every
 * numeric field of one record type. The log stream is the only sink, so this
 * script is what makes the percentiles in
 * docs/research/2026-09-15-applicant-research-performance.md obtainable.
 *
 * Usage: cat capture.log | pnpm tsx scripts/analyze-performance-logs.mts <http_request|discovery_run|evidence_job|upstream_throttle>
 */

export type FieldSummary = { p50: number; p95: number; max: number };

/** One outcome's own count and field percentiles. */
export type OutcomeSummary = {
  count: number;
  fields: Record<string, FieldSummary>;
};

/** One endpoint's own count and field percentiles, split again by status. */
export type EndpointSummary = OutcomeSummary & {
  byStatus: Record<string, OutcomeSummary>;
};

export type PerformanceSummary = {
  event: string;
  count: number;
  fields: Record<string, FieldSummary>;
  outcomes: Record<string, number>;
  /**
   * Per-outcome breakdown of the same fields. A p95 computed across every
   * record mixes, say, `complete` with `not_claimed` and reports a number no
   * single outcome ever exhibits, which is exactly the misread this prevents.
   * Records with no `outcome` field contribute only to the overall summary.
   */
  byOutcome: Record<string, OutcomeSummary>;
  /**
   * The same breakdown for records that carry an `endpoint` (http_request),
   * which have no `outcome`. Without it a dossier read's p95 pools with an
   * account call's, and a 200 with a fast 500. Status nests inside endpoint so
   * each endpoint keeps its own total; records with no `status` count only at
   * the endpoint level.
   */
  byEndpoint: Record<string, EndpointSummary>;
  providers: Record<string, number>;
  /**
   * How often each repository call was the slowest one in a request. `dbMs`
   * on its own says a request spent a second in the database; this says which
   * call to look at first.
   */
  dbMaxCallNames: Record<string, number>;
  /**
   * How often each Warcraft Logs query kind was the slowest request in an
   * evidence run, the same attribution for `warcraftLogsMs`.
   */
  warcraftLogsMaxRequestNames: Record<string, number>;
};

/** A breakdown bucket: how many records joined it, and their numeric fields. */
type Group = { count: number; samples: Map<string, number[]> };

export function percentile(samples: readonly number[], target: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0]!;
  const position = ((sorted.length - 1) * target) / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return (
    sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
  );
}

export function summarize(
  lines: readonly string[],
  event: string
): PerformanceSummary {
  const samples = new Map<string, number[]>();
  const outcomeSamples = new Map<string, Map<string, number[]>>();
  const endpointGroups = new Map<
    string,
    Group & { byStatus: Map<string, Group> }
  >();
  const outcomes: Record<string, number> = {};
  const providers: Record<string, number> = {};
  const dbMaxCallNames: Record<string, number> = {};
  const warcraftLogsMaxRequestNames: Record<string, number> = {};
  let count = 0;

  const join = <G extends Group>(
    target: Map<string, G>,
    key: string,
    create: () => G
  ): G => {
    const group = target.get(key) ?? create();
    group.count += 1;
    target.set(key, group);
    return group;
  };

  const tally = (target: Record<string, number>, key: string) => {
    target[key] = (target[key] ?? 0) + 1;
  };

  const collect = (
    target: Map<string, number[]>,
    key: string,
    value: number
  ) => {
    const bucket = target.get(key) ?? [];
    bucket.push(value);
    target.set(key, bucket);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Captured streams interleave non-JSON platform output. Skip it.
      continue;
    }
    // Reject null, arrays, primitives, and other non-objects
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.event !== event) continue;
    count += 1;

    const outcome =
      typeof record.outcome === "string" ? record.outcome : undefined;
    let perOutcome: Map<string, number[]> | undefined;
    if (outcome !== undefined) {
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      perOutcome = outcomeSamples.get(outcome) ?? new Map();
      outcomeSamples.set(outcome, perOutcome);
    }

    const grouped: Map<string, number[]>[] = perOutcome ? [perOutcome] : [];
    if (typeof record.endpoint === "string") {
      const endpoint = join(endpointGroups, record.endpoint, () => ({
        count: 0,
        samples: new Map(),
        byStatus: new Map()
      }));
      grouped.push(endpoint.samples);
      if (typeof record.status === "number") {
        const status = join(endpoint.byStatus, String(record.status), () => ({
          count: 0,
          samples: new Map()
        }));
        grouped.push(status.samples);
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        collect(samples, key, value);
        for (const target of grouped) collect(target, key, value);
      }
    }
    if (typeof record.provider === "string") tally(providers, record.provider);
    if (typeof record.dbMaxCallName === "string") {
      tally(dbMaxCallNames, record.dbMaxCallName);
    }
    if (typeof record.warcraftLogsMaxRequestName === "string") {
      tally(warcraftLogsMaxRequestNames, record.warcraftLogsMaxRequestName);
    }
  }

  const summarizeFields = (
    collected: Map<string, number[]>
  ): Record<string, FieldSummary> => {
    const fields: Record<string, FieldSummary> = {};
    for (const [key, values] of collected) {
      fields[key] = {
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        max: Math.max(...values)
      };
    }
    return fields;
  };

  const byOutcome: Record<string, OutcomeSummary> = {};
  for (const [outcome, collected] of outcomeSamples) {
    byOutcome[outcome] = {
      count: outcomes[outcome] ?? 0,
      fields: summarizeFields(collected)
    };
  }

  const summarizeGroup = (group: Group): OutcomeSummary => ({
    count: group.count,
    fields: summarizeFields(group.samples)
  });

  const byEndpoint: Record<string, EndpointSummary> = {};
  for (const [endpoint, group] of endpointGroups) {
    const byStatus: Record<string, OutcomeSummary> = {};
    for (const [status, statusGroup] of group.byStatus) {
      byStatus[status] = summarizeGroup(statusGroup);
    }
    byEndpoint[endpoint] = { ...summarizeGroup(group), byStatus };
  }

  return {
    event,
    count,
    fields: summarizeFields(samples),
    outcomes,
    byOutcome,
    byEndpoint,
    providers,
    dbMaxCallNames,
    warcraftLogsMaxRequestNames
  };
}

async function main(): Promise<void> {
  const event = process.argv[2];
  if (!event) {
    process.stderr.write(
      "usage: analyze-performance-logs.mts <http_request|discovery_run|evidence_job|upstream_throttle>\n"
    );
    process.exitCode = 1;
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const summary = summarize(
    Buffer.concat(chunks).toString("utf8").split("\n"),
    event
  );

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("analyze-performance-logs.mts")) {
  await main();
}
