import { PassThrough } from "node:stream";
import { expect, it } from "vitest";

import { createWebLogger } from "./logger";

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
  expect(captured).not.toContain("errorMessage");
  expect(captured).not.toContain(marker);
});

it("keeps the new performance fields", () => {
  const lines: string[] = [];
  const logger = createWebLogger({
    write: (line: string) => lines.push(line)
  } as never);

  logger.info({
    event: "http_request",
    correlationId: "c1",
    endpoint: "dossier",
    status: 200,
    durationMs: 100,
    raiderIoRankingsMs: 40,
    raiderIoRankingsCalls: 3,
    raiderIoRankingsMaxCallMs: 20,
    raiderIoCharacterMs: 10,
    raiderIoCharacterCalls: 1,
    raiderIoCharacterMaxCallMs: 10,
    blizzardMs: 15,
    blizzardCalls: 1,
    blizzardMaxCallMs: 15,
    dbMs: 8,
    dbCalls: 4,
    dbMaxCallMs: 5,
    limiterWaitMs: 12,
    rateLimitHits: 1,
    retryAfterMaxMs: 2_000,
    runJoined: true,
    cacheHits: 2,
    cacheMisses: 1,
    cacheShared: 0,
    cacheFailures: 0,
    cacheCapacity: 0
  });

  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(record).toMatchObject({
    raiderIoRankingsMs: 40,
    dbCalls: 4,
    limiterWaitMs: 12,
    rateLimitHits: 1,
    retryAfterMaxMs: 2_000,
    runJoined: true,
    cacheHits: 2
  });
});

it("still drops a field that is not allowlisted", () => {
  const lines: string[] = [];
  const logger = createWebLogger({
    write: (line: string) => lines.push(line)
  } as never);

  logger.info({ event: "http_request", characterName: "tester" });

  expect(JSON.parse(lines[0]!)).not.toHaveProperty("characterName");
});
