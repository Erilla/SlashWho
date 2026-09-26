import type { WarcraftLogsRateLimit } from "@slashwho/warcraftlogs";

/*
 * A run's Warcraft Logs points budget: the reserve admission holds back, the
 * scan cap scaled to whose allowance the run spends, and the arithmetic that
 * says whether the two close. The worker's `evidence-run-budget.test.ts`
 * evaluates it against the real configured defaults.
 */

export function remainingPoints(budget: WarcraftLogsRateLimit): number {
  return budget.limitPerHour - budget.pointsSpentThisHour;
}

/**
 * The configured reserve is sized for the worker's own allowance, but a run may
 * carry a visitor's credentials, and their account's limit is its own -- 3600
 * by default against the worker's 18000. Applied flat, a worker-sized reserve
 * fences off a visitor's entire budget and refuses every run they could make.
 * Capping it at a share of the *reported* allowance keeps the intent -- leave
 * room for roughly one more run -- at any account size, and can only lower the
 * configured value, never raise it.
 *
 * The share is 0.3 because 0.1 was quietly deciding the reserve. At the
 * worker's 18000 it clipped any configured value to 1800, and #295 measured a
 * real collection at up to 2906 points: a 1800 ceiling cannot express "leave
 * room for one more run" when one more run costs that much. 0.3 of 18000 is
 * 5400, so the measured 3500 default reaches the gate intact, and a visitor's
 * 3600 account keeps a 1080 reserve -- which the same measurement says is
 * about the least a collection can cost.
 */
const MAXIMUM_RESERVE_SHARE_OF_ALLOWANCE = 0.3;

function effectiveReserve(limitPerHour: number, configured: number): number {
  return Math.min(
    configured,
    limitPerHour * MAXIMUM_RESERVE_SHARE_OF_ALLOWANCE
  );
}

/**
 * Whether the allowance is too low for a run to start.
 *
 * A reserve of 0 is off, not "refuse once nothing remains": spend overruns the
 * limit (9058.65 against 9000 was observed), so the remaining-points reading
 * goes negative and a bare comparison would gate hardest exactly when it was
 * asked to stop.
 */
export function belowReserve(
  budget: WarcraftLogsRateLimit,
  pointsReserve: number
): boolean {
  return (
    pointsReserve > 0 &&
    remainingPoints(budget) <
      effectiveReserve(budget.limitPerHour, pointsReserve)
  );
}

/**
 * The history scan is what a run mostly spends its points on, and the request
 * cap is a flat page count applied to whichever account the run carries -- the
 * gap `effectiveReserve` already closes for the reserve, left open on the knob
 * that decides what a *started* run costs (#320).
 *
 * The scan's share of a run was measured on 2026-09-18: 58-89% of spend, and
 * all of the variance, since fight parses sit at a near-constant 33-43 requests
 * against their own cap while the scan ranges from 32 to 190 pages. A visitor's
 * 3600 allowance against a flat 500 means one run may plan a scan several times
 * their whole hourly budget.
 *
 * A BACKSTOP, NOT A GUARANTEE. It bounds one run's share of an allowance; it
 * does not promise the run finishes.
 *
 * That is worth the arithmetic, because this constant and
 * MAXIMUM_RESERVE_SHARE_OF_ALLOWANCE are the two halves of a run's budget and
 * they used to combine only in a reader's head. Admission guarantees a run
 * starts with at least `effectiveReserve` points left. A run may then spend
 * `cap * pointsPerPage` on the scan plus a flat parse term -- the parse cap in
 * requests at ~13 points each, which does not scale with the allowance at all.
 * At EVIDENCE_PARSE_REQUEST_CAP's default of 24 that term is ~317:
 *
 *   worker, 18000:  admission guarantees >=3500; cap 300 pages
 *                   worst run 300*20 + 317 = 6317, and 9317 at 30 a page
 *   visitor, 3600:  admission guarantees >=1080; cap  18 pages
 *                   worst run  18*20 + 317 =  677, and  857 at 30 a page
 *
 * The worker's does not close, by a wide margin. The visitor's does, at both
 * page costs -- but read that as an accident of the current numbers rather
 * than a property anything maintains. The parse term is flat, so it eats the
 * margin directly: at a parse cap of 48, which Railway ran as an override
 * until 2026-09-18, the visitor's worst run is 1174 against the same 1080 and
 * stops closing.
 *
 * Making the worker's close would mean 145 pages, below the deepest scan
 * already observed (190), truncating collections that currently finish. And
 * the reason is not arithmetic that can be rebalanced:
 * a deep character's history is ~3800 points of scan before a single parse,
 * which does not fit a 3600 allowance at any cap whatsoever. That case takes
 * more than one window by nature. An overrun already publishes partial, sets a
 * retry deadline and resumes, so it pays a deferral rather than losing work --
 * which is why bounding the share is the job here and completing the run is
 * not.
 *
 * These four lines are not the guard, only its explanation. The guard is
 * `evidence-run-budget.test.ts` in the worker, which computes the same
 * arithmetic from the real configured defaults and fails the build when any of
 * it moves -- the two shares, the page costs, or the parse cap, which is what
 * actually drifted first. If that test fails, fix the numbers here as well as
 * there: a comment nobody has to update is a comment that goes stale, which is
 * how this one came to describe a parse cap of 48 that had stopped being
 * deployed.
 */
const MAXIMUM_SCAN_SHARE_OF_OWN_ALLOWANCE = 0.5;

/**
 * The same bound on a visitor's allowance, which is theirs and not ours.
 *
 * This is a product decision, not a tuning constant. Spending the worker's
 * whole quota is a throughput choice we are entitled to make. Spending a
 * visitor's, repeatedly across windows until their character converges, is
 * spending someone else's resource -- and they supplied those credentials to
 * see one dossier, not to have their Warcraft Logs quota drained every hour.
 * So the slice is modest: 18 pages a run against a 3600 allowance, where our
 * own would take 60.
 *
 * THIS DOES NOT MERELY SLOW A VISITOR'S DOSSIER DOWN. Above the cap it does
 * not converge at all. A truncated scan raises a `request_cap` scan
 * limitation; `terminalTiersFrom` settles nothing when a scan limitation is
 * present; with nothing terminal `killScanFloorFrom` returns undefined; and
 * with no floor the next run starts at the newest report again and pages back
 * over the same 18 pages. At 10 reports a page that is the same 180 reports
 * forever, for any character with more than that.
 *
 * It is still an improvement on what it replaces -- a flat 500-page cap
 * exhausted a visitor's allowance around page 180 and was rate limited
 * mid-scan, so this trades failing expensively for failing cheaply -- but it
 * is not convergence, and the fix is not here. It is to narrow "a truncated
 * scan settles nothing" to "settles nothing below its stopping point": paging
 * is newest-first, so a raid whose kills all sit above the truncation point
 * was completely seen and is safe to mark. Tracked in #334.
 *
 * Keyed off whose credentials the run carries, never off how large the
 * allowance is. A small allowance only correlates with a visitor: the worker's
 * own tier moved from 9000 to 18000 inside a day on 2026-09-17, and a visitor
 * may hold a large account.
 */
const MAXIMUM_SCAN_SHARE_OF_VISITOR_ALLOWANCE = 0.15;

/**
 * Points per history-scan page, for converting that share into a page count.
 *
 * 30 is deliberately above the measurement, not equal to it. Two runs on
 * 2026-09-18 with identical zone and fight counts differed only in scan depth
 * -- 134 pages against 66, 2894 points against 1531 -- which solves directly to
 * about 20 a page with no model assumed. Dividing by the measured value would
 * make the share a floor rather than a ceiling: the cap is `share * limit / s`,
 * so the run spends `share * limit * (actual / assumed)`, and any page dearer
 * than the estimate spends *more* than the share, not less. A third run the
 * same evening does not fit a constant-cost model at all -- it implies a
 * negative fight cost -- so per-request costs are not uniform across
 * characters, and the divisor carries headroom for that.
 */
const HISTORY_SCAN_POINTS_PER_REQUEST = 30;

function effectiveRequestCap(
  limitPerHour: number,
  configured: number,
  credentials: "own" | "visitor"
): number {
  const share =
    credentials === "visitor"
      ? MAXIMUM_SCAN_SHARE_OF_VISITOR_ALLOWANCE
      : MAXIMUM_SCAN_SHARE_OF_OWN_ALLOWANCE;
  return Math.max(
    1,
    Math.min(
      configured,
      Math.floor((limitPerHour * share) / HISTORY_SCAN_POINTS_PER_REQUEST)
    )
  );
}

/**
 * What a page of report history actually cost, as opposed to what the cap
 * assumes. Solved directly from a matched pair on 2026-09-18: two runs with
 * identical zone and fight counts, 134 pages against 66, 2894 points against
 * 1531. Used for the optimistic end of a worst-case estimate; nothing sizes a
 * budget from it, for the reason on HISTORY_SCAN_POINTS_PER_REQUEST.
 */
const MEASURED_HISTORY_SCAN_POINTS_PER_REQUEST = 20;

/**
 * Points a fight-parse request costs, fitted across the runs that carry
 * per-query-type counters. Only the flat parse term uses it.
 */
const FIGHT_PARSE_POINTS_PER_REQUEST = 13.2;
/** Conservative upper estimate used when deriving a new parse-only cap. */
const FIGHT_PARSE_POINT_BOUND = 14;

export type EvidenceRunBudget = Readonly<{
  /** Pages of report history this run may scan. */
  scanPages: number;
  /** Points admission guarantees are still unspent when the run starts. */
  reservedPoints: number;
  /** The parse term, which does not scale with the allowance. */
  parsePoints: number;
  /** Worst-case run cost at the measured page cost, and at the assumed one. */
  worstCaseAtMeasuredCost: number;
  worstCaseAtAssumedCost: number;
  /**
   * Whether the worst case fits inside what admission guarantees, judged at
   * the assumed page cost. False is not a fault: see
   * MAXIMUM_SCAN_SHARE_OF_OWN_ALLOWANCE, which explains why closing the
   * worker's budget would truncate collections that currently finish.
   */
  closes: boolean;
}>;

/**
 * The whole of a run's points budget in one place, so the relationship between
 * the scan share, the reserve share and the flat parse term can be evaluated
 * rather than recited.
 *
 * On the handler's own path, not beside it: the scan cap a production run gets
 * comes from here. That is deliberate -- a model kept only for a test drifts
 * from the thing it models, which is the failure being guarded against -- but
 * it means a bug here is a production bug, so it takes the same parameters the
 * calculation actually uses and fabricates nothing. An earlier version built a
 * synthetic `WarcraftLogsRateLimit` to pass along, with `pointsSpentThisHour`
 * and `pointsResetInSeconds` invented as zero. Harmless while both helpers read
 * only `limitPerHour`, and a trap the moment either starts reading a field that
 * was never real.
 *
 * This exists because the arithmetic in MAXIMUM_SCAN_SHARE_OF_OWN_ALLOWANCE
 * went stale within a day of being written: it named a parse cap of 48 that
 * Railway stopped overriding, and nothing failed. A comment can only ask a
 * human to remember to redo it. `evidence-run-budget.test.ts` in the worker
 * evaluates this against the real configured defaults instead, so a constant
 * moving anywhere breaks the build.
 */
export function evidenceRunBudget(
  input: Readonly<{
    limitPerHour: number;
    credentials: "own" | "visitor";
    requestCap: number;
    parseRequestCap: number;
    pointsReserve: number;
    scanPages?: number;
  }>
): EvidenceRunBudget {
  const scanPages =
    input.scanPages ??
    effectiveRequestCap(
      input.limitPerHour,
      input.requestCap,
      input.credentials
    );
  const reservedPoints = effectiveReserve(
    input.limitPerHour,
    input.pointsReserve
  );
  const parsePoints = input.parseRequestCap * FIGHT_PARSE_POINTS_PER_REQUEST;
  const worstCaseAtAssumedCost =
    scanPages * HISTORY_SCAN_POINTS_PER_REQUEST + parsePoints;
  return {
    scanPages,
    reservedPoints,
    parsePoints,
    worstCaseAtMeasuredCost:
      scanPages * MEASURED_HISTORY_SCAN_POINTS_PER_REQUEST + parsePoints,
    worstCaseAtAssumedCost,
    closes: worstCaseAtAssumedCost <= reservedPoints
  };
}

export function parseOnlyRequestCap(
  input: Readonly<{
    limitPerHour: number;
    pointsReserve: number;
  }>
): number {
  const reservedPoints = effectiveReserve(
    input.limitPerHour,
    input.pointsReserve
  );
  return Math.max(1, Math.floor(reservedPoints / FIGHT_PARSE_POINT_BOUND));
}
