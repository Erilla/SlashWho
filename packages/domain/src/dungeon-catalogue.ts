import dungeonCatalogue from "./dungeon-catalogue.generated.json";
import { isCataloguedRaidName, normalizedZoneName } from "./raid-catalogue";

/**
 * Whether a Warcraft Logs zone is a Journal dungeon.
 *
 * Warcraft Logs files a Mythic dungeon boss at the same difficulty as a Mythic
 * raid boss, so the history scan cannot tell them apart by difficulty. Left
 * unclassified, a dungeon kill is stored as raid evidence in a zone no raid
 * catalogue will ever hold: it can never be placed in a content window, so it
 * can never be marked terminal, and one of them pinned `killScanFloorFrom` to
 * the bottom of a veteran's history -- 88% of every run's cost, re-paid every
 * twenty minutes (#346). The same unplaceable zones raised
 * `unmatched_encounter` on the dossier, which is the same defect wearing its
 * display clothes.
 *
 * This is deliberately a **positive** identification, and the distinction is
 * the whole point. "Not a catalogued raid" also describes a genuinely new raid
 * the catalogue has not caught up with, and silently discarding that reads as
 * "never killed it". A zone in neither catalogue therefore keeps today's
 * conservative behaviour: it is still collected, still raises
 * `unmatched_encounter`, and still holds the scan open.
 *
 * A raid name always wins. The generated catalogues do not overlap today and a
 * guard test fails the build if they ever do, but a collision here would
 * discard real raid evidence, so it is answered rather than assumed.
 */
const dungeonNames = new Set(
  dungeonCatalogue.dungeons
    .filter((dungeon) => !isCataloguedRaidName(dungeon.dungeonName))
    .map((dungeon) => normalizedZoneName(dungeon.dungeonName))
);

export function isKnownDungeonZone(zoneName: string): boolean {
  return dungeonNames.has(normalizedZoneName(zoneName));
}

/**
 * Warcraft Logs' own non-raid zone labels.
 *
 * A fight that does not carry its own game zone falls back to the report's,
 * and a report of a Mythic+ night is filed under the dungeon season rather
 * than under any instance. These names are Warcraft Logs' groupings, not
 * Journal instances, so no catalogue holds them.
 */
function isNonRaidWclZoneLabel(zoneName: string): boolean {
  return /^(?:mythic\+\s+seasons?|(?:normal|heroic|mythic)\s+dungeons)\b/i.test(
    zoneName.trim()
  );
}

/**
 * Whether a zone is known not to be a raid.
 *
 * The single gate for "this is not raid evidence", shared by the history scan,
 * the scan floor and the dossier so the three cannot disagree about what a
 * zone is. False for anything unrecognised, which is the conservative answer:
 * an unplaceable raid-shaped zone is still collected, still raises
 * `unmatched_encounter`, and still holds the scan open.
 */
export function isNonRaidZone(zoneName: string): boolean {
  return isNonRaidWclZoneLabel(zoneName) || isKnownDungeonZone(zoneName);
}
