/**
 * What a Warcraft Logs collection run spends its parse budget on. Pure:
 * nothing here issues a request, so the choices can be read and tested on
 * their own. The gateway executes the plan; which zones and fights are worth
 * a request is this service's policy, handed over as a
 * `WarcraftLogsCollectionPlan`.
 */
import {
  currentContentEligibility,
  lookupRaidForEvidence,
  raidOffersMythicRankings
} from "@slashwho/domain";
import type {
  WarcraftLogsCollectionPlan,
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsParseGroup,
  WarcraftLogsParseGroupPlan,
  WarcraftLogsTierZone
} from "@slashwho/warcraftlogs";

export type WarcraftLogsCollectionPlanOptions = Readonly<{
  /**
   * Fight URLs whose parses are already stored, so a budget-limited run
   * spends its requests on what is still missing.
   */
  hydratedFightUrls?: ReadonlySet<string>;
  /**
   * When each zone's tier bests were last collected, keyed by raid id. A
   * zone collected after its newest kill has nothing left to fetch, so it
   * neither spends a request nor counts towards the zone budget -- without
   * this a veteran's zone list always exceeds the budget and the run
   * raises `parse_request_cap` forever, however saturated it is.
   */
  collectedTierZones?: ReadonlyMap<string, string>;
  /**
   * Raids this character is finished with, per parse domain. A terminal raid
   * costs no request: its zone is dropped before the zone budget is
   * measured, and its kills are never grouped for hydration.
   */
  terminalRaidIds?: Readonly<{
    parses: ReadonlySet<string>;
    tierBests: ReadonlySet<string>;
  }>;
  /**
   * The one Journal raid whose kills are parsed. A targeted search's
   * reports can hold another raid's fights from the same nights, and
   * parsing them would spend its budget on work it does not publish.
   * Resolved by boss as well as zone, so a combined zone's kills are
   * placed in their own raid.
   */
  parseJournalRaidId?: string;
}>;

/** The plan one `getFirstKillReports` call executes. */
export function createWarcraftLogsCollectionPlan(
  options: WarcraftLogsCollectionPlanOptions
): WarcraftLogsCollectionPlan {
  return {
    tierZones: (kills, parseRequestCap) =>
      tierZonePlan(kills, { ...options, parseRequestCap }),
    parseGroups: (kills) => parseGroupPlan(kills, options)
  };
}

/**
 * Which zones' tier bests to request, newest raid night first, and which the
 * budget will not reach.
 */
export function tierZonePlan(
  kills: Iterable<WarcraftLogsFirstKillEvidence>,
  options: Readonly<{
    parseRequestCap: number;
    collectedTierZones?: ReadonlyMap<string, string>;
    terminalRaidIds?: Readonly<{ tierBests: ReadonlySet<string> }>;
  }>
): Readonly<{
  zones: readonly WarcraftLogsTierZone[];
  unreached: readonly WarcraftLogsTierZone[];
}> {
  // The zones whose kills this dossier can display. A kill outside its raid's
  // current-content window is never shown, so its zone is not worth a
  // request; an unknown window is left in, because missing catalogue data
  // must not silently disable collection.
  const zones = new Map<string, WarcraftLogsTierZone>();
  for (const kill of kills) {
    if (currentContentEligibility(kill.killedAt, kill.raidName) === false) {
      continue;
    }
    // A zone that cannot be placed as a raid from after Mythic difficulty
    // existed can never answer a Mythic rankings request. Warcraft Logs
    // refuses it with an error envelope, which carries no rankings array and
    // so read as schema drift -- and a troubled raid never goes terminal, so
    // the wasted request was re-paid on every run, forever (#351).
    if (!raidOffersMythicRankings(kill)) continue;
    const zoneId = Number(kill.raidId);
    if (!Number.isSafeInteger(zoneId) || zoneId <= 0) continue;
    const seen = zones.get(kill.raidId);
    zones.set(
      kill.raidId,
      seen
        ? {
            ...seen,
            latestKilledAt:
              kill.killedAt > seen.latestKilledAt
                ? kill.killedAt
                : seen.latestKilledAt
          }
        : {
            zoneId,
            raidName: kill.raidName,
            latestKilledAt: kill.killedAt
          }
    );
  }
  // Half of what is left once the canonical identity request is reserved, so
  // a character with a long history still advances its per-fight hydration.
  // One request covers a whole tier, so the newest zones — the ones a
  // reviewer is reading — are reached immediately and deeper tiers land on
  // later runs. A budget with nothing to spare after per-fight hydration
  // buys no zones at all rather than starving the row that needs an exact
  // fight.
  const zoneRequestCap = Math.floor((options.parseRequestCap - 1) / 2);
  const orderedZones = [...zones.values()].sort(
    (a, b) =>
      b.latestKilledAt.localeCompare(a.latestKilledAt) || a.zoneId - b.zoneId
  );
  // A zone collected since its newest kill has nothing left to fetch, so it
  // is dropped before the budget is measured, not merely skipped inside it.
  // Without this the zone list is rebuilt whole on every run, a veteran
  // always exceeds the budget, and the run raises `parse_request_cap` no
  // matter how saturated it is -- while the budget re-reads the same newest
  // zones and never reaches the deeper ones it displaced.
  const pendingZones = orderedZones.filter((zone) => {
    const raidId = String(zone.zoneId);
    // A terminal zone is dropped before the budget is measured, not skipped
    // inside it, so it cannot raise a cap it no longer competes for.
    if (options.terminalRaidIds?.tierBests.has(raidId)) return false;
    const collectedAt = options.collectedTierZones?.get(raidId);
    return collectedAt === undefined || collectedAt <= zone.latestKilledAt;
  });
  return {
    zones: pendingZones.slice(0, zoneRequestCap),
    unreached: pendingZones.slice(zoneRequestCap)
  };
}

/**
 * Which kills to hydrate parses for, grouped by report. A raid night's kills
 * share one report, and one ranking request returns all of them, so grouping
 * any finer would spend a request per boss for data the first request already
 * carried.
 */
export function parseGroupPlan(
  kills: Iterable<WarcraftLogsFirstKillEvidence>,
  options: Readonly<{
    hydratedFightUrls?: ReadonlySet<string>;
    terminalRaidIds?: Readonly<{ parses: ReadonlySet<string> }>;
    parseJournalRaidId?: string;
  }>
): WarcraftLogsParseGroupPlan {
  const candidates = [...kills];
  const groups = new Map<string, WarcraftLogsParseGroup>();
  const raidIds = new Map<string, Set<string>>();
  const fightUrls = new Map<string, Set<string>>();
  // A boss's first kill is the evidence the dossier headlines, so the budget
  // must reach it before any repeat kill of the same boss.
  const firstKillFightUrls = new Set<string>();
  const earliestByBoss = new Map<
    string,
    { killedAt: string; fightUrl: string }
  >();
  for (const kill of candidates) {
    const bossKey = `${kill.raidId}\u0000${kill.bossId}\u0000${kill.difficulty}`;
    const seen = earliestByBoss.get(bossKey);
    if (!seen || kill.killedAt < seen.killedAt) {
      earliestByBoss.set(bossKey, {
        killedAt: kill.killedAt,
        fightUrl: kill.fightUrl
      });
    }
  }
  for (const entry of earliestByBoss.values())
    firstKillFightUrls.add(entry.fightUrl);

  for (const kill of candidates) {
    // A kill outside its raid's current-content window is never shown, so
    // hydrating it spends a scarce, rate-limited request on nothing. An
    // unknown window is left alone: absent catalogue data must not silently
    // disable hydration.
    if (currentContentEligibility(kill.killedAt, kill.raidName) === false) {
      continue;
    }
    // A raid finished with is not hydrated again: its first-kill parses were
    // read cleanly once, and a concluded tier cannot produce a new one.
    if (options.terminalRaidIds?.parses.has(kill.raidId)) continue;
    if (options.hydratedFightUrls?.has(kill.fightUrl)) continue;
    // Another raid's kill on a targeted search's nights is not its to parse.
    if (
      options.parseJournalRaidId !== undefined &&
      lookupRaidForEvidence(kill)?.raidId !== options.parseJournalRaidId
    ) {
      continue;
    }
    const raidsInGroup = raidIds.get(kill.reportCode);
    if (raidsInGroup) raidsInGroup.add(kill.raidId);
    else raidIds.set(kill.reportCode, new Set([kill.raidId]));
    const fightUrlsInGroup = fightUrls.get(kill.reportCode);
    if (fightUrlsInGroup) fightUrlsInGroup.add(kill.fightUrl);
    else fightUrls.set(kill.reportCode, new Set([kill.fightUrl]));
    const isFirstKill = firstKillFightUrls.has(kill.fightUrl);
    const existing = groups.get(kill.reportCode);
    const fight = {
      encounterId: Number(kill.bossId),
      difficulty: kill.difficulty
    };
    groups.set(
      kill.reportCode,
      existing
        ? {
            ...existing,
            fights: new Map(existing.fights).set(kill.fightId, fight),
            earliestKilledAt:
              kill.killedAt < existing.earliestKilledAt
                ? kill.killedAt
                : existing.earliestKilledAt,
            latestKilledAt:
              kill.killedAt > existing.latestKilledAt
                ? kill.killedAt
                : existing.latestKilledAt,
            hasFirstKill: existing.hasFirstKill || isFirstKill
          }
        : {
            reportCode: kill.reportCode,
            fights: new Map([[kill.fightId, fight]]),
            earliestKilledAt: kill.killedAt,
            latestKilledAt: kill.killedAt,
            hasFirstKill: isFirstKill
          }
    );
  }
  // Reports carrying a boss's first kill come first, newest tier before
  // oldest, then everything else. The budget is small and the upstream rate
  // limit tight, so what survives must be the evidence a dossier headlines,
  // starting with current content. Already-stored fights are skipped above,
  // so successive runs advance through the rest instead of redoing these.
  return {
    groups: [...groups.values()].sort(
      (a, b) =>
        Number(b.hasFirstKill) - Number(a.hasFirstKill) ||
        b.latestKilledAt.localeCompare(a.latestKilledAt) ||
        a.reportCode.localeCompare(b.reportCode)
    ),
    raidIds,
    fightUrls
  };
}
