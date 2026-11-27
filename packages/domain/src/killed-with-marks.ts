import type { CharacterGuild, CharacterKey } from "./character-key";
import { canonicalCharacterId } from "./deduplicate";
import { guildIdentity } from "./guild-history";
import {
  lookupRaidEncounterByRaiderIoSlugs,
  lookupRaiderIoBoss,
  type RaidCatalogueEncounter
} from "./raid-catalogue";

/** A Raider.IO Mythic first kill, as far as guild history reads it (#921). */
export type KilledWithRaiderIoKill = Readonly<{
  character: CharacterKey;
  raidSlug: string;
  bossSlug: string;
  killedAt: string;
  guild: CharacterGuild | null;
  encounter:
    | Readonly<{
        state: "read";
        encounter: Readonly<{ guild: CharacterGuild | null }>;
      }>
    | Readonly<{ state: "not_read" }>
    | Readonly<{ state: "none" }>;
}>;

/** A Warcraft Logs kill, as far as matching it to Raider.IO needs. */
export type KilledWithWarcraftLogsKill = Readonly<{
  character: CharacterKey;
  killedAt: string;
  raidName: string;
  bossName: string;
  guild: CharacterGuild | null;
}>;

/**
 * A dossier character whose Warcraft Logs kill of the same boss on the same
 * UTC day names a guild, so the night is one of that guild's raid nights.
 */
export type DossierKilledWithLoggedNight = Readonly<{
  character: CharacterKey;
  guild: CharacterGuild;
}>;

/**
 * One boss a mark's night records: which dossier characters Raider.IO says
 * killed it, and the guild it credits. `log` says whether Raider.IO's own log
 * of the kill was read (`read`), is still to be read (`not_read`), or does
 * not exist (`none`).
 */
export type DossierKilledWithKill = Readonly<{
  raidName: string;
  bossName: string;
  /** The earliest of the characters' kill times. */
  killedAt: string;
  /** Null where Raider.IO names no guild; never read as guildless. */
  guild: CharacterGuild | null;
  /** Every dossier character Raider.IO puts on the kill. */
  characters: readonly CharacterKey[];
  /**
   * The characters whose night a Warcraft Logs kill already places in a
   * guild. Whether that guild's bar is drawn is the timeline's call: a guild
   * seen on one night, or one whose other nights are hidden, has none.
   */
  loggedNights: readonly DossierKilledWithLoggedNight[];
  log: "read" | "not_read" | "none";
}>;

/**
 * One UTC night of Raider.IO-logged kills (#921). It records who the
 * characters killed with, never membership: it extends, splits or creates no
 * guild's history.
 */
export type DossierKilledWithMark = Readonly<{
  /** `YYYY-MM-DD`, in UTC. */
  date: string;
  kills: readonly DossierKilledWithKill[];
}>;

function utcDay(timestamp: string): string | null {
  const at = Date.parse(timestamp);
  return Number.isNaN(at) ? null : new Date(at).toISOString().slice(0, 10);
}

function text(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byCharacter(a: CharacterKey, b: CharacterKey): number {
  return text(canonicalCharacterId(a), canonicalCharacterId(b));
}

function copyGuild(guild: CharacterGuild): CharacterGuild {
  return { name: guild.name, region: guild.region, realm: guild.realm };
}

// A kill two characters share is one event: the most complete log state wins.
const LOG_RANK = { none: 0, not_read: 1, read: 2 } as const;

type Entry = {
  encounter: RaidCatalogueEncounter;
  killedAt: string;
  at: number;
  guild: CharacterGuild | null;
  characters: Map<string, CharacterKey>;
  loggedNights: Map<string, DossierKilledWithLoggedNight>;
  log: DossierKilledWithKill["log"];
};

function encounterKey(encounter: RaidCatalogueEncounter): string {
  return JSON.stringify([encounter.raidId, encounter.bossId]);
}

/**
 * The "killed with" marks a dossier's Raider.IO first kills draw beside its
 * guild history.
 *
 * Kills are grouped by UTC night, and within a night by boss and credited
 * guild. Each records which of its characters a Warcraft Logs kill of the
 * same character (by canonical id, so a fight logged under a former name
 * still counts, being attributed to the character it belongs to), the same
 * catalogue boss and the same UTC day places in a guild. A Warcraft Logs
 * kill naming no guild places the night in none. Both sides meet in the
 * catalogue, so a boss either side cannot place matches nothing, and a
 * Raider.IO boss the catalogue cannot place is left out, as it is from the
 * boss cards.
 */
export function collectKilledWithMarks(
  warcraftLogsKills: readonly KilledWithWarcraftLogsKill[],
  raiderIoKills: readonly KilledWithRaiderIoKill[]
): DossierKilledWithMark[] {
  if (raiderIoKills.length === 0) return [];
  const matchKey = (
    character: CharacterKey,
    encounter: RaidCatalogueEncounter,
    day: string
  ) =>
    JSON.stringify([
      canonicalCharacterId(character),
      encounterKey(encounter),
      day
    ]);
  const logged = new Map<string, Map<string, CharacterGuild>>();
  for (const kill of warcraftLogsKills) {
    if (!kill.guild) continue;
    const slugs = lookupRaiderIoBoss(kill.raidName, kill.bossName);
    const encounter = slugs
      ? lookupRaidEncounterByRaiderIoSlugs(slugs.raidSlug, slugs.bossSlug)
      : null;
    const day = utcDay(kill.killedAt);
    if (!encounter || !day) continue;
    const key = matchKey(kill.character, encounter, day);
    const guilds = logged.get(key) ?? new Map<string, CharacterGuild>();
    const id = guildIdentity(kill.guild);
    if (!guilds.has(id)) guilds.set(id, copyGuild(kill.guild));
    logged.set(key, guilds);
  }
  const nights = new Map<string, Map<string, Entry>>();
  for (const kill of raiderIoKills) {
    const day = utcDay(kill.killedAt);
    if (!day) continue;
    const encounter = lookupRaidEncounterByRaiderIoSlugs(
      kill.raidSlug,
      kill.bossSlug
    );
    if (!encounter) continue;
    // Credited as the boss card credits it: the guild on Raider.IO's log
    // when that was read, otherwise the guild on its kill list.
    const guild =
      kill.encounter.state === "read"
        ? kill.encounter.encounter.guild
        : kill.guild;
    const key = JSON.stringify([
      encounterKey(encounter),
      guild ? guildIdentity(guild) : null
    ]);
    const night = nights.get(day) ?? new Map<string, Entry>();
    const at = Date.parse(kill.killedAt);
    const entry: Entry = night.get(key) ?? {
      encounter,
      killedAt: kill.killedAt,
      at,
      guild: guild ? copyGuild(guild) : null,
      characters: new Map(),
      loggedNights: new Map(),
      log: kill.encounter.state
    };
    if (at < entry.at) {
      entry.at = at;
      entry.killedAt = kill.killedAt;
    }
    if (LOG_RANK[kill.encounter.state] > LOG_RANK[entry.log])
      entry.log = kill.encounter.state;
    const characterId = canonicalCharacterId(kill.character);
    // The first spelling seen is kept, so the output never depends on order
    // beyond which spelling arrived first.
    if (!entry.characters.has(characterId))
      entry.characters.set(characterId, kill.character);
    for (const [id, loggedGuild] of logged.get(
      matchKey(kill.character, encounter, day)
    ) ?? []) {
      const nightKey = JSON.stringify([characterId, id]);
      if (!entry.loggedNights.has(nightKey))
        entry.loggedNights.set(nightKey, {
          character: entry.characters.get(characterId)!,
          guild: loggedGuild
        });
    }
    night.set(key, entry);
    nights.set(day, night);
  }
  return [...nights.entries()]
    .sort(([a], [b]) => text(a, b))
    .map(([date, kills]) => ({
      date,
      kills: [...kills.values()]
        .sort(
          (a, b) =>
            a.at - b.at ||
            a.encounter.bossOrder - b.encounter.bossOrder ||
            text(a.encounter.raidId, b.encounter.raidId) ||
            (a.guild === null || b.guild === null
              ? a.guild === b.guild
                ? 0
                : a.guild === null
                  ? 1
                  : -1
              : text(guildIdentity(a.guild), guildIdentity(b.guild)))
        )
        .map((kill) => ({
          raidName: kill.encounter.raidName,
          bossName: kill.encounter.bossName,
          killedAt: new Date(kill.at).toISOString(),
          guild: kill.guild,
          characters: [...kill.characters.values()].sort(byCharacter),
          loggedNights: [...kill.loggedNights.values()].sort(
            (a, b) =>
              byCharacter(a.character, b.character) ||
              text(guildIdentity(a.guild), guildIdentity(b.guild))
          ),
          log: kill.log
        }))
    }));
}
