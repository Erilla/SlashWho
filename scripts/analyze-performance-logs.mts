/**
 * Reads captured SlashWho log lines on stdin and reports p50/p95/max for every
 * numeric field of one record type. The log stream is the only sink, so this
 * script is what makes the percentiles in
 * docs/research/2026-09-15-applicant-research-performance.md obtainable.
 *
 * Usage: cat capture.log | pnpm tsx scripts/analyze-performance-logs.mts <http_request|discovery_run|evidence_job|upstream_throttle>
 */

export type FieldSummary = { p50: number; p95: number; max: number };

export type PerformanceSummary = {
  event: string;
  count: number;
  fields: Record<string, FieldSummary>;
  outcomes: Record<string, number>;
  providers: Record<string, number>;
};

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
  const outcomes: Record<string, number> = {};
  const providers: Record<string, number> = {};
  let count = 0;

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

    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        const bucket = samples.get(key) ?? [];
        bucket.push(value);
        samples.set(key, bucket);
      }
    }
    if (typeof record.outcome === "string") {
      outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
    }
    if (typeof record.provider === "string") {
      providers[record.provider] = (providers[record.provider] ?? 0) + 1;
    }
  }

  const fields: Record<string, FieldSummary> = {};
  for (const [key, values] of samples) {
    fields[key] = {
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: Math.max(...values)
    };
  }

  return { event, count, fields, outcomes, providers };
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
