import catalogue from "./raid-catalogue.generated.json";

export type RaidCatalogueEncounter = Readonly<{
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  bossOrder: number;
}>;

const encounters = new Map<string, RaidCatalogueEncounter>(
  catalogue.raids.flatMap((raid) =>
    raid.encounters.map((encounter) => [
      encounter.journalBossId,
      {
        raidId: raid.journalRaidId,
        raidName: raid.raidName,
        bossId: encounter.journalBossId,
        bossName: encounter.bossName,
        bossOrder: encounter.bossOrder
      }
    ] as const)
  )
);

export function lookupJournalEncounter(
  journalBossId: string
): RaidCatalogueEncounter | null {
  return encounters.get(journalBossId) ?? null;
}
