import type {
  CharacterMythicKillInput,
  CharacterTierBestParseInput,
  StagedEvidenceCollection,
  TerminalTier
} from "@slashwho/database";
import type {
  WarcraftLogsLimitationCode,
  WarcraftLogsWipeEvidence
} from "@slashwho/warcraftlogs";

import { terminalTiersFrom } from "./terminal-tiers";

/**
 * What a run may name as its shortfall.
 *
 * Wider than `WarcraftLogsLimitationCode` because "our own code threw" is not
 * a Warcraft Logs fact, and the Warcraft Logs package should keep describing
 * only Warcraft Logs. A run whose attempt ended in a fault it cannot expect to
 * survive a retry publishes what it has under `collection_failed` (#292).
 */
export type EvidenceLimitationCode =
  WarcraftLogsLimitationCode | "collection_failed";

/** What one run hands to storage when its collection is done. */
export type EvidencePublication = Readonly<{
  state: "complete" | "partial";
  scanSkipped?: boolean;
  /** See StagedEvidenceCollection.historyScanResumePage. */
  historyScanResumePage?: number | null;
  historyScanResumeHeadReportCode?: string | null;
  limitationCode: EvidenceLimitationCode | null;
  /**
   * The parse limitation this run is judged by: the one that decides whether
   * it retries, and the one a dossier shows.
   */
  parseLimitationCode: EvidenceLimitationCode | null;
  /**
   * Every distinct parse limitation the run raised, including the one above.
   *
   * A run can hit several and only one can be judged by, so the others used
   * to be discarded -- which is how an unmatched ranking identity hid behind
   * `parse_request_cap` until #349. Recorded rather than reported: nothing
   * reads this to make a decision, and that is deliberate, because the moment
   * something does the choice above stops being the single answer.
   */
  parseLimitationCodesSeen: readonly EvidenceLimitationCode[];
  retryAfterAt?: Date | null;
  kills: readonly CharacterMythicKillInput[];
  wipes: readonly WarcraftLogsWipeEvidence[];
  tierBests: readonly CharacterTierBestParseInput[];
  /**
   * Fight URLs this run asked Warcraft Logs about and got an answer for,
   * whatever the answer was. Storage stamps those kills so a later run can
   * tell them from fights nothing has ever asked about -- which is what stops
   * half the parse budget going on reports that have already said no (#297).
   *
   * Required here, unlike on `publish`, for the same reason
   * `parseLimitationCodesSeen` is: the run that knows what it read must not
   * quietly forget it. A run that read nothing publishes an empty list.
   */
  parsedFightUrls: readonly string[];
  completedAt: Date;
}>;

/**
 * The stage crosses a JSON boundary, so its two timestamps travel as ISO
 * strings and everything else is the publication verbatim. Nothing derived
 * from the run's credentials is in either direction.
 *
 * `troubledRaidIds` is not part of the publication -- `publish` has no use for
 * it -- but it is the one input terminal marking needs that nothing else in a
 * settled run records, so the stage is the only place it can survive the death
 * of the process that collected it.
 */
export function toStagedCollection(
  publication: EvidencePublication,
  troubledRaidIds: StagedEvidenceCollection["troubledRaidIds"]
): StagedEvidenceCollection {
  return {
    state: publication.state,
    ...(publication.scanSkipped ? { scanSkipped: true } : {}),
    ...(Object.hasOwn(publication, "historyScanResumePage")
      ? { historyScanResumePage: publication.historyScanResumePage }
      : {}),
    ...(Object.hasOwn(publication, "historyScanResumeHeadReportCode")
      ? {
          historyScanResumeHeadReportCode:
            publication.historyScanResumeHeadReportCode
        }
      : {}),
    limitationCode: publication.limitationCode,
    parseLimitationCode: publication.parseLimitationCode,
    parseLimitationCodesSeen: publication.parseLimitationCodesSeen,
    retryAfterAt: publication.retryAfterAt
      ? publication.retryAfterAt.toISOString()
      : null,
    kills: publication.kills,
    wipes: publication.wipes,
    tierBests: publication.tierBests,
    parsedFightUrls: publication.parsedFightUrls,
    completedAt: publication.completedAt.toISOString(),
    ...(troubledRaidIds ? { troubledRaidIds } : {})
  };
}

export function fromStagedCollection(
  staged: StagedEvidenceCollection
): EvidencePublication {
  return {
    state: staged.state,
    ...(staged.scanSkipped ? { scanSkipped: true } : {}),
    ...(Object.hasOwn(staged, "historyScanResumePage")
      ? { historyScanResumePage: staged.historyScanResumePage }
      : {}),
    ...(Object.hasOwn(staged, "historyScanResumeHeadReportCode")
      ? {
          historyScanResumeHeadReportCode:
            staged.historyScanResumeHeadReportCode
        }
      : {}),
    limitationCode: staged.limitationCode as EvidenceLimitationCode | null,
    parseLimitationCode:
      staged.parseLimitationCode as EvidenceLimitationCode | null,
    // A stage written before #349 carries no list; the code it was judged by
    // is the whole of what that run recorded, so it stands in for itself.
    parseLimitationCodesSeen: (staged.parseLimitationCodesSeen ??
      (staged.parseLimitationCode
        ? [staged.parseLimitationCode]
        : [])) as readonly EvidenceLimitationCode[],
    ...(staged.retryAfterAt
      ? { retryAfterAt: new Date(staged.retryAfterAt) }
      : {}),
    kills: staged.kills,
    wipes: staged.wipes,
    tierBests: staged.tierBests,
    // A stage written before this field existed recorded no attempts. Absent
    // is read as empty, which costs the republished run a re-request of the
    // fights it had already answered and nothing else -- unlike
    // `troubledRaidIds` above, where the same reading would settle a tier
    // that was never cleanly read.
    parsedFightUrls: staged.parsedFightUrls ?? [],
    completedAt: new Date(staged.completedAt)
  };
}

/**
 * Which tiers a republished stage is allowed to settle -- the same answer the
 * run that collected it would have reached, computed from the stage alone.
 *
 * Both readers of a stage need this: the re-claimed attempt that republishes
 * one, and the recovery sweep that publishes a stage whose worker died. A
 * republication that stored evidence but settled nothing would make the
 * character re-pay for zones and scan pages it had already earned the right to
 * stop re-querying -- precisely the saving terminal marking exists to make.
 *
 * **A stage with no `troubledRaidIds` settles nothing, and that is not the
 * same as one whose trouble sets are empty.** Stages written before the field
 * existed cannot say which raids they had trouble with, and reading their
 * silence as "none" would mark a troubled raid terminal and freeze the parse
 * gaps that trouble was raised to keep open. Marking nothing costs a re-query;
 * over-marking costs evidence that can only be corrected by a rebuild.
 *
 * Timed from `completedAt` rather than the caller's clock. That is the instant
 * the original run would have used -- it marked moments after publishing --
 * and it is the stricter of the two: a later `at` widens the settled window
 * and could freeze a percentile that was still moving when the scan read it.
 */
export function terminalTiersFromStage(
  staged: StagedEvidenceCollection,
  settleMs: number
): readonly TerminalTier[] {
  if (!staged.troubledRaidIds) return [];
  const completedAt = new Date(staged.completedAt);
  if (Number.isNaN(completedAt.valueOf())) return [];
  return terminalTiersFrom({
    at: completedAt,
    settleMs,
    kills: staged.kills,
    scanSkipped: staged.scanSkipped === true,
    scanLimitation: staged.limitationCode,
    troubledRaidIds: staged.troubledRaidIds
  });
}
