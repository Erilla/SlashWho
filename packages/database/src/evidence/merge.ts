import { parsePerformanceValues } from "../mappers";
import type {
  CharacterMythicKillInput,
  CharacterMythicWipeInput,
  CharacterRaiderIoFirstKillInput,
  CharacterTierBestParseInput,
  EvidenceRepository,
  RaiderIoFirstKillsPublication,
  StoredCharacterMythicKill,
  StoredCharacterMythicWipe
} from "../repositories";

// Parse enrichment is best-effort: a re-collection that is rate limited or
// capped re-finds the same fight with nothing attached. A fight is immutable,
// so a value already observed for it is never worsened by a later blank.
function mergeParseMetric(
  previous: ReturnType<typeof parsePerformanceValues>["damage"],
  incoming: ReturnType<typeof parsePerformanceValues>["damage"]
): ReturnType<typeof parsePerformanceValues>["damage"] {
  return incoming.state === "available" || previous.state !== "available"
    ? incoming
    : previous;
}

export function mergePerformanceValues(
  previous: ReturnType<typeof parsePerformanceValues>,
  incoming: ReturnType<typeof parsePerformanceValues>
): ReturnType<typeof parsePerformanceValues> {
  return {
    spec: incoming.spec ?? previous.spec,
    damage: mergeParseMetric(previous.damage, incoming.damage),
    healing: mergeParseMetric(previous.healing, incoming.healing),
    bossDamage: mergeParseMetric(previous.bossDamage, incoming.bossDamage)
  };
}

type PerformanceValues = ReturnType<typeof parsePerformanceValues>;

/** A stored tier best, keyed by `${raidId}\0${bossId}`. */
export interface StoredTierBest {
  tierBest: CharacterTierBestParseInput;
  performance: PerformanceValues;
  /** When this zone was actually read, preserved across carry-forward. */
  collectedAt: Date;
}

/**
 * Everything `publish` reads about a character's stored evidence before it
 * decides what to write. Read inside the publishing transaction; nothing here
 * is fetched by the merge itself.
 */
export interface StoredEvidenceForMerge {
  /** The kills and wipes a partial publish carries forward. */
  positive: {
    kills: readonly StoredCharacterMythicKill[];
    wipes: readonly StoredCharacterMythicWipe[];
  };
  /** Kills confirmed by the latest explicit search of each tier. */
  tierSearchKills: readonly StoredCharacterMythicKill[];
  /** Raids this character is finished with, so collection no longer reads. */
  terminalKillRaidIds: ReadonlySet<string>;
  performanceByFightUrl: ReadonlyMap<string, PerformanceValues>;
  collectedAtByFightUrl: ReadonlyMap<string, Date>;
  parsesReadAtByFightUrl: ReadonlyMap<string, Date>;
  historicRankByFightUrl: ReadonlyMap<
    string,
    {
      historicWorldRank: number | null;
      historicRankCheckedAt: Date | null;
    }
  >;
  tierBests: ReadonlyMap<string, StoredTierBest>;
}

export type EvidencePublishInput = Pick<
  Parameters<EvidenceRepository["publish"]>[1],
  "state" | "completedAt" | "kills" | "wipes" | "tierBests" | "parsedFightUrls"
>;

export interface MergedKill {
  kill: CharacterMythicKillInput;
  performance: PerformanceValues;
  historicWorldRank: number | null;
  historicRankCheckedAt: Date | string | null;
  collectedAt: Date;
  parsesReadAt: Date | null;
}

/** The rows one publish writes: the character's whole history, merged. */
export interface MergedEvidence {
  kills: MergedKill[];
  wipes: CharacterMythicWipeInput[];
  tierBests: StoredTierBest[];
}

/**
 * Merges a run's findings with the character's stored evidence into the rows
 * its publication writes. Pure, so the carry-forward rules can be tested
 * without a database.
 */
export function mergePublishedEvidence(
  stored: StoredEvidenceForMerge,
  input: EvidencePublishInput,
  targeted: boolean
): MergedEvidence {
  const incomingKills = input.kills.map((kill) => ({
    kill,
    performance: parsePerformanceValues(kill.performance)
  }));
  // A partial publish carries everything forward, as it always has. A
  // complete ordinary one carries forward terminal raids and kills
  // confirmed by the latest explicit search of each tier. An ordinary
  // history scan cannot re-find those old exact reports through
  // recentReports. Every other raid keeps the contract where a kill a
  // complete run stopped finding stops being claimed. A targeted
  // search is only ever additive, whatever its state.
  const previous =
    input.state === "partial" || targeted
      ? stored.positive
      : {
          kills: [
            ...new Map(
              [
                ...stored.tierSearchKills,
                ...stored.positive.kills.filter((kill) =>
                  stored.terminalKillRaidIds.has(kill.raidId)
                )
              ].map((kill) => [kill.fightUrl, kill] as const)
            ).values()
          ],
          wipes: stored.positive.wipes.filter((wipe) =>
            stored.terminalKillRaidIds.has(wipe.raidId)
          )
        };
  const incomingFightUrls = new Set(input.kills.map((kill) => kill.fightUrl));
  // Fights this run got a ranking answer about, whatever the answer
  // was. A fight answered with nothing is what makes the difference:
  // recorded, it stops being re-requested every run (#297).
  // A targeted search vouches only for the fights it publishes. One it
  // parsed but left out -- another raid's, on the same night -- keeps
  // the answer time it had, so a stored unparsed kill is not marked
  // read without its parses (#492 review).
  const parsedFightUrls = new Set(
    (input.parsedFightUrls ?? []).filter(
      (url) => !targeted || incomingFightUrls.has(url)
    )
  );
  const kills = new Map<string, (typeof incomingKills)[number]>(
    previous.kills.map((kill) => [
      kill.fightUrl,
      { kill, performance: parsePerformanceValues(kill.performance) }
    ])
  );
  // A complete publish must not resurrect kills the run no longer
  // found, but it must still carry forward parses for kills it did,
  // because collection skips fights it has already hydrated.
  for (const kill of incomingKills) {
    const storedKill =
      kills.get(kill.kill.fightUrl) ??
      (stored.performanceByFightUrl.has(kill.kill.fightUrl)
        ? {
            kill: kill.kill,
            performance: stored.performanceByFightUrl.get(kill.kill.fightUrl)!
          }
        : undefined);
    kills.set(
      kill.kill.fightUrl,
      storedKill === undefined
        ? kill
        : {
            kill: kill.kill,
            performance: mergePerformanceValues(
              storedKill.performance,
              kill.performance
            )
          }
    );
  }
  const wipes = new Map<string, CharacterMythicWipeInput>();
  for (const wipe of [...previous.wipes, ...input.wipes]) {
    wipes.set(wipe.fightUrl, wipe);
  }
  const tierBests = new Map(stored.tierBests);
  for (const tierBest of input.tierBests) {
    const key = `${tierBest.raidId}\0${tierBest.bossId}`;
    const storedTierBest = tierBests.get(key);
    const performance = parsePerformanceValues(tierBest.performance);
    tierBests.set(key, {
      tierBest,
      performance:
        storedTierBest === undefined
          ? performance
          : mergePerformanceValues(storedTierBest.performance, performance),
      // This run read the zone, so it is collected now. Rows this run
      // did not supply keep the time they were read: stamping the
      // run's own completion on a carried row would make a zone the
      // budget never reached look current, and it would never be read
      // again.
      collectedAt: input.completedAt
    });
  }
  return {
    kills: [...kills.values()].map(({ kill, performance }) => {
      const historicRank = stored.historicRankByFightUrl.get(kill.fightUrl);
      return {
        kill,
        performance,
        historicWorldRank:
          kill.historicWorldRank ?? historicRank?.historicWorldRank ?? null,
        historicRankCheckedAt:
          kill.historicRankCheckedAt ??
          historicRank?.historicRankCheckedAt ??
          null,
        // This run observed the fight only if it came back with it. A
        // fight carried forward keeps the time it was actually read,
        // so a percentile's age stays honest.
        collectedAt: incomingFightUrls.has(kill.fightUrl)
          ? input.completedAt
          : (stored.collectedAtByFightUrl.get(kill.fightUrl) ??
            input.completedAt),
        // Only a fight this run actually asked about is restamped.
        // Everything else keeps the answer time it already had, and a
        // fight never asked about stays null.
        parsesReadAt: parsedFightUrls.has(kill.fightUrl)
          ? input.completedAt
          : (stored.parsesReadAtByFightUrl.get(kill.fightUrl) ?? null)
      };
    }),
    wipes: [...wipes.values()],
    tierBests: [...tierBests.values()]
  };
}

const firstKillKey = (kill: CharacterRaiderIoFirstKillInput) =>
  `${kill.raidSlug}\0${kill.bossSlug}`;

function mergeFirstKill(
  previous: CharacterRaiderIoFirstKillInput,
  incoming: CharacterRaiderIoFirstKillInput
): CharacterRaiderIoFirstKillInput {
  // A logged encounter never changes, so one already read is never lost to a
  // later read that failed.
  const keepRead =
    previous.encounterState === "read" &&
    incoming.encounterState !== "read" &&
    previous.loggedEncounterId === incoming.loggedEncounterId;
  return {
    ...incoming,
    ...(keepRead
      ? {
          killedAt: previous.killedAt,
          encounterState: "read" as const,
          encounterLimitationCode: null
        }
      : {}),
    historicWorldRank: incoming.historicWorldRank ?? previous.historicWorldRank,
    historicRankCheckedAt:
      incoming.historicRankCheckedAt ?? previous.historicRankCheckedAt
  };
}

/**
 * The Raider.IO first kills one publish writes: the character's whole set,
 * merged. The rules follow `mergePublishedEvidence`: a run that did not read
 * the kill list, a partial run and a targeted one carry everything forward; a
 * complete one keeps what it found again plus every raid it did not ask
 * about. A Raider.IO first kill never touches a Warcraft Logs kill.
 */
export function mergeRaiderIoFirstKills(
  stored: readonly CharacterRaiderIoFirstKillInput[],
  input: RaiderIoFirstKillsPublication | undefined,
  state: "complete" | "partial",
  targeted: boolean
): CharacterRaiderIoFirstKillInput[] {
  const merged = new Map<string, CharacterRaiderIoFirstKillInput>();
  const asked = new Set(input?.askedRaidSlugs ?? []);
  for (const kill of stored) {
    const carried =
      input === undefined ||
      targeted ||
      state === "partial" ||
      !asked.has(kill.raidSlug);
    if (carried) merged.set(firstKillKey(kill), kill);
  }
  if (input !== undefined && !targeted) {
    const previous = new Map(stored.map((kill) => [firstKillKey(kill), kill]));
    for (const kill of input.kills) {
      const before = previous.get(firstKillKey(kill));
      merged.set(
        firstKillKey(kill),
        before === undefined ? kill : mergeFirstKill(before, kill)
      );
    }
  }
  return [...merged.values()].sort(
    (a, b) =>
      a.killedAt.localeCompare(b.killedAt) ||
      firstKillKey(a).localeCompare(firstKillKey(b))
  );
}
