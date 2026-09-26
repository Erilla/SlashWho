import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { allowedFields, createWebLogger } from "./logger";

// The base, non-performance fields already covered by the redaction test
// above -- excluded from the exhaustive performance-field sweep below.
const baseFields = new Set([
  "event",
  "correlationId",
  "endpoint",
  "status",
  "durationMs",
  "count",
  "errorName",
  "reason"
]);

// An explicit, independent literal of every performance field the brief
// requires. Independent of `allowedFields` on purpose: if this list is
// asserted directly against the exported allowlist's *contents* it can only
// ever be trivially in sync. Instead we assert their *sizes* match below, so
// a field dropped from (or a typo introduced into) the real allowlist changes
// its size relative to this literal and fails the test, while the explicit
// per-field logging below fails independently if that field never survives
// serialization.
const expectedPerformanceFields = [
  "raiderIoMs",
  "raiderIoCalls",
  "raiderIoMaxCallMs",
  "raiderIoRankingsMs",
  "raiderIoRankingsCalls",
  "raiderIoRankingsMaxCallMs",
  "raiderIoRankingLogicalKeys",
  "raiderIoRankingPhysicalCalls",
  "raiderIoCharacterMs",
  "raiderIoCharacterCalls",
  "raiderIoCharacterMaxCallMs",
  "blizzardMs",
  "blizzardCalls",
  "blizzardMaxCallMs",
  "dbMs",
  "dbCalls",
  "dbMaxCallMs",
  "dbMaxCallName",
  "limiterWaitMs",
  "runJoined",
  "provider",
  "retryAfterMs",
  "cacheHits",
  "cacheMisses",
  "cacheShared",
  "cacheFailures",
  "cacheCapacity"
];

it("logs only operational fields and redacts request and upstream secrets", async () => {
  // Break caught: HTTP diagnostics could persist credentials or private lookup data.
  const marker = "UNIQUE_WEB_PRIVATE_MARKER_f353d8";
  const output = new PassThrough();
  let captured = "";
  output.on("data", (chunk) => {
    captured += chunk.toString();
  });
  const logger = createWebLogger(output);

  logger.info({
    endpoint: "search",
    status: 202,
    durationMs: 12,
    count: 3,
    reason: "all_domains_fresh_terminal",
    errorName: "UpstreamReadError",
    errorMessage: marker,
    authorization: marker,
    cookie: marker,
    request: { body: { characterUrl: marker } },
    battleTag: marker,
    discordProfile: marker,
    profileGuess: marker,
    rawUpstreamBody: marker
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(captured).toContain('"endpoint":"search"');
  expect(captured).toContain('"status":202');
  expect(captured).toContain('"errorName":"UpstreamReadError"');
  expect(captured).toContain('"reason":"all_domains_fresh_terminal"');
  expect(captured).not.toContain("errorMessage");
  expect(captured).not.toContain(marker);
});

it("keeps every allowlisted performance field, with its exact value, through serialization", () => {
  // Break caught: the allowlist silently drops anything unnamed -- no error,
  // no warning. A typo in either the allowlist or the emitting code would
  // otherwise pass any test that only samples a few fields. This asserts the
  // allowlist has exactly the fields this test expects (catching a field
  // dropped from, or a typo introduced into, `allowedFields`), then logs
  // every one of those fields with a distinct sentinel value and asserts
  // each one survives serialization with that exact value.
  const allowlistedPerformanceFields = [...allowedFields].filter(
    (field) => !baseFields.has(field)
  );
  expect(allowlistedPerformanceFields.length).toBe(
    expectedPerformanceFields.length
  );
  for (const field of expectedPerformanceFields) {
    expect(allowedFields.has(field)).toBe(true);
  }

  const booleanFields = new Set(["runJoined"]);
  const stringFields = new Set(["provider", "dbMaxCallName"]);
  const record: Record<string, unknown> = {
    event: "http_request",
    correlationId: "c1",
    endpoint: "dossier",
    status: 200,
    durationMs: 100
  };
  const expected: Record<string, unknown> = {};
  expectedPerformanceFields.forEach((field, index) => {
    const value = booleanFields.has(field)
      ? true
      : stringFields.has(field)
        ? `sentinel-${index}`
        : 1_000 + index;
    record[field] = value;
    expected[field] = value;
  });

  const lines: string[] = [];
  const logger = createWebLogger({
    write: (line: string) => lines.push(line)
  } as never);

  logger.info(record);

  const serialized = JSON.parse(lines[0]!) as Record<string, unknown>;
  for (const [field, value] of Object.entries(expected)) {
    expect(serialized).toHaveProperty(field, value);
  }
});

it("still drops a field that is not allowlisted", () => {
  const lines: string[] = [];
  const logger = createWebLogger({
    write: (line: string) => lines.push(line)
  } as never);

  logger.info({ event: "http_request", characterName: "tester" });

  expect(JSON.parse(lines[0]!)).not.toHaveProperty("characterName");
});

it("allows the slowest-call name, which is a static method identifier", () => {
  // Break caught: the name is the one performance field that is a string, so
  // it is the only one that could carry request data if it were ever derived
  // from an argument rather than the repository method. Allowlisting it is
  // safe precisely because `measuredRepositories` builds it from `group` and
  // `method`; this asserts the allowlist lets the identifier through while a
  // neighbouring identity field is still dropped.
  const lines: string[] = [];
  const logger = createWebLogger({
    write: (line: string) => lines.push(line)
  } as never);

  logger.info({
    event: "http_request",
    dbMaxCallMs: 156,
    dbMaxCallName: "applicantSnapshots.getByCharacterKey",
    characterName: "tester"
  });

  const serialized = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(serialized).toHaveProperty(
    "dbMaxCallName",
    "applicantSnapshots.getByCharacterKey"
  );
  expect(serialized).not.toHaveProperty("characterName");
});

// Job handlers run only in the worker and log through the worker logger, so
// nothing they measure can reach an `http_request` record. Excluded by file,
// not by field name, so a new worker counter never tempts anyone into
// allowlisting a field the web path does not emit.
const workerOnlySources = new Set([
  "applicant-evidence-job-handler.ts",
  "discovery-job-handler.ts"
]);

function measurementSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return measurementSources(path);
    }
    return /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !workerOnlySources.has(entry.name)
      ? [path]
      : [];
  });
}

it("allowlists every measurement field a web request can emit", () => {
  // Break caught: a new `scope.time` prefix on the web path is dropped before
  // serialization with no error, so its timings silently vanish from
  // `http_request` records (#499). This scans the sources that measure web
  // requests for literal field names and asserts each is allowlisted. Names
  // built at runtime -- template literals, `cacheField` lookups -- and the
  // `<prefix>MaxCallName` label are not caught by the scan.
  const roots = ["../../../../packages/application/src", "../../src"].map(
    (relative) => fileURLToPath(new URL(relative, import.meta.url))
  );
  const call =
    /scope\??\.(time|observe|observeMax|increment|mark)\(\s*"([A-Za-z]+)"/g;
  const emitted = new Set<string>();
  for (const file of roots.flatMap(measurementSources)) {
    for (const [, method, name] of readFileSync(file, "utf8").matchAll(call)) {
      if (method !== "time") {
        emitted.add(name!);
      } else {
        emitted.add(`${name}Ms`);
        emitted.add(`${name}Calls`);
        emitted.add(`${name}MaxCallMs`);
      }
    }
  }

  // Guard against a vacuous pass: a broken path or regex would find nothing.
  expect(emitted).toContain("dbMs");
  expect(emitted).toContain("limiterWaitMs");
  expect([...emitted].filter((field) => !allowedFields.has(field))).toEqual([]);
});
