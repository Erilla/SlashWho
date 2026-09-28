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

/**
 * Where a resolved current-content window came from.
 *
 * `raiderio-raiding-static-data` is the generated snapshot, which is a union
 * across regions and so answers "was this raid current anywhere" -- optionally
 * widened further by a reviewed Blizzard announcement.
 * `blizzard-release-dates` is curated in full, because the schedule source does
 * not reach the raid at all; its bounds are sourced release dates rather than a
 * regional union, and the two are not the same quantity. Keeping the
 * distinction on the window means a reader can see which they are holding.
 */
export type RaidContentWindowSource =
  "raiderio-raiding-static-data" | "blizzard-release-dates";

export type RaidCurrentContentWindow = Readonly<{
  startsAt: string;
  endsAt: string | null;
  source: RaidContentWindowSource;
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

// Reviewed Mythic unlock windows, curated from Blizzard's season and raid
// announcements. Blizzard publishes unlock dates rather than one global instant
// valid in every region, so each is stored at 00:00:00Z to keep the boundary
// reproducible. A null end means no close had been reviewed yet, not that the
// tier never closes. See
// docs/research/2026-09-14-raid-current-content-windows.md.
/**
 * Raids that predate the schedule source, curated from Blizzard release dates.
 *
 * Raider.IO's raiding static data starts at Legion (it answers 400 for earlier
 * expansions), so these four Warlords-and-earlier raids have no generated
 * window and never will. Left unwindowed they read as `unknown`, which meant
 * they could never be marked terminal -- and one kill in any of them pinned
 * `killScanFloorFrom` to the bottom of a veteran's history, so the report scan
 * re-read all of it on every run and #304's saving never arrived (#326).
 *
 * `startsAt` is the raid's opening, at 00:00:00Z for a reproducible boundary,
 * the same convention as the reviewed windows above.
 *
 * `endsAt` is **the next tier's opening, recorded as exactly that** -- not a
 * separately sourced closing date. It is the same quantity Raider.IO's `ends`
 * approximates, and naming it honestly is worth more than implying a precision
 * we do not have. Hellfire Citadel therefore ends where the generated snapshot
 * starts The Emerald Nightmare, so the two schedules meet rather than overlap.
 *
 * These are superseded automatically: `resolveContentWindow` prefers a
 * generated window wherever one exists, so if Raider.IO ever extends coverage
 * backwards nobody has to remember to delete an entry here.
 */
const preLegionContentWindows = new Map<string, RaidCurrentContentWindow>([
  [
    // Siege of Orgrimmar, patch 5.4. Ends at Highmaul's opening.
    "369",
    {
      startsAt: "2013-09-10T00:00:00.000Z",
      endsAt: "2014-12-02T00:00:00.000Z",
      source: "blizzard-release-dates"
    }
  ],
  [
    // Highmaul, the first Warlords tier. Ends at Blackrock Foundry's opening.
    "477",
    {
      startsAt: "2014-12-02T00:00:00.000Z",
      endsAt: "2015-02-03T00:00:00.000Z",
      source: "blizzard-release-dates"
    }
  ],
  [
    // Blackrock Foundry. Ends at Hellfire Citadel's opening.
    "457",
    {
      startsAt: "2015-02-03T00:00:00.000Z",
      endsAt: "2015-06-23T00:00:00.000Z",
      source: "blizzard-release-dates"
    }
  ],
  [
    // Hellfire Citadel, the last Warlords tier. Ends where the generated
    // snapshot opens The Emerald Nightmare, which is the first raid Raider.IO
    // serves -- the seam between the two schedules.
    "669",
    {
      startsAt: "2015-06-23T00:00:00.000Z",
      endsAt: "2016-09-20T07:00:00.000Z",
      source: "blizzard-release-dates"
    }
  ]
]);

const reviewedContentWindows = new Map<string, RaidCurrentContentWindow>([
  [
    "1273",
    {
      startsAt: "2024-09-17T00:00:00.000Z",
      endsAt: "2025-03-04T00:00:00.000Z",
      source: "raiderio-raiding-static-data"
    }
  ],
  [
    "1296",
    {
      startsAt: "2025-03-04T00:00:00.000Z",
      endsAt: "2025-08-12T00:00:00.000Z",
      source: "raiderio-raiding-static-data"
    }
  ],
  [
    "1302",
    {
      startsAt: "2025-08-12T00:00:00.000Z",
      endsAt: "2026-03-17T00:00:00.000Z",
      source: "raiderio-raiding-static-data"
    }
  ],
  [
    "1305",
    {
      startsAt: "2026-05-20T00:00:00.000Z",
      endsAt: null,
      source: "raiderio-raiding-static-data"
    }
  ],
  [
    "1307",
    {
      startsAt: "2026-03-24T00:00:00.000Z",
      endsAt: null,
      source: "raiderio-raiding-static-data"
    }
  ],
  [
    "1308",
    {
      startsAt: "2026-03-31T00:00:00.000Z",
      endsAt: null,
      source: "raiderio-raiding-static-data"
    }
  ],
  [
    "1314",
    {
      startsAt: "2026-03-24T00:00:00.000Z",
      endsAt: null,
      source: "raiderio-raiding-static-data"
    }
  ],
  [
    "1317",
    {
      startsAt: "2026-08-19T00:00:00.000Z",
      endsAt: null,
      source: "raiderio-raiding-static-data"
    }
  ],
  [
    "1320",
    {
      startsAt: "2026-08-01T00:00:00.000Z",
      endsAt: null,
      source: "raiderio-raiding-static-data"
    }
  ]
]);

// Raider.IO's raiding static data publishes each raid's opening and closing per
// region, which is the only schedule reaching back past Nerub-ar Palace. It is
// generated rather than transcribed, so a new tier cannot be missed by
// omission.
const generatedContentWindows = new Map<string, RaidCurrentContentWindow>(
  [...raiderIoRaidSlugs].flatMap(([journalRaidId, raiderIoRaidSlug]) => {
    const window:
      Readonly<{ startsAt: string; endsAt: string | null }> | undefined =
      currentContentWindowSnapshot.windows[
        raiderIoRaidSlug as keyof typeof currentContentWindowSnapshot.windows
      ];
    // The snapshot carries one source for the whole file; stamp it per window
    // so a resolved window says where it came from without the reader having
    // to know which map it fell out of.
    return window
      ? [
          [
            journalRaidId,
            { ...window, source: "raiderio-raiding-static-data" as const }
          ] as const
        ]
      : [];
  })
);

/**
 * The widest window both sources support: the earliest known opening and the
 * latest known close.
 *
 * The two boundaries are not symmetric. A start earlier than the true Mythic
 * unlock cannot admit anything, because no Mythic kill predates Mythic opening,
 * whereas a start later than the unlock withholds real kills — so the earlier
 * start always wins. An end later than the true close does admit legacy farm
 * clears, but an end earlier than the close withholds real progression kills,
 * so the later known end wins. A null end is unknown rather than infinite: it
 * yields to any dated close, and survives only when neither source has one.
 */
function widestContentWindow(
  reviewed: RaidCurrentContentWindow | undefined,
  generated: RaidCurrentContentWindow | undefined
): RaidCurrentContentWindow | null {
  if (!reviewed) return generated ?? null;
  if (!generated) return reviewed;
  const ends = [reviewed.endsAt, generated.endsAt].flatMap((endsAt) =>
    endsAt === null ? [] : [endsAt]
  );
  return {
    startsAt:
      Date.parse(reviewed.startsAt) <= Date.parse(generated.startsAt)
        ? reviewed.startsAt
        : generated.startsAt,
    endsAt:
      ends.length === 0
        ? null
        : ends.reduce((latest, endsAt) =>
            Date.parse(endsAt) > Date.parse(latest) ? endsAt : latest
          ),
    // A widened window is still anchored on the generated schedule; the review
    // only ever moves a boundary outwards from it.
    source: generated.source
  };
}

/**
 * The window for one raid, and which source it came from.
 *
 * Two rules, and the difference between them is the point of the provenance:
 *
 * - A **pre-Legion** window is curated only because the schedule source does
 *   not reach that raid. A generated window therefore *replaces* it outright
 *   the moment one exists, so extending Raider.IO's coverage backwards needs
 *   nobody to remember to delete an entry here.
 * - A **reviewed** window is a Blizzard announcement deliberately widening a
 *   generated one, so the two are merged rather than ranked. Letting the
 *   generated value win there would narrow live tiers -- today it would cut 27
 *   days off Sporefall's opening and 15 off Manaforge Omega's close -- and a
 *   narrowed window withholds real progression kills.
 */
function resolveContentWindow(
  journalRaidId: string
): RaidCurrentContentWindow | null {
  const generated = generatedContentWindows.get(journalRaidId);
  if (generated) {
    return widestContentWindow(
      reviewedContentWindows.get(journalRaidId),
      generated
    );
  }
  return (
    preLegionContentWindows.get(journalRaidId) ??
    reviewedContentWindows.get(journalRaidId) ??
    null
  );
}

// An absent entry is unknown, never legacy - the raid-catalogue guard test
// asserts every catalogued raid resolves to a window from one source or the
// other, so a new tier fails the build instead of silently discarding kills or
// stranding a veteran's scan floor.
const currentContentWindows = new Map<string, RaidCurrentContentWindow>(
  [
    ...new Set([
      ...preLegionContentWindows.keys(),
      ...reviewedContentWindows.keys(),
      ...generatedContentWindows.keys()
    ])
  ].flatMap((journalRaidId) => {
    const window = resolveContentWindow(journalRaidId);
    return window ? [[journalRaidId, window] as const] : [];
  })
);

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
// labels. Most are the Journal name slugged; these are the verified
// exceptions, keyed by the immutable Journal encounter and checked against
// Raider.IO's raiding static data on 2026-09-27.
const raiderIoBossSlugOverrides = new Map<string, string>([
  ["1738", "ilgynoth-the-heart-of-corruption"],
  // Raider.IO ranks the two faction versions of Grong as one boss.
  ["2325", "grong"],
  ["2340", "grong"],
  ["2332", "uunat-harbinger-of-the-void"],
  ["2349", "zaqul"],
  ["2447", "fatescribe-rohkalo"],
  ["2459", "dausegne"],
  ["2461", "lihuvim"],
  ["2463", "halondrus"],
  ["2465", "skolex"],
  ["2499", "raszageth-the-stormeater"],
  ["2599", "sikran"],
  ["2644", "onearmed-bandit"],
  ["2691", "dimensius"],
  ["2736", "fallenking-salhadaar"]
]);

/**
 * Names Warcraft Logs gives an encounter that the Journal does not, read from
 * its zone encounter lists on 2026-09-27. None of these encounters carries a
 * usable `journalID` -- Warcraft Logs serves 0 -- so without an alias the kill
 * matches nothing and is withheld as an unmatched encounter.
 *
 * Within a named raid an alias is scoped to its encounter's own raid, so it can
 * never claim a boss elsewhere. It also joins the catalogue-wide unique-name
 * lookup, on the same terms as a Journal name: Warcraft Logs files Ny'alotha
 * kills under the zone name `Ny'alotha`, which names no Journal raid, so only
 * the boss can place them. `Wrathion` is here for that lookup alone -- inside
 * the raid, the legacy-prefix rule already reaches it.
 */
const warcraftLogsBossAliases = new Map<string, readonly string[]>([
  ["2025", ["The Defense of Eonar"]],
  ["2334", ["Mekkatorque"]],
  ["2368", ["Wrathion"]],
  ["2369", ["Prophet Skitra"]],
  ["2644", ["One-Armed Bandit"]]
]);

function normalizedName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleLowerCase("en-US");
}

/**
 * Journal encounters that are a faction's copy of an earlier one, keyed to the
 * encounter that stands for both.
 *
 * The Journal lists Battle of Dazar'alor's Champion of the Light and Jadefire
 * Masters, and Siege of Orgrimmar's Galakras, once for the Horde and once for
 * the Alliance under the same name. Warcraft Logs reports each as a single
 * encounter under that name, so no evidence can say which copy it is: the name
 * matched both, therefore neither, and every kill was withheld while two empty
 * cards stood in for the boss. A raid's same-named encounters are one boss,
 * listed where the Journal first lists it. The Grongs are not merged -- their
 * names differ in the Journal and in Warcraft Logs, so each resolves alone.
 */
const factionCopies = new Map<string, string>(
  catalogue.raids.flatMap((raid) => {
    const first = new Map<string, string>();
    return [...raid.encounters]
      .sort((a, b) => a.bossOrder - b.bossOrder)
      .flatMap((encounter) => {
        const key = normalizedName(encounter.bossName);
        const original = first.get(key);
        if (original === undefined) {
          first.set(key, encounter.journalBossId);
          return [];
        }
        return [[encounter.journalBossId, original] as const];
      });
  })
);

const encounters = new Map<string, RaidCatalogueEncounter>(
  catalogue.raids.flatMap((raid) =>
    raid.encounters
      .filter((encounter) => !factionCopies.has(encounter.journalBossId))
      .map(
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

/**
 * The comparison key for an instance name, shared with the dungeon catalogue
 * so the two are keyed alike and a name cannot be a raid under one spelling
 * and a dungeon under another.
 */
export function normalizedZoneName(value: string): string {
  return normalizedName(value);
}

/**
 * Whether the raid catalogue claims this name at all.
 *
 * Deliberately not `lookupRaidByName(...) !== null`: an ambiguous name is
 * stored as `null` and still belongs to a raid, so it must not be available
 * for anything else to claim.
 */
export function isCataloguedRaidName(raidName: string): boolean {
  return raidsByName.has(normalizedName(raidName));
}

// An ambiguous key is stored as `null`, so a colliding alias matches nothing
// rather than whichever encounter happened to be indexed last.
const encountersByName = new Map<string, RaidCatalogueEncounter | null>();
const encountersByBossName = new Map<string, RaidCatalogueEncounter | null>();
for (const encounter of encounters.values()) {
  for (const bossName of [
    encounter.bossName,
    ...(warcraftLogsBossAliases.get(encounter.bossId) ?? [])
  ]) {
    const key = `${normalizedName(encounter.raidName)}\0${normalizedName(bossName)}`;
    const existing = encountersByName.get(key);
    encountersByName.set(key, existing === undefined ? encounter : null);

    const bossKey = normalizedName(bossName);
    const existingBoss = encountersByBossName.get(bossKey);
    encountersByBossName.set(
      bossKey,
      existingBoss === undefined ? encounter : null
    );
  }
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
              .map((encounter) => encounters.get(encounter.journalBossId))
              .filter(
                (encounter): encounter is RaidCatalogueEncounter =>
                  encounter !== undefined
              )
              .sort((a, b) => a.bossOrder - b.bossOrder)
              .map((encounter) => Object.freeze({ ...encounter }))
          )
        });
      })
      .sort((a, b) => b.tierOrdinal - a.tierOrdinal)
  );
}

/** A faction copy resolves to the one boss that stands for both. */
export function lookupJournalEncounter(
  journalBossId: string
): RaidCatalogueEncounter | null {
  return (
    encounters.get(factionCopies.get(journalBossId) ?? journalBossId) ?? null
  );
}

/**
 * The encounter a raid and boss name identify, by the Journal's own names or a
 * reviewed Warcraft Logs alias for either.
 */
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
 * Warcraft Logs occasionally omits a Journal encounter's descriptive suffix.
 * A shortened name is usable only within a known raid and only when it names
 * exactly one encounter there; `Grong`, for example, deliberately stays
 * ambiguous in Battle of Dazar'alor.
 */
export function lookupRaidBossByLegacyName(
  raidId: string,
  bossName: string
): RaidCatalogueEncounter | null {
  const key = normalizedName(bossName);
  if (key.length === 0) return null;
  const matches = [...encounters.values()].filter(
    (encounter) =>
      encounter.raidId === raidId &&
      normalizedName(encounter.bossName).startsWith(key)
  );
  return matches.length === 1 ? matches[0]! : null;
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

/**
 * Warcraft Logs files some of a season's kills under a sibling raid's name. Its
 * ranking zone 53, `The Venomous Abyss`, also holds The Tidebound Grotto's
 * Nymrissa Wavecaller, and a fight's own game zone has placed Venomous Abyss
 * bosses in The Tidebound Grotto. A boss the named raid does not hold is placed
 * by its unique name, but only in a raid of the same tier, so a mislabelled
 * zone can never move a kill into another tier (#729).
 */
export function lookupSiblingRaidBossByName(
  raidName: string,
  bossName: string
): RaidCatalogueEncounter | null {
  const raid = lookupRaidByName(raidName);
  const encounter = lookupUniqueRaidBossByName(bossName);
  if (raid === null || encounter === null || encounter.raidId === raid.raidId)
    return null;
  const tiers = tierIndexByRaidName();
  const tier = tiers.get(normalizedName(raid.raidName));
  return tier !== undefined &&
    tier === tiers.get(normalizedName(encounter.raidName))
    ? encounter
    : null;
}

let tierIndexes: Map<string, number> | undefined;
function tierIndexByRaidName(): Map<string, number> {
  tierIndexes ??= new Map(
    raidTiers().flatMap((tier, index) =>
      tier.raidNames.map((name) => [normalizedName(name), index] as const)
    )
  );
  return tierIndexes;
}

/**
 * The encounter a kill, wipe or parse names, by whatever names it.
 *
 * Inside a named raid, the Journal's names and reviewed aliases come first,
 * then a Journal id belonging to that raid, then Warcraft Logs' shortened
 * legacy name, and last a same-tier sibling raid's boss. A zone that names no
 * raid can only be placed by the Journal id or a catalogue-wide unique boss
 * name.
 */
export function lookupRaidEncounterForEvidence(
  evidence: RaidEvidenceIdentity
): RaidCatalogueEncounter | null {
  const raid = lookupRaidByName(evidence.raidName);
  const journalEncounter =
    evidence.journalBossId === null
      ? null
      : lookupJournalEncounter(evidence.journalBossId);
  if (raid === null)
    return journalEncounter ?? lookupUniqueRaidBossByName(evidence.bossName);
  return (
    lookupRaidBossByName(evidence.raidName, evidence.bossName) ??
    (journalEncounter?.raidId === raid.raidId ? journalEncounter : null) ??
    lookupRaidBossByLegacyName(raid.raidId, evidence.bossName) ??
    lookupSiblingRaidBossByName(evidence.raidName, evidence.bossName)
  );
}

export function lookupRaidByName(raidName: string): RaidCatalogueRaid | null {
  return raidsByName.get(normalizedName(raidName)) ?? null;
}

export function lookupRaidCurrentContentWindow(
  raidId: string
): RaidCurrentContentWindow | null {
  return currentContentWindows.get(raidId) ?? null;
}

/**
 * When a Raider.IO raid slug stopped being current content: the latest close
 * among the catalogued raids filed under it, since one slug can carry several
 * (`tier-mn-1`). `null` when any of them is still open or cannot be placed in
 * time, and when nothing is filed under the slug -- never a close we do not
 * have.
 */
export function raiderIoRaidContentWindowEnd(raidSlug: string): string | null {
  const ends = [...raiderIoRaidSlugs]
    .filter(([, slug]) => slug === raidSlug)
    .map(([journalRaidId]) => currentContentWindows.get(journalRaidId)?.endsAt);
  if (ends.length === 0) return null;
  let latest: string | null = null;
  for (const endsAt of ends) {
    if (!endsAt || Number.isNaN(Date.parse(endsAt))) return null;
    if (latest === null || Date.parse(endsAt) > Date.parse(latest)) {
      latest = endsAt;
    }
  }
  return latest;
}

/**
 * Whether any catalogued raid's current-content window opened after `since`
 * and by `at`.
 *
 * A tier that has just opened has no terminal mark for anyone yet, so a
 * collection that looked settled before it opened is not evidence about it.
 * A start that cannot be read counts as opened: the caller is choosing the
 * cheaper collection, and must never choose it on a window it cannot place.
 */
export function raidContentWindowOpenedBetween(since: Date, at: Date): boolean {
  return [...currentContentWindows.values()].some((window) => {
    const startsAt = Date.parse(window.startsAt);
    return (
      Number.isNaN(startsAt) ||
      Number.isNaN(since.valueOf()) ||
      Number.isNaN(at.valueOf()) ||
      (startsAt > since.getTime() && startsAt <= at.getTime())
    );
  });
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

/**
 * Whether a kill falls inside its raid's current-content window.
 *
 * `null` means the window is unknown, which is not the same as outside it.
 * Callers that spend a budget should skip only a definite `false`: a raid with
 * no catalogued window must not silently disable hydration for everything.
 */
export function currentContentEligibility(
  killedAt: string,
  raidName: string
): boolean | null {
  const raid = lookupRaidByName(raidName);
  return raid === null
    ? null
    : currentContentEligibilityByRaidId(killedAt, raid.raidId);
}

/**
 * Whether a raid's current-content window has closed.
 *
 * `"unknown"` is not a weaker `"current"`. A raid the catalogue cannot place in
 * time must never be treated as terminal, because freezing undated evidence is
 * worse than re-querying it. Callers that store evidence indefinitely must act
 * on `"concluded"` alone.
 */
export type RaidTierConclusion = "concluded" | "current" | "unknown";

/**
 * One piece of Warcraft Logs evidence, as much of it as identifies its raid.
 */
export type RaidEvidenceIdentity = Readonly<{
  raidName: string;
  bossName: string;
  journalBossId: string | null;
}>;

/**
 * The raid a kill belongs to, by whatever names it.
 *
 * The zone name is tried first and answers for almost everything. The two
 * fallbacks exist because Warcraft Logs does not always give a name the
 * Journal shares: journal raid 1308 is reported under its in-game zone name
 * `Isle of Quel'Danas`, in a combined `VS / DR / MQD` report zone that serves
 * `journalID: 0` for every encounter in it, so only the boss identifies it.
 *
 * The dossier has always resolved kills this way, which is why those kills are
 * displayed. Marking a tier terminal did not, so a raid the dossier could name
 * was one the scan could never conclude -- it pinned the scan floor for good
 * while appearing perfectly healthy on the page (#346). The two must agree,
 * which is why both resolve the boss through `lookupRaidEncounterForEvidence`.
 * A boss the catalogue cannot place still leaves a named raid named.
 */
export function lookupRaidForEvidence(
  evidence: RaidEvidenceIdentity
): RaidCatalogueRaid | null {
  const encounter = lookupRaidEncounterForEvidence(evidence);
  return encounter === null
    ? lookupRaidByName(evidence.raidName)
    : lookupRaidByName(encounter.raidName);
}

/** The conclusion of the raid a kill belongs to, however it is named. */
export function raidTierConclusionForEvidence(
  evidence: RaidEvidenceIdentity,
  at: Date
): RaidTierConclusion {
  const raid = lookupRaidForEvidence(evidence);
  return raid === null
    ? "unknown"
    : raidTierConclusionForRaidId(raid.raidId, at);
}

export function raidTierConclusion(
  raidName: string,
  at: Date
): RaidTierConclusion {
  const raid = lookupRaidByName(raidName);
  if (raid === null) return "unknown";
  return raidTierConclusionForRaidId(raid.raidId, at);
}

function raidTierConclusionForRaidId(
  raidId: string,
  at: Date
): RaidTierConclusion {
  const window = lookupRaidCurrentContentWindow(raidId);
  if (!window) return "unknown";
  if (window.endsAt === null) return "current";
  const endsAt = Date.parse(window.endsAt);
  if (Number.isNaN(endsAt) || Number.isNaN(at.valueOf())) return "unknown";
  return endsAt <= at.getTime() ? "concluded" : "current";
}

/**
 * When Mythic difficulty began: the Warlords of Draenor pre-patch, 6.0.2.
 *
 * Recorded at 00:00:00Z for a reproducible boundary, the same convention the
 * curated content windows use. Nothing before it can be ranked at Mythic --
 * the tiers current at the time had Heroic as their top difficulty, and the
 * pre-patch renamed it rather than adding a difficulty to older tiers.
 */
const MYTHIC_DIFFICULTY_INTRODUCED_AT = Date.parse("2014-10-14T00:00:00.000Z");

/**
 * Whether Mythic difficulty existed while a raid was current content.
 *
 * A window that closed before the pre-patch describes a tier that never had
 * the difficulty, so no Mythic ranking for it can exist. A window still open,
 * or one whose close cannot be read, is not evidence of that and so keeps the
 * raid askable -- the rule only ever excludes a raid it can positively place
 * before the difficulty existed.
 */
export function mythicDifficultyExistedDuring(
  window: RaidCurrentContentWindow
): boolean {
  if (window.endsAt === null) return true;
  const endsAt = Date.parse(window.endsAt);
  return Number.isNaN(endsAt) || endsAt > MYTHIC_DIFFICULTY_INTRODUCED_AT;
}

/**
 * Whether asking Warcraft Logs for a raid's Mythic rankings is a question that
 * can have an answer.
 *
 * Warcraft Logs answers `zoneRankings(difficulty: 5)` for a zone that never had
 * Mythic difficulty with an error envelope rather than a rankings payload, and
 * an envelope has no `rankings` array -- so a legitimate refusal was read as
 * schema drift, which is a limitation, which stops the tier ever settling. The
 * request is therefore re-paid on every run, forever (#351).
 *
 * This is deliberately a **positive** identification, the same move the dungeon
 * catalogue makes one layer down: a zone is asked about only when it resolves
 * to a catalogued raid whose content window reaches the Mythic era. "Returned
 * an error once" is not a durable property of a zone, so it is never the
 * discriminator.
 *
 * Unlike the kill evidence itself, a zone nobody can place costs nothing to
 * leave out: the best-parse row stays unavailable, which is honest, and it
 * fills itself in as soon as the catalogue names the raid.
 */
export function raidOffersMythicRankings(
  evidence: RaidEvidenceIdentity
): boolean {
  const raid = lookupRaidForEvidence(evidence);
  if (raid === null) return false;
  const window = lookupRaidCurrentContentWindow(raid.raidId);
  return window === null ? false : mythicDifficultyExistedDuring(window);
}

/** The same rule keyed by journal raid id, for callers that already hold one. */
export function currentContentEligibilityByRaidId(
  killedAt: string,
  raidId: string
): boolean | null {
  const window = lookupRaidCurrentContentWindow(raidId);
  const at = Date.parse(killedAt);
  return !window || Number.isNaN(at)
    ? null
    : at >= Date.parse(window.startsAt) &&
        (window.endsAt === null || at < Date.parse(window.endsAt));
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
  // Resolved as the dossier resolves the kill, so the rank is asked about the
  // boss the kill is shown under. Raider.IO slugs the Journal name, not Warcraft
  // Logs' spelling of it; only a boss the catalogue cannot place falls back to
  // the name as given.
  const encounter =
    lookupRaidBossByName(raidName, bossName) ??
    lookupRaidBossByLegacyName(raid.raidId, bossName);
  const bossSlug =
    encounter?.raiderIoBossSlug ??
    raiderIoBossSlug(encounter?.bossName ?? bossName);
  return bossSlug ? { raidSlug: raid.raiderIoRaidSlug, bossSlug } : null;
}

/**
 * The encounter Raider.IO names by its own raid and boss slugs: the reverse of
 * `lookupRaiderIoBoss`, for evidence that arrives from Raider.IO rather than
 * from a Warcraft Logs zone (#732).
 *
 * Raider.IO ranks some bosses the Journal lists twice as one: both faction
 * versions of Grong override to `grong`. Such a kill is shown under the one
 * the Journal lists first. Two encounters that only happen to slug alike, or
 * that sit in different raids of one Raider.IO tier, stay ambiguous and place
 * nothing.
 */
export function lookupRaidEncounterByRaiderIoSlugs(
  raidSlug: string,
  bossSlug: string
): RaidCatalogueEncounter | null {
  const matches = [...encounters.values()]
    .filter(
      (encounter) =>
        raiderIoRaidSlugs.get(encounter.raidId) === raidSlug &&
        (encounter.raiderIoBossSlug ?? raiderIoBossSlug(encounter.bossName)) ===
          bossSlug
    )
    .sort((a, b) => a.bossOrder - b.bossOrder);
  const first = matches[0];
  if (!first) return null;
  if (matches.length === 1) return first;
  return matches.every(
    (encounter) =>
      encounter.raidId === first.raidId &&
      encounter.raiderIoBossSlug === bossSlug
  )
    ? first
    : null;
}

/**
 * One raid tier: the raids that were current together, and the day the tier
 * opened. A tier lasts until the next one opens.
 */
export type RaidTier = Readonly<{
  /** The tier's raids, joined for display. */
  name: string;
  raidNames: readonly string[];
  /** The opening day, `YYYY-MM-DD` in UTC. */
  startsOn: string;
}>;

// Raider.IO's windows are a union across regions, so one tier's close and the
// next tier's opening routinely overlap by a day or two. A raid opening within
// this margin of the current tier's close starts a new tier; one opening
// earlier than that was released into the current tier, as Trial of Valor,
// Crucible of Storms and Sporefall were.
const TIER_BOUNDARY_TOLERANCE_MS = 7 * 24 * 60 * 60_000;

/**
 * Every catalogued raid tier, oldest first, grouped from the schedule rather
 * than transcribed.
 *
 * The windows used are the schedule's own -- the generated Raider.IO windows
 * and the curated pre-Legion release dates -- and never the reviewed Blizzard
 * widenings. Those move a boundary outwards to admit kills, which is right for
 * deciding what evidence to withhold and wrong for saying when a tier began:
 * Venomous Abyss's reviewed opening would fold it into the previous tier. A
 * tier closes when its first raid does, since a side raid such as Trial of
 * Valor outlives the tier it was released into.
 */
export function raidTiers(): readonly RaidTier[] {
  const scheduled = catalogue.raids
    .flatMap((raid) => {
      const window =
        generatedContentWindows.get(raid.journalRaidId) ??
        preLegionContentWindows.get(raid.journalRaidId);
      return window ? [{ raidName: raid.raidName, window }] : [];
    })
    .sort(
      (a, b) =>
        Date.parse(a.window.startsAt) - Date.parse(b.window.startsAt) ||
        a.raidName.localeCompare(b.raidName)
    );
  const tiers: {
    raidNames: string[];
    startsAt: string;
    endsAt: string | null;
  }[] = [];
  for (const { raidName, window } of scheduled) {
    const current = tiers.at(-1);
    if (
      current &&
      (current.endsAt === null ||
        Date.parse(window.startsAt) <
          Date.parse(current.endsAt) - TIER_BOUNDARY_TOLERANCE_MS)
    ) {
      current.raidNames.push(raidName);
      continue;
    }
    tiers.push({
      raidNames: [raidName],
      startsAt: window.startsAt,
      endsAt: window.endsAt
    });
  }
  return Object.freeze(
    tiers.map((tier) =>
      Object.freeze({
        name: tier.raidNames.join(" / "),
        raidNames: Object.freeze([...tier.raidNames]),
        startsOn: tier.startsAt.slice(0, 10)
      })
    )
  );
}
