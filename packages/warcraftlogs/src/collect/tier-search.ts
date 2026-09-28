import { isValidCharacterKey } from "@slashwho/domain";

import {
  ATTENDANCE_PAGE_OVERLAP_MS,
  ATTENDANCE_REPORT_LEAD_MS,
  REPORT_COVER_SLACK_MS
} from "../attendance-coverage";
import { guildAttendancePage, guildIsAbsent } from "../decode/attendance";
import { characterGuilds } from "../decode/character";
import { decodedHydratedReport } from "../decode/reports";
import {
  characterGuildsQuery,
  guildAttendanceQuery,
  reportByCodeQuery
} from "../queries";
import type {
  WarcraftLogsTierSearch,
  WarcraftLogsTierSearchOutcome,
  WarcraftLogsVerifiedKill
} from "../types";
import type { CollectionRun } from "./context";

// How long a finished guild attendance walk is reused. The walk outlives one
// dossier tier press, whose runs go one after another.
const SHARED_ATTENDANCE_WALK_TTL_MS = 30 * 60_000;
const SHARED_ATTENDANCE_WALK_LIMIT = 64;

/**
 * An explicit search of one tier, asked for from the dossier (#435). It needs
 * no kill to look for: every known guild's attendance is walked across the
 * tier's window, and each report there that may list the character is
 * hydrated through the same decoder as everything else. Like recovery it is
 * discovery only and limits nothing -- it can add evidence, never remove it --
 * and it spends its own cap, never the scan's.
 */
export async function searchTierAttendance(
  run: CollectionRun,
  search: WarcraftLogsTierSearch
): Promise<WarcraftLogsTierSearchOutcome> {
  const { ctx, key, options, kills, wipes, scannedReportCodes } = run;
  const sharedAttendanceWalks = ctx.caches.attendanceWalks;
  // Every name the character raided under, the current one first. A night
  // from before a rename lists only the name of the night (#733).
  // A ranked name is written as displayed ("Erilla"); a key is lower case,
  // and one that still is not a valid key cannot be matched by the decoder.
  const identities = new Map<string, typeof key>();
  for (const { name, realm } of [key, ...(search.formerNames ?? [])]) {
    const identity = {
      region: key.region,
      realm: realm.toLocaleLowerCase("en-US"),
      name: name.normalize("NFC").toLocaleLowerCase("en-US")
    };
    if (!isValidCharacterKey(identity)) continue;
    const id = `${identity.realm}\0${identity.name}`;
    if (!identities.has(id)) identities.set(id, identity);
  }
  const names = [...identities.values()].map((identity) => identity.name);
  const summary = {
    outcome: "complete" as WarcraftLogsTierSearchOutcome["outcome"],
    requests: 0,
    guildsSearched: 0,
    reportsHydrated: 0,
    recoveredKills: 0,
    recoveredWipes: 0
  };
  const cap =
    Number.isSafeInteger(search.requestCap) && search.requestCap > 0
      ? search.requestCap
      : 0;
  const from = Date.parse(search.from);
  const to = Date.parse(search.to);
  if (cap === 0) return { ...summary, outcome: "request_cap" };
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return summary;
  const spend = (): boolean => {
    if (summary.requests >= cap) {
      summary.outcome = "request_cap";
      return false;
    }
    summary.requests += 1;
    return true;
  };
  const skip = new Set(search.skipReportCodes ?? []);
  // A report that opened up to a lead before the window can still hold a
  // kill inside it, and one may open after its last kill by the clock
  // slack a span is allowed.
  const earliestStart = from - ATTENDANCE_REPORT_LEAD_MS;
  const latestStart = to + REPORT_COVER_SLACK_MS;
  const wanted = (startTime: number | null) =>
    startTime === null ||
    (startTime >= earliestStart && startTime <= latestStart);

  const guilds = new Map<string, WarcraftLogsVerifiedKill["guild"]>();
  const addGuild = (guild: WarcraftLogsVerifiedKill["guild"]) => {
    const guildKey = [
      guild.region,
      guild.realm.toLocaleLowerCase("en-US"),
      guild.name.normalize("NFC").toLocaleLowerCase("en-US")
    ].join("/");
    if (!guilds.has(guildKey)) guilds.set(guildKey, guild);
  };
  for (const guild of search.guilds) addGuild(guild);
  // Warcraft Logs' own list of the character's guilds is the one source
  // that knows a guild no kill was attributed to. A failure to read it
  // leaves the guilds the caller knew about.
  if (spend()) {
    const listed = await run.counted("character_guilds", () =>
      ctx.graphql(
        characterGuildsQuery,
        { name: key.name, realm: key.realm, region: key.region },
        options.signal
      )
    );
    if (listed.kind === "success") {
      for (const guild of characterGuilds(listed.value)) addGuild(guild);
    } else {
      summary.outcome = "incomplete";
    }
  }

  type Page = NonNullable<ReturnType<typeof guildAttendancePage>>;
  search: for (const [guildKey, guild] of guilds) {
    const pages = new Map<number, Page | null>();
    const walkKey = `${guildKey}\u0000${earliestStart}\u0000${latestStart}`;
    const kept = sharedAttendanceWalks.get(walkKey);
    const replay =
      kept && ctx.monotonic() - kept.at < SHARED_ATTENDANCE_WALK_TTL_MS
        ? kept.pages
        : undefined;
    // Every answer this walk read, kept if the walk finishes.
    const read = new Map<number, unknown>();
    const decode = (value: unknown) =>
      // A guild Warcraft Logs says it has no record of has nothing to
      // walk, which is a finished walk rather than an unreadable one.
      guildIsAbsent(value)
        ? { reports: [], hasMorePages: false }
        : guildAttendancePage(value, names);
    const finished = () => {
      if (replay) return;
      sharedAttendanceWalks.delete(walkKey);
      sharedAttendanceWalks.set(walkKey, { pages: read, at: ctx.monotonic() });
      // Insertion order is age order, so the first key is the oldest.
      if (sharedAttendanceWalks.size > SHARED_ATTENDANCE_WALK_LIMIT) {
        const oldest = sharedAttendanceWalks.keys().next().value;
        if (oldest !== undefined) sharedAttendanceWalks.delete(oldest);
      }
    };
    // Null when the page could not be read, so this guild's walk cannot
    // be finished; undefined when the budget ran out first.
    const page = async (number: number): Promise<Page | null | undefined> => {
      if (pages.has(number)) return pages.get(number);
      if (replay?.has(number)) {
        const decoded = decode(replay.get(number));
        pages.set(number, decoded);
        return decoded;
      }
      if (!spend()) return undefined;
      const attendance = await run.counted("guild_attendance", () =>
        ctx.graphql(
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
      const decoded =
        attendance.kind !== "success" ? null : decode(attendance.value);
      if (attendance.kind === "success") read.set(number, attendance.value);
      pages.set(number, decoded);
      return decoded;
    };
    const starts = (value: Page) =>
      value.reports.map((report) => report.startTime);
    // Newest first, and pages overlap by hours at a boundary, so a page is
    // past the window only when every report on it is more than the
    // overlap beyond it. An undated report says nothing about its reach.
    const newerThanWindow = (value: Page) =>
      value.reports.length > 0 &&
      starts(value).every(
        (start) =>
          start !== null && start > latestStart + ATTENDANCE_PAGE_OVERLAP_MS
      );
    const olderThanWindow = (value: Page) =>
      value.reports.length > 0 &&
      starts(value).every(
        (start) =>
          start !== null && start < earliestStart - ATTENDANCE_PAGE_OVERLAP_MS
      );
    summary.guildsSearched += 1;

    // Attendance is every report the guild ever logged, and an old tier
    // sits behind years of newer ones. Galloping to the window and then
    // bisecting for its first page costs a few requests a guild instead of
    // one for every page in between.
    let before = 0;
    let first = 1;
    for (;;) {
      const value = await page(first);
      if (value === undefined) break search;
      if (value === null) {
        summary.outcome = "incomplete";
        continue search;
      }
      if (!newerThanWindow(value)) break;
      // The whole of this guild's attendance is newer than the tier.
      if (!value.hasMorePages) {
        finished();
        continue search;
      }
      before = first;
      first *= 2;
    }
    while (first - before > 1) {
      const middle = Math.floor((before + first) / 2);
      const value = await page(middle);
      if (value === undefined) break search;
      if (value === null) {
        summary.outcome = "incomplete";
        continue search;
      }
      if (newerThanWindow(value)) before = middle;
      else first = middle;
    }

    for (let number = first; ; number++) {
      const value = await page(number);
      if (value === undefined) break search;
      if (value === null) {
        summary.outcome = "incomplete";
        continue search;
      }
      if (olderThanWindow(value)) {
        finished();
        continue search;
      }
      for (const report of value.reports) {
        if (skip.has(report.code) || scannedReportCodes.has(report.code)) {
          continue;
        }
        if (report.listsCharacter === false || !wanted(report.startTime)) {
          continue;
        }
        if (!spend()) break search;
        const hydrated = await run.counted("report_hydration", () =>
          ctx.graphql(reportByCodeQuery, { code: report.code }, options.signal)
        );
        scannedReportCodes.add(report.code);
        if (hydrated.kind !== "success") {
          summary.outcome = "incomplete";
          continue;
        }
        summary.reportsHydrated += 1;
        // Read as each name: only the one the character raided under that
        // night attributes anything. The current name comes first, and a
        // report that credits it is not read under a former name too: one
        // character is one actor, so a second actor under a former name in
        // the same report is somebody else.
        let creditedCurrentName = false;
        for (const [index, identity] of [...identities.values()].entries()) {
          if (index > 0 && creditedCurrentName) break;
          const decoded = decodedHydratedReport(hydrated.value, identity);
          if (decoded.kind === "limitation") {
            summary.outcome = "incomplete";
            continue;
          }
          if (index === 0) {
            creditedCurrentName =
              decoded.kills.length > 0 || decoded.wipes.length > 0;
          }
          for (const kill of decoded.kills) {
            if (!kills.has(kill.fightUrl)) summary.recoveredKills += 1;
            kills.set(kill.fightUrl, kill);
          }
          for (const wipe of decoded.wipes) {
            if (!wipes.has(wipe.fightUrl)) summary.recoveredWipes += 1;
            wipes.set(wipe.fightUrl, wipe);
          }
          if (decoded.limitation) summary.outcome = "incomplete";
        }
      }
      if (!value.hasMorePages) {
        finished();
        continue search;
      }
    }
  }
  return summary;
}
