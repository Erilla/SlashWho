import type { CharacterKey } from "@slashwho/domain";

import { positiveInteger, validCharacterKey } from "../decode/primitives";
import { createParseLedger } from "../parse-ledger";
import { characterLookup } from "../queries";
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsLimitation,
  WarcraftLogsLimitationCode,
  WarcraftLogsRankedBackfillResult,
  WarcraftLogsReportResult,
  WarcraftLogsTierSearch,
  WarcraftLogsTierSearchOutcome,
  WarcraftLogsWipeEvidence
} from "../types";
import {
  recoverFromAttendance,
  rereadStoredReports
} from "./attendance-recovery";
import {
  observedRequest,
  type ClientContext,
  type CollectionRun,
  type FirstKillOptions
} from "./context";
import { applyCanonicalIdentities, hydrateFightParses } from "./fight-parses";
import { scanHistory } from "./history-scan";
import { getRankedKillReports } from "./ranked-backfill";
import { collectTierBests } from "./tier-bests";
import { searchTierAttendance } from "./tier-search";

/**
 * One character's kill evidence and parses. Discovery comes first -- the
 * character's history, stored reports it did not re-find, guild attendance,
 * the ranked walk, an explicit tier search -- then parse work spends its own
 * budget on what discovery found.
 */
export async function collectFirstKillReports(
  ctx: ClientContext,
  requestedKey: CharacterKey,
  options: FirstKillOptions
): Promise<WarcraftLogsReportResult> {
  const key = validCharacterKey(requestedKey);
  if (
    options.characterId !== undefined &&
    positiveInteger(options.characterId) === null
  ) {
    throw new Error("invalid_character_id");
  }
  const lookup = characterLookup(key, options.characterId);
  if (
    !Number.isSafeInteger(options.requestCap) ||
    options.requestCap < 0 ||
    (options.targetedOnly === true && options.requestCap !== 0)
  ) {
    return { kind: "limitation", code: "request_cap" };
  }
  if (
    !Number.isSafeInteger(options.parseRequestCap) ||
    options.parseRequestCap <= 0
  ) {
    return { kind: "limitation", code: "parse_request_cap" };
  }
  if (
    options.historyScanStartPage !== undefined &&
    (!Number.isSafeInteger(options.historyScanStartPage) ||
      options.historyScanStartPage <= 0)
  ) {
    return { kind: "limitation", code: "schema_drift" };
  }

  const run: CollectionRun = {
    ctx,
    key,
    lookup,
    options,
    counted: (query, issue) =>
      observedRequest(ctx.monotonic, options.onRequest, query, issue),
    kills: new Map(
      (options.storedKills ?? []).map((kill) => [kill.fightUrl, kill])
    ),
    wipes: new Map(),
    scannedReportCodes: new Set(),
    historyRequests: 0,
    parseRequests: 0
  };
  const scanSkipped = options.requestCap === 0;

  const scan = await scanHistory(run);
  if (scan.kind !== "history_scan") return scan;
  await rereadStoredReports(run, scan);
  const recovery = await recoverFromAttendance(run, scan);
  // The ranked walk goes first: what it finds is what says whether the
  // character raided the tier at all, and so whether its guilds' attendance
  // is worth walking (#733).
  const rankedBackfill = options.rankedBackfill
    ? await getRankedKillReports(ctx, key, {
        ...options.rankedBackfill,
        ...(options.characterId ? { characterId: options.characterId } : {}),
        ...(options.onRequest ? { onRequest: options.onRequest } : {}),
        ...(options.onLimitation ? { onLimitation: options.onLimitation } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      })
    : undefined;
  if (rankedBackfill?.kind === "evidence") {
    for (const kill of rankedBackfill.kills) run.kills.set(kill.fightUrl, kill);
    if (rankedBackfill.limitation)
      scan.limitation ??= rankedBackfill.limitation;
  } else if (rankedBackfill) {
    scan.limitation ??= rankedBackfill;
  }
  const tierSearchOutcome =
    options.tierSearch === undefined
      ? undefined
      : await searchTierIfRaided(run, options.tierSearch, rankedBackfill);

  const ledger = createParseLedger(options.onLimitation);
  const tierBests = await collectTierBests(run, ledger);
  const hydration = await hydrateFightParses(run, ledger);
  await applyCanonicalIdentities(run, ledger, hydration);

  const sortedKills = [...run.kills.values()].sort(
    (a, b) =>
      a.raidId.localeCompare(b.raidId) ||
      a.bossOrder - b.bossOrder ||
      a.killedAt.localeCompare(b.killedAt) ||
      a.fightUrl.localeCompare(b.fightUrl)
  );
  const sortedWipes = [...run.wipes.values()].sort(
    (a, b) =>
      a.raidId.localeCompare(b.raidId) ||
      a.bossOrder - b.bossOrder ||
      b.attemptedAt.localeCompare(a.attemptedAt) ||
      a.fightUrl.localeCompare(b.fightUrl)
  );
  const parse = ledger.outcome();
  const omittedInvalidTimestamp = scan.omittedInvalidTimestamp;
  const evidenceResult = (
    result: Readonly<{
      kills: readonly WarcraftLogsFirstKillEvidence[];
      wipes: readonly WarcraftLogsWipeEvidence[];
      limitation?: WarcraftLogsLimitation | undefined;
      historyScanResumePage?: number;
      historyScanResumeBoundaryReportCode?: string;
    }>
  ) => ({
    kind: "evidence" as const,
    scanSkipped,
    ...(omittedInvalidTimestamp
      ? { omittedInvalidTimestamp: true as const }
      : {}),
    kills: result.kills,
    wipes: result.wipes,
    tierBests,
    parsedFightUrls: parse.parsedFightUrls,
    troubledRaidIds: parse.troubledRaidIds,
    ...(result.historyScanResumePage !== undefined
      ? { historyScanResumePage: result.historyScanResumePage }
      : {}),
    ...(result.historyScanResumeBoundaryReportCode !== undefined
      ? {
          historyScanResumeBoundaryReportCode:
            result.historyScanResumeBoundaryReportCode
        }
      : {}),
    ...(result.limitation ? { limitation: result.limitation } : {}),
    ...(parse.parseLimitation
      ? { parseLimitation: parse.parseLimitation }
      : {}),
    ...(parse.parseLimitations.length > 0
      ? { parseLimitations: parse.parseLimitations }
      : {}),
    ...(recovery.searched
      ? { attendanceRecoveredKills: recovery.recoveredKills }
      : {}),
    ...(recovery.searchedEmpty.length > 0
      ? { attendanceSearchedEmpty: recovery.searchedEmpty }
      : {}),
    ...(tierSearchOutcome ? { tierSearch: tierSearchOutcome } : {}),
    ...(rankedBackfill?.kind === "evidence"
      ? { rankedBackfillCursor: rankedBackfill.cursor ?? null }
      : {})
  });
  // A resumed scan read only the pages below its cursor, so reaching the end
  // of them is not a finished history. The pages above were read by earlier
  // runs, and a complete publish keeps only what this run found outside
  // terminal raids -- then marks raids terminal from that fraction, which
  // freezes the loss in. On 2026-09-23 that took Ryii from 751 kills to 269
  // and eight other characters with it. It stays partial, which carries
  // every stored kill forward, and the next run reads the whole history from
  // page one, where finishing does mean finished.
  // Impossible fight times are permanent omissions, reported separately;
  // once page one reaches the end, they leave no history work to retry.
  let scanLimitation = scan.limitation;
  const restartFromFirstPage = scan.resumedFromCursor && !scanLimitation;
  if (restartFromFirstPage) {
    scanLimitation = { kind: "limitation", code: "request_cap" };
  }
  const resume: Readonly<{
    historyScanResumePage?: number;
    historyScanResumeBoundaryReportCode?: string;
  }> = restartFromFirstPage
    ? { historyScanResumePage: 1 }
    : !scanLimitation
      ? {}
      : scan.lastDecodedPage !== undefined
        ? {
            historyScanResumePage: scan.lastDecodedPage + 1,
            ...(scan.resumeBoundaryReportCode
              ? {
                  historyScanResumeBoundaryReportCode:
                    scan.resumeBoundaryReportCode
                }
              : {})
          }
        : scan.invalidatedStoredBoundary
          ? // A one-request budget may be spent entirely proving that the old
            // offset moved. Clear its anchor so the next run starts at page
            // one instead of validating the stale page forever. The probe's
            // own evidence does not change that, so this holds with kills too.
            { historyScanResumePage: 1 }
          : {};
  return sortedKills.length ||
    sortedWipes.length ||
    rankedBackfill !== undefined ||
    omittedInvalidTimestamp
    ? evidenceResult({
        kills: sortedKills,
        wipes: sortedWipes,
        limitation: scanLimitation,
        ...resume
      })
    : resume.historyScanResumePage !== undefined
      ? evidenceResult({
          kills: [],
          wipes: [],
          limitation: scanLimitation,
          ...resume
        })
      : (scanLimitation ??
        parse.parseLimitation ?? {
          ...evidenceResult({ kills: [], wipes: [] })
        });
}

/**
 * The ranked-walk limitations a later run continues: the capped walk, and
 * the transient failures. `retryDelayMsFor` reschedules these, and the
 * continuation resumes the saved cursor. Any other limitation ends the walk
 * for good. Pinned against that policy by a test in `packages/application`.
 */
export const CONTINUED_RANKED_WALK_LIMITATIONS: ReadonlySet<WarcraftLogsLimitationCode> =
  new Set(["request_cap", "rate_limited", "unavailable"]);

const nothingWalked = (
  outcome: "complete" | "deferred" | "unprovable"
): WarcraftLogsTierSearchOutcome => ({
  outcome,
  requests: 0,
  guildsSearched: 0,
  reportsHydrated: 0,
  recoveredKills: 0,
  recoveredWipes: 0
});

/**
 * A tier's guild attendance is every report its guilds logged across the
 * tier, walked back from today, and it can only match the character by the
 * name they raided under. Walked for every connected character of a dossier,
 * most of whom started raiding years after the tier, it read 406 pages in
 * four days and hydrated none (#733). So it is walked only for a character
 * something already places in the tier: a kill the ranked walk found, or
 * stored evidence there.
 *
 * When nothing places them there, the ranked walk decides:
 *
 * - **finished:** that settles it, and the tier is reported searched;
 * - **finished, but with reports left unread** because those it read could
 *   not be proved the character's (#742): `unprovable`, not searched.
 *   Attendance matches by the same names that proved nothing, so it is not
 *   walked either;
 * - **stopped, and continued later:** the walk is `deferred` to the run that
 *   continues it, recorded as such so that run does not read an earlier
 *   press's outcome as this one's;
 * - **failed for good:** it says nothing either way, and attendance is walked
 *   as before. So is a call with no ranked walk.
 */
async function searchTierIfRaided(
  run: CollectionRun,
  search: WarcraftLogsTierSearch,
  rankedBackfill: WarcraftLogsRankedBackfillResult | undefined
): Promise<WarcraftLogsTierSearchOutcome> {
  const raided =
    search.raidedTier === true ||
    (rankedBackfill?.kind === "evidence" && rankedBackfill.kills.length > 0);
  // The names the ranked walk proved join the ones the caller knew.
  const rankedNames =
    rankedBackfill?.kind === "evidence"
      ? (rankedBackfill.rankedNames ?? [])
      : [];
  const walk = () =>
    searchTierAttendance(run, {
      ...search,
      formerNames: [...(search.formerNames ?? []), ...rankedNames]
    });
  if (raided || rankedBackfill === undefined) return walk();
  const limitation =
    rankedBackfill.kind === "evidence"
      ? rankedBackfill.limitation
      : rankedBackfill;
  if (limitation === undefined) {
    return nothingWalked(
      rankedBackfill.kind === "evidence" && rankedBackfill.unreadReports
        ? "unprovable"
        : "complete"
    );
  }
  if (CONTINUED_RANKED_WALK_LIMITATIONS.has(limitation.code)) {
    return nothingWalked("deferred");
  }
  return walk();
}
