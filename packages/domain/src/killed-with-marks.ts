import type { CharacterGuild, CharacterKey } from "./character-key";
import { canonicalCharacterId } from "./deduplicate";
import { guildIdentity } from "./guild-history";
import {
  lookupRaidEncounterByRaiderIoSlugs,
  lookupRaiderIoBoss
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
  characters: readonly CharacterKey[];
  log: "read" | "not_read" | "none";
}>;

/**
 * One UTC night of Raider.IO-logged kills that no Warcraft Logs kill
 * accounts for (#921). It records who the characters killed with, never
 * membership: it extends, splits or creates no guild's history.
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

function byCharacter(a: CharacterKey, b: CharacterKey): number {
  const left = canonicalCharacterId(a);
  const right = canonicalCharacterId(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

// A kill two characters share is one event: the most complete log state wins.
const LOG_RANK = { none: 0, not_read: 1, read: 2 } as const;

type Entry = {
  raidName: string;
  bossName: string;
  bossOrder: number;
  killedAt: string;
  at: number;
  guild: CharacterGuild | null;
  characters: Map<string, CharacterKey>;
  log: DossierKilledWithKill["log"];
};

/**
 * The "killed with" marks a dossier's Raider.IO first kills draw beside its
 * guild history.
 *
 * A Raider.IO kill is accounted for, and draws nothing, when a Warcraft Logs
 * kill has the same character (by canonical id, so a fight logged under a
 * former name still counts, being attributed to the character it belongs
 * to), the same boss and the same UTC day: that kill already places the
 * night in a guild. The rest are grouped by night, and within a night by boss
 * and credited guild. A boss the catalogue cannot place is left out, as it is
 * from the boss cards.
 */
export function collectKilledWithMarks(
  warcraftLogsKills: readonly KilledWithWarcraftLogsKill[],
  raiderIoKills: readonly KilledWithRaiderIoKill[]
): DossierKilledWithMark[] {
  if (raiderIoKills.length === 0) return [];
  const matchKey = (
    character: CharacterKey,
    raidSlug: string,
    bossSlug: string,
    day: string
  ) =>
    JSON.stringify([canonicalCharacterId(character), raidSlug, bossSlug, day]);
  const logged = new Set<string>();
  for (const kill of warcraftLogsKills) {
    const boss = lookupRaiderIoBoss(kill.raidName, kill.bossName);
    const day = utcDay(kill.killedAt);
    if (!boss || !day) continue;
    logged.add(matchKey(kill.character, boss.raidSlug, boss.bossSlug, day));
  }
  const nights = new Map<string, Map<string, Entry>>();
  for (const kill of raiderIoKills) {
    const day = utcDay(kill.killedAt);
    if (!day) continue;
    if (logged.has(matchKey(kill.character, kill.raidSlug, kill.bossSlug, day)))
      continue;
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
      encounter.raidId,
      encounter.bossId,
      guild ? guildIdentity(guild) : null
    ]);
    const night = nights.get(day) ?? new Map<string, Entry>();
    const at = Date.parse(kill.killedAt);
    const entry: Entry = night.get(key) ?? {
      raidName: encounter.raidName,
      bossName: encounter.bossName,
      bossOrder: encounter.bossOrder,
      killedAt: kill.killedAt,
      at,
      guild: guild
        ? { name: guild.name, region: guild.region, realm: guild.realm }
        : null,
      characters: new Map(),
      log: kill.encounter.state
    };
    if (at < entry.at) {
      entry.at = at;
      entry.killedAt = kill.killedAt;
    }
    if (LOG_RANK[kill.encounter.state] > LOG_RANK[entry.log])
      entry.log = kill.encounter.state;
    entry.characters.set(canonicalCharacterId(kill.character), kill.character);
    night.set(key, entry);
    nights.set(day, night);
  }
  return [...nights.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, kills]) => ({
      date,
      kills: [...kills.values()]
        .sort(
          (a, b) =>
            a.at - b.at ||
            a.bossOrder - b.bossOrder ||
            (a.guild?.name ?? "").localeCompare(b.guild?.name ?? "")
        )
        .map((kill) => ({
          raidName: kill.raidName,
          bossName: kill.bossName,
          killedAt: new Date(kill.at).toISOString(),
          guild: kill.guild,
          characters: [...kill.characters.values()].sort(byCharacter),
          log: kill.log
        }))
    }));
}
