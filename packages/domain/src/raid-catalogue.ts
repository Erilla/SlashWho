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
    raid.encounters.map(
      (encounter) =>
        [
          encounter.journalBossId,
          {
            raidId: raid.journalRaidId,
            raidName: raid.raidName,
            bossId: encounter.journalBossId,
            bossName: encounter.bossName,
            bossOrder: encounter.bossOrder
          }
        ] as const
    )
  )
);

function normalizedName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleLowerCase("en-US");
}

const encountersByName = new Map<string, RaidCatalogueEncounter | null>();
for (const encounter of encounters.values()) {
  const key = `${normalizedName(encounter.raidName)}\0${normalizedName(encounter.bossName)}`;
  const existing = encountersByName.get(key);
  encountersByName.set(key, existing === undefined ? encounter : null);
}

export function lookupJournalEncounter(
  journalBossId: string
): RaidCatalogueEncounter | null {
  return encounters.get(journalBossId) ?? null;
}

export function lookupRaidBossByName(
  raidName: string,
  bossName: string
): RaidCatalogueEncounter | null {
  return (
    encountersByName.get(
      `${normalizedName(raidName)}\0${normalizedName(bossName)}`
    ) ?? null
  );
}
