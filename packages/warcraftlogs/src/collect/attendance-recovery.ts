import {
  ATTENDANCE_REPORT_LEAD_MS,
  REPORT_COVER_SLACK_MS,
  uncoveredVerifiedKills
} from "../attendance-coverage";
import { guildReportsPage } from "../decode/attendance";
import { decodedUnderRankedName } from "../decode/ranked-backfill";
import { decodedHydratedReport } from "../decode/reports";
import { guildReportsQuery, reportByCodeQuery } from "../queries";
import type {
  WarcraftLogsReportResult,
  WarcraftLogsVerifiedKill
} from "../types";
import type { CollectionRun } from "./context";
import type { HistoryScan } from "./history-scan";

/** Reads one report by code, against the history budget. */
async function hydrateReport(
  run: CollectionRun,
  code: string
): Promise<WarcraftLogsReportResult> {
  const report = await run.counted("report_hydration", () =>
    run.ctx.graphql(reportByCodeQuery, { code }, run.options.signal)
  );
  run.historyRequests += 1;
  if (report.kind !== "success") return report;
  const decoded = decodedHydratedReport(report.value, run.key);
  // Nothing under the current name may be a night from before a rename:
  // the report's ranking names the character as they were then (#733). A
  // stored kill re-read that decoded to nothing here would otherwise read as
  // a kill the run stopped finding, and a complete publish would drop it.
  if (
    decoded.kind === "evidence" &&
    decoded.kills.length === 0 &&
    decoded.wipes.length === 0
  ) {
    return (
      decodedUnderRankedName(report.value, run.key, run.options.characterId) ??
      decoded
    );
  }
  return decoded;
}

/**
 * A complete publish keeps only what the run finds again outside terminal
 * raids, and a kill an earlier run recovered from attendance is not in the
 * character's own history to be found. So after a fresh scan that finished --
 * the only kind that publishes complete -- each stored kill's report the scan
 * did not read is re-read directly, one request. The list comes from stored
 * evidence, never from Raider.IO, so a Raider.IO failure cannot drop what it
 * once helped find.
 *
 * A report that is gone (`not_found`, `private`) is a kill the run stopped
 * finding, which a complete publish is meant to drop. Anything else puts the
 * stored kill at risk, so it limits the scan: a partial publish carries every
 * stored kill forward.
 */
export async function rereadStoredReports(
  run: CollectionRun,
  scan: HistoryScan
): Promise<void> {
  if (scan.resumedFromCursor || !scan.finished || scan.limitation) return;
  const { options, kills, wipes, scannedReportCodes } = run;
  for (const code of new Set(options.storedKillReportCodes ?? [])) {
    if (scannedReportCodes.has(code)) continue;
    if (run.historyRequests >= options.requestCap) {
      scan.limitation ??= { kind: "limitation", code: "request_cap" };
      break;
    }
    const decoded = await hydrateReport(run, code);
    scannedReportCodes.add(code);
    if (decoded.kind === "limitation") {
      if (decoded.code !== "not_found" && decoded.code !== "private") {
        scan.limitation ??= decoded;
      }
      continue;
    }
    for (const kill of decoded.kills) kills.set(kill.fightUrl, kill);
    for (const wipe of decoded.wipes) wipes.set(wipe.fightUrl, wipe);
    if (decoded.omittedInvalidTimestamp) {
      scan.omittedInvalidTimestamp = true;
    } else if (decoded.limitation) {
      scan.limitation ??= decoded.limitation;
    }
  }
}

export type AttendanceRecovery = Readonly<{
  /**
   * Set once a recovery request is actually made, so a run whose budget was
   * already spent reports no search rather than a search that found nothing.
   */
  searched: boolean;
  recoveredKills: number;
  /**
   * Kills whose night was searched to the end and held nothing, reported so
   * the caller can stop searching for them for a while (#434).
   */
  searchedEmpty: readonly WarcraftLogsVerifiedKill[];
}>;

/**
 * Character histories can omit reports that are still listed under the guild
 * they were logged in. A guild is searched only for a verified kill no decoded
 * report accounts for, in the guild that kill was in and on its night: the
 * guild's reports that started in that night's window, listed for a point a
 * page. It replaced walking the guild's attendance, which is every report it
 * ever logged at about a point a report, galloping back to the night (#712).
 * It is discovery only -- a report is hydrated and run through the same
 * actor/fight attribution decoder as history. The listing names no players,
 * so every report on the night is read, where attendance could rule some
 * out. Wipes in a hydrated report are kept; no report is read for wipes alone.
 *
 * Nothing stored depends on it, so a search that cannot finish -- a guild
 * Warcraft Logs does not know, a page it will not serve, a spent budget --
 * recovers nothing and limits nothing. Raider.IO names the guild as it was on
 * the night, and one renamed, moved or never logged since would otherwise hold
 * the run partial on every retry.
 */
export async function recoverFromAttendance(
  run: CollectionRun,
  scan: HistoryScan
): Promise<AttendanceRecovery> {
  const { options, kills, wipes, scannedReportCodes } = run;
  const uncovered = uncoveredVerifiedKills(
    options.verifiedKills ?? [],
    scan.spans
  );
  let searched = false;
  let recoveredKills = 0;
  const recoveryTargets = new Map<
    string,
    {
      guild: WarcraftLogsVerifiedKill["guild"];
      wanted: { verified: WarcraftLogsVerifiedKill; at: number }[];
    }
  >();
  for (const { verified, at } of uncovered) {
    const guildKey = `${verified.guild.region}\0${verified.guild.realm}\0${verified.guild.name}`;
    const target = recoveryTargets.get(guildKey) ?? {
      guild: verified.guild,
      wanted: []
    };
    target.wanted.push({ verified, at });
    recoveryTargets.set(guildKey, target);
  }
  // Only a search that finished counts: a spent budget, a transient refusal
  // or a report that could not be read leaves a kill unproven, and it is
  // searched again.
  const searchedEmpty: WarcraftLogsVerifiedKill[] = [];
  search: for (const { guild, wanted: targets } of recoveryTargets.values()) {
    // Whether this guild's search reached a conclusion: every night listed
    // to its last page, or told the guild does not exist.
    let concluded = true;
    let unreadable = false;
    guild: for (const [startTime, endTime] of nightWindows(targets)) {
      for (let number = 1; ; number++) {
        if (run.historyRequests >= options.requestCap) break search;
        searched = true;
        const listing = await run.counted("guild_reports", () =>
          run.ctx.graphql(
            guildReportsQuery,
            {
              name: guild.name,
              realm: guild.realm,
              region: guild.region,
              startTime,
              endTime,
              page: number
            },
            options.signal
          )
        );
        run.historyRequests += 1;
        // A guild Warcraft Logs does not have holds nothing to find. Any
        // other refusal, or a page that cannot be read, proves nothing.
        if (listing.kind !== "success") {
          concluded = listing.code === "not_found";
          break guild;
        }
        const page = guildReportsPage(listing.value);
        if (page === null) {
          concluded = false;
          break guild;
        }
        for (const { code } of page.reports) {
          if (scannedReportCodes.has(code)) continue;
          if (run.historyRequests >= options.requestCap) break search;
          const decoded = await hydrateReport(run, code);
          scannedReportCodes.add(code);
          if (decoded.kind === "limitation") {
            // A report that is gone holds nothing; one that could not be
            // read might have held the kill.
            if (decoded.code !== "not_found" && decoded.code !== "private") {
              unreadable = true;
            }
            continue;
          }
          for (const kill of decoded.kills) {
            if (!kills.has(kill.fightUrl)) recoveredKills += 1;
            kills.set(kill.fightUrl, kill);
          }
          for (const wipe of decoded.wipes) wipes.set(wipe.fightUrl, wipe);
        }
        if (!page.hasMorePages) break;
      }
    }
    if (!concluded || unreadable) continue;
    for (const { verified, at } of targets) {
      const found = [...kills.values()].some((kill) => {
        const killedAt = Date.parse(kill.killedAt);
        return Math.abs(killedAt - at) <= REPORT_COVER_SLACK_MS;
      });
      if (!found) searchedEmpty.push(verified);
    }
  }
  return { searched, recoveredKills, searchedEmpty };
}

/**
 * The start-time windows a kill's report can fall in, one a night, with
 * overlapping nights merged so no report is listed twice. A report may open up
 * to a lead before the kill, and after it by the clock slack a span is
 * allowed.
 */
function nightWindows(
  targets: readonly { at: number }[]
): (readonly [number, number])[] {
  const windows = targets
    .map(
      ({ at }) =>
        [at - ATTENDANCE_REPORT_LEAD_MS, at + REPORT_COVER_SLACK_MS] as const
    )
    .sort(([a], [b]) => a - b);
  const merged: [number, number][] = [];
  for (const [start, end] of windows) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
