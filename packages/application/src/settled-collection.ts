import type {
  CompletedCharacterEvidence,
  EvidenceCollectionDomain,
  Repositories,
  TerminalTier
} from "@slashwho/database";
import {
  raidContentWindowOpenedBetween,
  type CharacterKey
} from "@slashwho/domain";

export type SettledCollectionEvidence = Pick<
  Repositories["evidence"],
  | "storedEvidenceTiers"
  | "terminalTiers"
  | "hydratedFightUrls"
  | "collectedTierZones"
>;

/**
 * Whether every tier the character holds kills in is finished in every
 * domain: terminal for kills, parses and tier bests, each kill's fight
 * hydrated, and each tier's bests collected after its newest kill.
 *
 * What is left for a run to find is then only a raid night newer than the
 * newest thing held, which the newest page of reports answers.
 */
export async function killTiersAreSettled(options: {
  key: CharacterKey;
  completed: CompletedCharacterEvidence;
  terminal: readonly TerminalTier[];
  /** Fights killed at or after this are still settling, however hydrated. */
  settledBefore: Date;
  evidence: Pick<
    SettledCollectionEvidence,
    "hydratedFightUrls" | "collectedTierZones"
  >;
}): Promise<boolean> {
  const kills = options.completed.kills;
  const raidIds = new Set(kills.map((kill) => kill.raidId));
  const terminalByDomain = new Map<EvidenceCollectionDomain, Set<string>>();
  for (const tier of options.terminal) {
    const raids = terminalByDomain.get(tier.domain) ?? new Set<string>();
    raids.add(tier.raidId);
    terminalByDomain.set(tier.domain, raids);
  }
  if (
    !(["kills", "parses", "tier_bests"] as const).every((domain) =>
      [...raidIds].every((raidId) => terminalByDomain.get(domain)?.has(raidId))
    )
  )
    return false;

  const [hydrated, collectedZones] = await Promise.all([
    options.evidence.hydratedFightUrls(options.key, options.settledBefore),
    options.evidence.collectedTierZones(options.key)
  ]);
  const hydratedUrls = new Set(hydrated);
  if (!kills.every((kill) => hydratedUrls.has(kill.fightUrl))) return false;

  const zones = new Map(collectedZones);
  return kills.every((kill) => {
    const collectedAt = zones.get(kill.raidId);
    return collectedAt !== undefined && collectedAt > kill.killedAt;
  });
}

/**
 * Whether a dossier read that found the character's evidence stale can queue
 * a light run -- the newest page of reports -- instead of a full one (#540).
 *
 * A full run of a settled character already stops at its terminal tiers, so
 * what it adds over a light run is only the pages between the newest page and
 * the newest thing held, which hold nothing new for a character whose last
 * scan was clean. Everything that could make those pages matter sends the
 * read back to a full run:
 *
 * - a snapshot from an older collector, a scan or parse limitation, or a
 *   history scan still resuming from a bookmark, for itself or an alias;
 * - no clean history scan at all, which is also how a pending alias
 *   re-collection presents once `reserve` has cleared its scan;
 * - a raid window that opened after that scan. The new tier has no terminal
 *   mark for anyone yet, so a character that looked settled before it opened
 *   is not settled about it;
 * - any tier the character holds kills in that is not finished in every
 *   domain.
 *
 * Read after the reservation, so it sees whatever the reservation itself
 * cleared. The light run cannot drop what it does not re-read: a page-capped
 * scan publishes partial and carries every stored kill forward, and a scan
 * that reaches the floor within its page has re-read everything below it.
 */
export async function staleReadNeedsOnlyNewestPage(options: {
  key: CharacterKey;
  at: Date;
  completed: CompletedCharacterEvidence | null;
  completedVersionCurrent: boolean;
  evidence: SettledCollectionEvidence;
}): Promise<boolean> {
  const completed = options.completed;
  if (
    completed === null ||
    !options.completedVersionCurrent ||
    completed.run.limitationCode !== null ||
    completed.run.parseLimitationCode !== null
  )
    return false;

  const [stored, terminal] = await Promise.all([
    options.evidence.storedEvidenceTiers(options.key),
    options.evidence.terminalTiers(options.key)
  ]);
  if (
    stored.lastCleanKillScanAt === undefined ||
    stored.historyScanResumePage !== undefined ||
    (stored.historicAliasProgress ?? []).some(
      (alias) => alias.historyScanResumePage !== undefined
    ) ||
    raidContentWindowOpenedBetween(
      new Date(stored.lastCleanKillScanAt),
      options.at
    )
  )
    return false;

  return killTiersAreSettled({
    key: options.key,
    completed,
    terminal,
    // Every kill is in a terminal tier by the time this is asked, and a tier
    // goes terminal only once all its kills have settled, so no fight here is
    // still moving.
    settledBefore: options.at,
    evidence: options.evidence
  });
}
