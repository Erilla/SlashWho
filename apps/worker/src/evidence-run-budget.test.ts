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
    reservedPoints: 3_500,
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

// The sample EVIDENCE_POINTS_RESERVE was derived from, and -- the part that
// matters -- the configuration that sample was taken under. #295 set the
// reserve from measured run costs and was reopened within the hour, because
// EVIDENCE_PARSE_REQUEST_CAP then reverted from 48 to 24 and every measurement
// behind the number described a deployment that no longer existed. Nothing
// failed. That is the same shape as the divergence #295 was itself filed
// about, one level up: a value set once, with nothing forcing the second look.
//
// So the provenance is recorded here rather than only in the derivation
// comment on `evidencePointsReserve`, and the test below fails when the
// configuration moves out from under it. It deliberately does not model run
// cost: `worstCaseAtMeasuredCost` is a ceiling no run reaches (300 pages of
// scan nobody has), and the parse cap moves it by 5% while moving observed
// cost by nearly half. Only a measurement can settle the reserve, so what CI
// can usefully do is notice when the last one expired.
const RESERVE_SAMPLE = {
  // Eight runs between 22:15 and 22:56, two full cycles of four characters
  // with no looping and no failures. The first sample taken after #331, and so
  // the first that measures a healthy run rather than bounding a broken one.
  takenOn: "2026-09-18T22:15Z/PT41M",
  // What the runs in the sample were configured with. Either of these moving
  // invalidates the measurement.
  parseRequestCap: 24,
  scanPages: 300,
  // 814 820 1092 1092 1495 1633 2888 2906 -- mean 1593.
  observedMaximumRunPoints: 2_906
} as const;

it("expires the reserve's measurement when its configuration changes", () => {
  // Break caught: EVIDENCE_PARSE_REQUEST_CAP moving, as it did on 2026-09-18,
  // which silently invalidated the sample the reserve was derived from. If
  // this fails, do not edit RESERVE_SAMPLE to match -- take a fresh sample of
  // `pointsSpentByRun` under the new configuration, then update both this and
  // the derivation comment in config.ts.
  //
  // Raising the parse cap is the change most likely to trip this, and there is
  // a live argument for it: a matched pair at caps 48 and 24 over the same
  // character and scan cost 2047 and 1495 points for 36 and 13 fights, so the
  // scan is fixed overhead and a marginal fight is only ~24 points. Cheaper
  // per parse, dearer per run -- which is exactly why the reserve has to be
  // re-measured rather than reasoned about when it moves.
  expect(config.evidenceParseRequestCap).toBe(RESERVE_SAMPLE.parseRequestCap);
  expect(budgetFor(WORKER_ALLOWANCE, "own").scanPages).toBe(
    RESERVE_SAMPLE.scanPages
  );
});

it("keeps the reserve covering the costliest run yet measured", () => {
  // The reserve's whole job: a run admitted with this much left must be able
  // to finish. Below the observed maximum it admits runs that cannot, which is
  // what the old 1500 did on twelve of nineteen sampled runs.
  expect(config.evidencePointsReserve).toBeGreaterThanOrEqual(
    RESERVE_SAMPLE.observedMaximumRunPoints
  );
});
