import catalogue from "./raid-catalogue.generated.json";
import currentContentWindowSnapshot from "./raid-current-content-windows.generated.json";

export type RaidCatalogueEncounter = Readonly<{
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  bossOrder: number;
  isFinalBoss: boolean;
  raiderIoBossSlug: string | null;
  imageUrl: string | null;
}>;

export type RaidCurrentContentWindow = Readonly<{
  startsAt: string;
  endsAt: string | null;
}>;

const raiderIoRaidSlugs = new Map<string, string>([
  ["768", "the-emerald-nightmare"],
  ["786", "the-nighthold"],
  ["861", "trial-of-valor"],
  ["875", "tomb-of-sargeras"],
  ["946", "antorus-the-burning-throne"],
  ["1031", "uldir"],
  ["1176", "battle-of-dazaralor"],
  ["1177", "crucible-of-storms"],
  ["1179", "the-eternal-palace"],
  ["1180", "nyalotha-the-waking-city"],
  ["1190", "castle-nathria"],
  ["1193", "sanctum-of-domination"],
  ["1195", "sepulcher-of-the-first-ones"],
  ["1200", "vault-of-the-incarnates"],
  ["1207", "amirdrassil-the-dreams-hope"],
  ["1208", "aberrus-the-shadowed-crucible"],
  ["1273", "nerubar-palace"],
  ["1296", "liberation-of-undermine"],
  ["1302", "manaforge-omega"],
  ["1305", "sporefall"],
  // Raider.IO combines the three opening Midnight raids into one tier.
  ["1307", "tier-mn-1"],
  ["1308", "tier-mn-1"],
  ["1314", "tier-mn-1"],
  ["1317", "the-tidebound-grotto"],
  ["1320", "the-venomous-abyss"]
]);

// Raider.IO's raiding static data is the schedule source: it publishes each
// raid's opening and closing per region, so the windows are generated rather
// than transcribed. Windows are [start, end) in UTC and a null end means the
// tier has no announced close. An absent entry is unknown, never legacy — the
// raid-catalogue guard test keeps that set to the raids Raider.IO does not
// serve, so a new tier fails the build instead of silently discarding kills.
const currentContentWindows = new Map<string, RaidCurrentContentWindow>(
  [...raiderIoRaidSlugs].flatMap(([journalRaidId, raiderIoRaidSlug]) => {
    const window: RaidCurrentContentWindow | undefined =
      currentContentWindowSnapshot.windows[
        raiderIoRaidSlug as keyof typeof currentContentWindowSnapshot.windows
      ];
    return window ? [[journalRaidId, window] as const] : [];
  })
);

/**
 * Catalogued raids with no current-content window, and therefore no shown
 * Mythic kills. Raider.IO's raiding static data starts at Legion, so the four
 * Warlords-and-earlier raids have no published schedule to generate from.
 */
export const raidsWithoutCurrentContentWindow: readonly string[] =
  Object.freeze(["369", "457", "477", "669"]);

const canonicalTierOrdinals = new Map<string, number>([
  ["369", 0],
  ["477", 1],
  ["457", 2],
  ["669", 3],
  ["768", 4],
  ["786", 5],
  ["861", 6],
  ["875", 7],
  ["946", 8],
  ["1031", 9],
  ["1176", 10],
  ["1177", 11],
  ["1179", 12],
  ["1180", 13],
  ["1190", 14],
  ["1193", 15],
  ["1195", 16],
  ["1200", 17],
  ["1208", 18],
  ["1207", 19],
  ["1273", 20],
  ["1296", 21],
  ["1302", 22],
  ["1305", 23],
  ["1307", 24],
  ["1308", 25],
  ["1314", 26],
  ["1317", 27],
  ["1320", 28]
]);

// Raider.IO boss slugs are identifiers, not mechanically derived display
// labels. Keep verified exceptions keyed by the immutable Journal encounter.
const raiderIoBossSlugOverrides = new Map<string, string>([
  ["2332", "uunat-harbinger-of-the-void"],
  ["2599", "sikran"],
  ["2691", "dimensius"],
  ["2736", "fallenking-salhadaar"]
]);

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
            bossOrder: encounter.bossOrder,
            isFinalBoss:
              encounter.bossOrder ===
              Math.max(...raid.encounters.map((item) => item.bossOrder)),
            raiderIoBossSlug:
              raiderIoBossSlugOverrides.get(encounter.journalBossId) ?? null,
            imageUrl: encounter.imageUrl
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
const encountersByBossName = new Map<string, RaidCatalogueEncounter | null>();
for (const encounter of encounters.values()) {
  const key = `${normalizedName(encounter.raidName)}\0${normalizedName(encounter.bossName)}`;
  const existing = encountersByName.get(key);
  encountersByName.set(key, existing === undefined ? encounter : null);

  const bossKey = normalizedName(encounter.bossName);
  const existingBoss = encountersByBossName.get(bossKey);
  encountersByBossName.set(
    bossKey,
    existingBoss === undefined ? encounter : null
  );
}

export type RaidCatalogueRaid = Readonly<{
  raidId: string;
  raidName: string;
  imageUrl: string | null;
  tierOrdinal: number;
  raiderIoRaidSlug: string | null;
}>;

export type SupportedRaidCatalogueEntry = RaidCatalogueRaid &
  Readonly<{ encounters: readonly RaidCatalogueEncounter[] }>;

const raidsByName = new Map<string, RaidCatalogueRaid | null>();
for (const [tierOrdinal, raid] of catalogue.raids.entries()) {
  const key = normalizedName(raid.raidName);
  const current = raidsByName.get(key);
  const candidate = {
    raidId: raid.journalRaidId,
    raidName: raid.raidName,
    imageUrl: raid.imageUrl,
    tierOrdinal: canonicalTierOrdinals.get(raid.journalRaidId) ?? tierOrdinal,
    raiderIoRaidSlug: raiderIoRaidSlugs.get(raid.journalRaidId) ?? null
  };
  raidsByName.set(key, current === undefined ? candidate : null);
}

export function supportedRaidCatalogue(): readonly SupportedRaidCatalogueEntry[] {
  return Object.freeze(
    catalogue.raids
      .map((raid, tierOrdinal) => {
        const metadata = lookupRaidByName(raid.raidName);
        if (!metadata) throw new Error("invalid_raid_catalogue");
        return Object.freeze({
          ...metadata,
          tierOrdinal:
            canonicalTierOrdinals.get(raid.journalRaidId) ?? tierOrdinal,
          encounters: Object.freeze(
            raid.encounters
              .map((encounter) =>
                lookupJournalEncounter(encounter.journalBossId)
              )
              .filter(
                (encounter): encounter is RaidCatalogueEncounter =>
                  encounter !== null
              )
              .sort((a, b) => a.bossOrder - b.bossOrder)
              .map((encounter) => Object.freeze({ ...encounter }))
          )
        });
      })
      .sort((a, b) => b.tierOrdinal - a.tierOrdinal)
  );
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

/**
 * Warcraft Logs sometimes reports a combined raid-zone label. A boss name can
 * still restore the Journal raid only when it is unique in the catalogue.
 */
export function lookupUniqueRaidBossByName(
  bossName: string
): RaidCatalogueEncounter | null {
  return encountersByBossName.get(normalizedName(bossName)) ?? null;
}

export function lookupRaidByName(raidName: string): RaidCatalogueRaid | null {
  return raidsByName.get(normalizedName(raidName)) ?? null;
}

export function lookupRaidCurrentContentWindow(
  raidId: string
): RaidCurrentContentWindow | null {
  return currentContentWindows.get(raidId) ?? null;
}

function raiderIoBossSlug(bossName: string): string {
  return bossName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLocaleLowerCase("en-US");
}

export function lookupRaiderIoBoss(
  raidName: string,
  bossName: string
): Readonly<{ raidSlug: string; bossSlug: string }> | null {
  // WCL stores the opening Midnight raids as a combined zone. Resolve only
  // bosses belonging to that tier; do not reinterpret arbitrary zone labels.
  if (normalizedName(raidName) === normalizedName("VS / DR / MQD")) {
    const encounter = lookupUniqueRaidBossByName(bossName);
    if (!encounter || raiderIoRaidSlugs.get(encounter.raidId) !== "tier-mn-1")
      return null;
    return lookupRaiderIoBoss(encounter.raidName, encounter.bossName);
  }
  const raid = lookupRaidByName(raidName);
  if (!raid?.raiderIoRaidSlug) return null;
  const encounter = lookupRaidBossByName(raidName, bossName);
  const bossSlug = encounter?.raiderIoBossSlug ?? raiderIoBossSlug(bossName);
  return bossSlug ? { raidSlug: raid.raiderIoRaidSlug, bossSlug } : null;
}
