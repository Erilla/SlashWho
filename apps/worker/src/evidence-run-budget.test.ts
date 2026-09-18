import { evidenceRunBudget } from "@slashwho/application";
import { expect, it } from "vitest";

import { loadWorkerConfig } from "./config";

// Deliberately the real defaults, read through `loadWorkerConfig`, not literals
// copied into this file. The failure this test exists to catch is a constant
// moving somewhere else and nothing noticing; hardcoding them here would
// reintroduce it one layer down.
const config = loadWorkerConfig({
  DATABASE_URL: "postgresql://slashwho:test@db/slashwho",
  BLIZZARD_CLIENT_ID: "worker-client-id",
  BLIZZARD_CLIENT_SECRET: "worker-client-secret",
  BLIZZARD_SWEEP_REQUEST_CAP: "300",
  WARCRAFT_LOGS_CLIENT_ID: "warcraft-logs-client-id",
  WARCRAFT_LOGS_CLIENT_SECRET: "warcraft-logs-client-secret",
  EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64)
});

function budgetFor(limitPerHour: number, credentials: "own" | "visitor") {
  return evidenceRunBudget({
    limitPerHour,
    credentials,
    requestCap: config.evidenceRequestCap,
    parseRequestCap: config.evidenceParseRequestCap,
    pointsReserve: config.evidencePointsReserve
  });
}

// The worker's own Warcraft Logs allowance, and a visitor's default. Both are
// upstream facts rather than settings of ours; the worker's moved from 9000 on
// 2026-09-17, which is the reason nothing here derives one from the other.
const WORKER_ALLOWANCE = 18_000;
const VISITOR_ALLOWANCE = 3_600;

it("holds the run budget arithmetic that the scan share comment states", () => {
  // Break caught: the arithmetic written into
  // MAXIMUM_SCAN_SHARE_OF_OWN_ALLOWANCE went stale within a day of being
  // written. It named a flat parse term of 48 requests, Railway stopped
  // overriding EVIDENCE_PARSE_REQUEST_CAP so the code default of 24 took over,
  // and the comment silently began describing a deployment that no longer
  // existed. Nothing failed, because a comment can only ask a human to redo
  // the sums.
  //
  // So they are evaluated here instead. If this test fails, a constant moved:
  // work out which, then update the table below AND the comment it mirrors.
  // Both, or the next reader is misled again.
  expect(budgetFor(WORKER_ALLOWANCE, "own")).toMatchObject({
    scanPages: 300,
    reservedPoints: 5_000,
    closes: false
  });
  expect(budgetFor(VISITOR_ALLOWANCE, "visitor")).toMatchObject({
    scanPages: 18,
    reservedPoints: 1_080,
    closes: true
  });

  const worker = budgetFor(WORKER_ALLOWANCE, "own");
  expect(Math.round(worker.parsePoints)).toBe(317);
  expect(Math.round(worker.worstCaseAtMeasuredCost)).toBe(6_317);
  expect(Math.round(worker.worstCaseAtAssumedCost)).toBe(9_317);

  const visitor = budgetFor(VISITOR_ALLOWANCE, "visitor");
  expect(Math.round(visitor.worstCaseAtMeasuredCost)).toBe(677);
  expect(Math.round(visitor.worstCaseAtAssumedCost)).toBe(857);
});

it("keeps the worker's scan reaching further than any run yet observed", () => {
  // Break caught: a share tight enough to close the worker's budget would cap
  // it at 145 pages, below the deepest scan already seen, and truncate
  // collections that currently finish. This is the claim that stops anyone
  // "fixing" `closes: false` above by lowering the share -- the two pull
  // against each other, and this is the side that was chosen.
  const DEEPEST_OBSERVED_SCAN_PAGES = 190;

  expect(budgetFor(WORKER_ALLOWANCE, "own").scanPages).toBeGreaterThan(
    DEEPEST_OBSERVED_SCAN_PAGES
  );
});

it("spends less of a visitor's allowance than of our own", () => {
  // The product decision, not an arithmetic one: a visitor's allowance is
  // theirs, and they supplied credentials to see one dossier rather than to
  // have their quota drained every window. Asserted as a relationship rather
  // than a number so retuning either share cannot quietly invert it.
  const asVisitor = budgetFor(VISITOR_ALLOWANCE, "visitor");
  const sameAllowanceAsOurs = budgetFor(VISITOR_ALLOWANCE, "own");

  expect(asVisitor.scanPages).toBeLessThan(sameAllowanceAsOurs.scanPages);
});

it("never hands a run a cap above the configured ceiling", () => {
  // Break caught: `effectiveRequestCap` may only ever lower the configured
  // value, the same contract `effectiveReserve` has. An account large enough
  // for the share to exceed the ceiling must still get the ceiling, or the
  // operator's lever stops being a lever.
  const enormous = budgetFor(10_000_000, "own");

  expect(enormous.scanPages).toBe(config.evidenceRequestCap);
});
