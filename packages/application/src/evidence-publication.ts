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
  limitationCode: EvidenceLimitationCode | null;
  parseLimitationCode: EvidenceLimitationCode | null;
  retryAfterAt?: Date | null;
  kills: readonly CharacterMythicKillInput[];
  wipes: readonly WarcraftLogsWipeEvidence[];
  tierBests: readonly CharacterTierBestParseInput[];
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
    limitationCode: publication.limitationCode,
    parseLimitationCode: publication.parseLimitationCode,
    retryAfterAt: publication.retryAfterAt
      ? publication.retryAfterAt.toISOString()
      : null,
    kills: publication.kills,
    wipes: publication.wipes,
    tierBests: publication.tierBests,
    completedAt: publication.completedAt.toISOString(),
    ...(troubledRaidIds ? { troubledRaidIds } : {})
  };
}

export function fromStagedCollection(
  staged: StagedEvidenceCollection
): EvidencePublication {
  return {
    state: staged.state,
    limitationCode: staged.limitationCode as EvidenceLimitationCode | null,
    parseLimitationCode:
      staged.parseLimitationCode as EvidenceLimitationCode | null,
    ...(staged.retryAfterAt
      ? { retryAfterAt: new Date(staged.retryAfterAt) }
      : {}),
    kills: staged.kills,
    wipes: staged.wipes,
    tierBests: staged.tierBests,
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
    scanLimitation: staged.limitationCode,
    troubledRaidIds: staged.troubledRaidIds
  });
}
