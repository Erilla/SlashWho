/**
 * Which verified kills the run's own reads already account for. Pure: nothing
 * here issues a request. It stays with the gateway because it measures the
 * caller's hints against report spans only the gateway decodes, allowing for
 * how far Warcraft Logs' clock can sit from the other provider's. Which zones
 * and fights a run spends requests on is the caller's plan
 * (`WarcraftLogsCollectionPlan`).
 */
import type { ReportSpan } from "./decode/reports";
import type { WarcraftLogsVerifiedKill } from "./types";

/**
 * How long before a kill its report may have started. A raid night's log
 * opens at the pull, but some loggers leave one running across an evening.
 */
export const ATTENDANCE_REPORT_LEAD_MS = 16 * 60 * 60 * 1_000;
/**
 * How far past the earliest wanted report the attendance walk still pages.
 * Pages are newest first but overlap by hours at a boundary (measured
 * 2026-09-23), so one page wholly older than a kill does not prove the next
 * holds nothing newer.
 */
export const ATTENDANCE_PAGE_OVERLAP_MS = 2 * 24 * 60 * 60 * 1_000;
/**
 * How far outside a report's span a verified kill's time may fall and still be
 * accounted for by it, on either side. The other provider's clock can be a
 * whole hour off: Raider.IO dates Ryun's Queen Azshara 19:34Z against the
 * log's 20:34Z (measured 2026-09-23).
 */
export const REPORT_COVER_SLACK_MS = 2 * 60 * 60 * 1_000;

/**
 * The verified kills no cleanly decoded history page accounts for. Only these
 * are worth searching guild attendance for.
 */
export function uncoveredVerifiedKills(
  verifiedKills: readonly WarcraftLogsVerifiedKill[],
  scannedSpans: readonly ReportSpan[]
): { verified: WarcraftLogsVerifiedKill; at: number }[] {
  return verifiedKills.flatMap((verified) => {
    const at = Date.parse(verified.at);
    if (Number.isNaN(at)) return [];
    const covered = scannedSpans.some(
      (span) =>
        span.start - REPORT_COVER_SLACK_MS <= at &&
        at <= span.end + REPORT_COVER_SLACK_MS
    );
    return covered ? [] : [{ verified, at }];
  });
}
