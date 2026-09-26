import {
  ATTENDANCE_PAGE_OVERLAP_MS,
  ATTENDANCE_REPORT_LEAD_MS,
  REPORT_COVER_SLACK_MS,
  uncoveredVerifiedKills
} from "../collection-plan";
import { guildAttendancePage, guildIsAbsent } from "../decode/attendance";
import { decodedHydratedReport } from "../decode/reports";
import { guildAttendanceQuery, reportByCodeQuery } from "../queries";
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
  return decodedHydratedReport(report.value, run.key);
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
 * Character histories can omit reports that are still listed in a guild's
 * attendance history. Attendance is searched only for a verified kill no
 * decoded report accounts for, in the guild that kill was in and on its
 * night: a guild's attendance is every report it ever logged, and walking all
 * of it cost Ryii 1,811 requests a run against a 300 cap. It is discovery only
 * -- a report is hydrated and run through the same actor/fight attribution
 * decoder as history, and its player list only ever rules a report out. Wipes
 * in a hydrated report are kept; no report is read for wipes alone.
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
  const { key, options, kills, wipes, scannedReportCodes } = run;
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
  // Only a walk that finished counts: a spent budget, a transient refusal or a
  // report that could not be read leaves a kill unproven, and it is searched
  // again.
  const searchedEmpty: WarcraftLogsVerifiedKill[] = [];
  search: for (const { guild, wanted: targets } of recoveryTargets.values()) {
    const times = targets.map((target) => target.at);
    const pagedPast =
      Math.min(...times) -
      ATTENDANCE_REPORT_LEAD_MS -
      ATTENDANCE_PAGE_OVERLAP_MS;
    // A report with no start time cannot be placed, so it is read rather
    // than assumed to be from another night. A report may start after the
    // verified time by the same clock slack a span is allowed.
    const wanted = (startTime: number | null) =>
      startTime === null ||
      times.some(
        (at) =>
          startTime <= at + REPORT_COVER_SLACK_MS &&
          startTime >= at - ATTENDANCE_REPORT_LEAD_MS
      );
    // Whether this guild's walk reached a conclusion: past every wanted
    // night, out of pages, or told the guild does not exist.
    let concluded: boolean;
    let unreadable = false;
    type Page = NonNullable<ReturnType<typeof guildAttendancePage>>;
    const pages = new Map<number, Page>();
    // A page, or why the walk has to end without one: the budget ran out,
    // or Warcraft Logs answered with something that settles the walk one
    // way or the other.
    const page = async (
      number: number
    ): Promise<Page | "budget" | { concluded: boolean }> => {
      const cached = pages.get(number);
      if (cached) return cached;
      if (run.historyRequests >= options.requestCap) return "budget";
      searched = true;
      const attendance = await run.counted("guild_attendance", () =>
        run.ctx.graphql(
          guildAttendanceQuery,
          {
            name: guild.name,
            realm: guild.realm,
            region: guild.region,
            page: number
          },
          options.signal
        )
      );
      run.historyRequests += 1;
      if (attendance.kind !== "success") {
        // A guild Warcraft Logs does not have holds nothing to find. Any
        // other refusal may pass, so it proves nothing.
        return { concluded: attendance.code === "not_found" };
      }
      const decoded = guildAttendancePage(attendance.value, key.name);
      if (decoded === null) {
        // `guild: null` is Warcraft Logs saying it has no such guild; a
        // page that is otherwise unreadable proves nothing.
        return { concluded: guildIsAbsent(attendance.value) };
      }
      pages.set(number, decoded);
      return decoded;
    };
    const starts = (value: Page) =>
      value.reports.map((report) => report.startTime);
    // Newest first, and pages overlap by hours at a boundary, so a page is
    // wholly newer than every wanted night only when each report on it is
    // more than the overlap beyond the newest. An undated report says
    // nothing about its reach, and it is wanted, so it stops the gallop.
    const newestWanted = Math.max(...times) + REPORT_COVER_SLACK_MS;
    const newerThanNights = (value: Page) =>
      value.reports.length > 0 &&
      starts(value).every(
        (start) =>
          start !== null && start > newestWanted + ATTENDANCE_PAGE_OVERLAP_MS
      );
    const pastNights = (value: Page) =>
      value.reports.length > 0 &&
      starts(value).every((start) => start !== null && start < pagedPast);

    walk: {
      // Attendance is every report the guild ever logged, and an old night
      // sits behind years of newer ones: gallop to the first page that is
      // not wholly newer, then bisect for it, as the tier search does. A
      // page skipped on the way is wholly newer than every wanted night,
      // so it holds no report the walk would have hydrated.
      let before = 0;
      let first = 1;
      for (;;) {
        const value = await page(first);
        if (value === "budget") break search;
        if (!("reports" in value)) {
          concluded = value.concluded;
          break walk;
        }
        if (!newerThanNights(value)) break;
        // The whole of this guild's attendance is newer than the nights.
        if (!value.hasMorePages) {
          concluded = true;
          break walk;
        }
        before = first;
        first *= 2;
      }
      while (first - before > 1) {
        const middle = Math.floor((before + first) / 2);
        const value = await page(middle);
        if (value === "budget") break search;
        if (!("reports" in value)) {
          concluded = value.concluded;
          break walk;
        }
        if (newerThanNights(value)) before = middle;
        else first = middle;
      }

      for (let number = first; ; number++) {
        const attendancePage = await page(number);
        if (attendancePage === "budget") break search;
        if (!("reports" in attendancePage)) {
          concluded = attendancePage.concluded;
          break walk;
        }
        for (const {
          code,
          startTime,
          listsCharacter
        } of attendancePage.reports) {
          if (scannedReportCodes.has(code)) continue;
          if (listsCharacter === false || !wanted(startTime)) continue;
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
        // Out of pages, or a page wholly past every wanted night: nothing
        // older can hold one.
        if (!attendancePage.hasMorePages || pastNights(attendancePage)) {
          concluded = true;
          break walk;
        }
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
