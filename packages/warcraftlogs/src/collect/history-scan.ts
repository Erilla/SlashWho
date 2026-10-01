import {
  firstKillReports,
  hasMoreReportPages,
  lastReportCode,
  reportCodes,
  reportPageReach,
  reportSpans,
  type ReportSpan
} from "../decode/reports";
import type {
  WarcraftLogsLimitation,
  WarcraftLogsReportResult
} from "../types";
import type { CollectionRun } from "./context";
import { readHistoryPage } from "./history-page";
import { RECENT_REPORTS_MAX_PAGE } from "../queries";

/** What the character's own report history yielded, and where it stopped. */
export type HistoryScan = {
  readonly kind: "history_scan";
  /**
   * What the cleanly decoded history pages span, so a verified kill they
   * already account for is not searched for again in attendance.
   */
  readonly spans: readonly ReportSpan[];
  limitation: WarcraftLogsLimitation | undefined;
  omittedInvalidTimestamp: boolean;
  /**
   * A validated cursor survived the probe, so this run read only the pages
   * below it.
   */
  readonly resumedFromCursor: boolean;
  /**
   * Set only when the history itself ran out or reached the floor, which is
   * what separates a finished scan from one whose budget ran out after the
   * last page it proved.
   */
  readonly finished: boolean;
  readonly lastDecodedPage: number | undefined;
  readonly resumeBoundaryReportCode: string | undefined;
  readonly invalidatedStoredBoundary: boolean;
  readonly historyLimitReached: boolean;
};

/**
 * Pages through the character's report history, newest first, adding every
 * kill and wipe it decodes to the run. Returns a result instead of a scan only
 * when the resume probe itself fails, which ends the whole read.
 */
export async function scanHistory(
  run: CollectionRun
): Promise<HistoryScan | WarcraftLogsReportResult> {
  const { key, lookup, options, kills, wipes, scannedReportCodes } = run;
  const spans: ReportSpan[] = [];
  let limitation: WarcraftLogsLimitation | undefined;
  let omittedInvalidTimestamp = false;
  // A targeted search reads no history, so the history cursor is not its to
  // prove, resume or restart.
  let startPage = options.targetedOnly
    ? 1
    : (options.historyScanStartPage ?? 1);
  let lastDecodedPage: number | undefined;
  let invalidatedStoredBoundary = false;
  let resumeBoundaryReportCode = options.targetedOnly
    ? undefined
    : options.historyScanResumeBoundaryReportCode;
  const unsupportedCursor = startPage > RECENT_REPORTS_MAX_PAGE;
  if (unsupportedCursor) {
    startPage = 1;
    resumeBoundaryReportCode = undefined;
    invalidatedStoredBoundary = true;
  }
  // A run with no history budget -- a parse-only resume -- has no request to
  // spend proving a boundary it will not scan from.
  if (
    options.requestCap > 0 &&
    startPage > 1 &&
    resumeBoundaryReportCode !== undefined
  ) {
    // Page offsets are not stable when a report is uploaded (including a
    // backdated one). The final report code on the last proved page is an
    // anchor: any insertion above the resume point moves it. This probe is
    // a history request and therefore belongs to the same hard budget.
    const probe = await readHistoryPage(run, lookup, startPage - 1, false);
    run.historyRequests += 1;
    if (probe.kind !== "success") return probe;
    const decodedProbe = firstKillReports(probe.value, key);
    if (decodedProbe.kind === "limitation") return decodedProbe;
    if (decodedProbe.limitation) {
      return decodedProbe;
    }
    if (decodedProbe.omittedInvalidTimestamp) {
      omittedInvalidTimestamp = true;
    }
    // A cleanly decoded page, whatever it proves about the offset. Keeping
    // its evidence is what lets attendance skip its reports.
    for (const kill of decodedProbe.kills) kills.set(kill.fightUrl, kill);
    for (const wipe of decodedProbe.wipes) wipes.set(wipe.fightUrl, wipe);
    for (const code of reportCodes(probe.value)) scannedReportCodes.add(code);
    spans.push(
      ...reportSpans(
        probe.value,
        new Set(decodedProbe.omittedInvalidTimestampReportCodes)
      )
    );
    if (
      lastReportCode(probe.value) !==
      options.historyScanResumeBoundaryReportCode
    ) {
      startPage = 1;
      resumeBoundaryReportCode = undefined;
      invalidatedStoredBoundary = true;
    } else {
      // The probe proved this page, so it is where a run that reads nothing
      // new below it must resume -- not a reason to discard the cursor.
      lastDecodedPage = startPage - 1;
    }
  }
  const resumedFromCursor = startPage > 1 || unsupportedCursor;
  let historyLimitReached = false;
  let finished = false;
  for (let page = startPage; run.historyRequests < options.requestCap; page++) {
    const result = await readHistoryPage(run, lookup, page, true);
    run.historyRequests += 1;
    if (result.kind !== "success") {
      limitation = result;
      break;
    }

    const normalized = firstKillReports(result.value, key);
    if (normalized.kind === "limitation") {
      options.onLimitation?.("history_scan", normalized.code);
      limitation = normalized;
      break;
    }
    for (const kill of normalized.kills) {
      kills.set(kill.fightUrl, kill);
    }
    for (const wipe of normalized.wipes) {
      wipes.set(wipe.fightUrl, wipe);
    }
    if (normalized.omittedInvalidTimestamp) {
      omittedInvalidTimestamp = true;
    }
    if (normalized.limitation) {
      options.onLimitation?.("history_scan", normalized.limitation.code);
      limitation = normalized.limitation;
      break;
    }
    // A page with only invalid fight times still proves its report boundary.
    // Other schema drift stops before this point.
    for (const code of reportCodes(result.value)) {
      scannedReportCodes.add(code);
    }
    spans.push(
      ...reportSpans(
        result.value,
        new Set(normalized.omittedInvalidTimestampReportCodes)
      )
    );

    // Below every terminal tier, so any further page can only re-find
    // evidence already stored. This is a clean stop: it sets no limitation,
    // because a partial run would block the marks that allowed it.
    const floor = options.killScanFloor;
    if (floor !== undefined) {
      const reached = reportPageReach(result.value);
      // A page with nothing dated says nothing about how far back the scan
      // has reached, so it must not end it.
      if (reached.length > 0 && reached.every((at) => at < floor)) {
        finished = true;
        break;
      }
    }

    const hasMorePages = hasMoreReportPages(result.value);
    if (hasMorePages === null) {
      options.onLimitation?.("history_scan", "schema_drift");
      limitation = { kind: "limitation", code: "schema_drift" };
      break;
    }
    // A resume boundary is a fact about a fully decoded page, never about a
    // response that was unavailable or structurally suspect. It is safe to
    // carry this forward even if a later page is limited. An empty page has
    // no report to anchor on, so it leaves the cursor on the page before it:
    // advancing past it would save a page with no boundary, which the next
    // run cannot validate and so restarts from page one.
    const boundary = lastReportCode(result.value);
    if (boundary !== null) {
      resumeBoundaryReportCode = boundary;
      lastDecodedPage = page;
    }
    if (!hasMorePages) {
      finished = true;
      break;
    }
    if (page === RECENT_REPORTS_MAX_PAGE) {
      historyLimitReached = true;
      limitation = { kind: "limitation", code: "history_limit" };
      options.onLimitation?.("history_scan", limitation.code);
      break;
    }
    if (run.historyRequests === options.requestCap) {
      limitation = { kind: "limitation", code: "request_cap" };
    }
  }
  if (
    options.targetedOnly !== true &&
    limitation === undefined &&
    run.historyRequests === options.requestCap &&
    !finished
  ) {
    limitation = { kind: "limitation", code: "request_cap" };
  }
  return {
    kind: "history_scan",
    spans,
    limitation,
    omittedInvalidTimestamp,
    resumedFromCursor,
    finished,
    lastDecodedPage,
    resumeBoundaryReportCode,
    invalidatedStoredBoundary,
    historyLimitReached
  };
}
