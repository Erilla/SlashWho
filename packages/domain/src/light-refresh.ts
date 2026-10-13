import { raidContentWindowOpenedBetween } from "./raid-catalogue";

type TerminalTier = Readonly<{
  raidId: string;
  domain: "kills" | "parses" | "tier_bests";
}>;

type SettlementKill = Readonly<{
  raidId: string;
  killedAt: string;
  fightUrl: string;
}>;

type StoredEvidence = Readonly<{
  kills: readonly Readonly<{ raidId: string }>[];
  wipes: readonly Readonly<{ raidId: string }>[];
  lastCleanKillScanAt?: string;
  historyScanResumePage?: number;
  historicAliasProgress?: readonly Readonly<{
    historyScanResumePage?: number;
  }>[];
}>;

/**
 * Pure collection policy for a stale dossier read. The caller supplies one
 * transaction's values; this function cannot reach repositories or a pool.
 */
export function decideLightRefresh(options: {
  at: Date;
  completed: Readonly<{
    run: Readonly<{
      limitationCode: string | null;
      parseLimitationCode: string | null;
    }>;
  }> | null;
  completedVersionCurrent: boolean;
  stored: StoredEvidence;
  terminal: readonly TerminalTier[];
  recoveredAt: Date | null;
  kills: readonly SettlementKill[];
  hydratedFightUrls: readonly string[];
  collectedTierZones: readonly (readonly [string, string])[];
}): boolean {
  const { at, completed, completedVersionCurrent, stored, terminal } = options;
  if (
    completed === null ||
    !completedVersionCurrent ||
    completed.run.limitationCode !== null ||
    completed.run.parseLimitationCode !== null
  )
    return false;

  const terminalKillRaids = new Set(
    terminal
      .filter((tier) => tier.domain === "kills")
      .map((tier) => tier.raidId)
  );
  if (
    options.recoveredAt === null ||
    options.recoveredAt.getTime() <= at.getTime() - 7 * 24 * 60 * 60 * 1_000 ||
    [...stored.kills, ...stored.wipes].some(
      (held) => !terminalKillRaids.has(held.raidId)
    ) ||
    stored.lastCleanKillScanAt === undefined ||
    stored.historyScanResumePage !== undefined ||
    (stored.historicAliasProgress ?? []).some(
      (alias) => alias.historyScanResumePage !== undefined
    ) ||
    raidContentWindowOpenedBetween(new Date(stored.lastCleanKillScanAt), at)
  )
    return false;

  const raidIds = new Set(options.kills.map((kill) => kill.raidId));
  const terminalByDomain = new Map<string, Set<string>>();
  for (const tier of terminal) {
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

  const hydrated = new Set(options.hydratedFightUrls);
  if (!options.kills.every((kill) => hydrated.has(kill.fightUrl))) return false;
  const collected = new Map(options.collectedTierZones);
  return options.kills.every((kill) => {
    const collectedAt = collected.get(kill.raidId);
    return collectedAt !== undefined && collectedAt > kill.killedAt;
  });
}
