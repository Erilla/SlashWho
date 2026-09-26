import type { CharacterGuild, CharacterKey } from "./character-key";
import { canonicalCharacterId } from "./deduplicate";
import type { RaidTier } from "./raid-catalogue";

/**
 * One UTC calendar day on which dossier characters killed a Mythic boss in a
 * report naming the guild, and which of them did.
 */
export type DossierGuildRaidNight = Readonly<{
  /** `YYYY-MM-DD`, in UTC. */
  date: string;
  characters: readonly CharacterKey[];
}>;

/** Every raid night the dossier's kills place in one guild, oldest first. */
export type DossierGuildHistoryEntry = Readonly<{
  guild: CharacterGuild;
  nights: readonly DossierGuildRaidNight[];
}>;

type GuildKill = Readonly<{
  character: CharacterKey;
  killedAt: string;
  guild: CharacterGuild | null;
}>;

function comparable(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\s'-]+/gu, "")
    .toLocaleLowerCase("en-US");
}

/**
 * Which guild a name refers to. Names differing only in case or spacing are
 * one guild -- "Seriously Casual" was renamed "SeriouslyCasual" -- while the
 * same name on another realm or region is another guild.
 */
export function guildIdentity(guild: CharacterGuild): string {
  return JSON.stringify([
    guild.region,
    comparable(guild.realm),
    comparable(guild.name)
  ]);
}

function byCharacter(a: CharacterKey, b: CharacterKey): number {
  const left = canonicalCharacterId(a);
  const right = canonicalCharacterId(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The raid nights a dossier's kills place in each guild. A kill whose report
 * names no guild says nothing about membership, so it is left out rather than
 * read as guildless. A guild is named as it was on its most recent kill.
 */
export function collectGuildRaidNights(
  kills: readonly GuildKill[]
): DossierGuildHistoryEntry[] {
  const guilds = new Map<
    string,
    {
      guild: CharacterGuild;
      seenAt: string;
      nights: Map<string, Map<string, CharacterKey>>;
    }
  >();
  for (const kill of kills) {
    if (!kill.guild) continue;
    const id = guildIdentity(kill.guild);
    const entry = guilds.get(id) ?? {
      guild: kill.guild,
      seenAt: kill.killedAt,
      nights: new Map()
    };
    if (kill.killedAt > entry.seenAt) {
      entry.guild = kill.guild;
      entry.seenAt = kill.killedAt;
    }
    const date = kill.killedAt.slice(0, 10);
    const night = entry.nights.get(date) ?? new Map<string, CharacterKey>();
    night.set(canonicalCharacterId(kill.character), kill.character);
    entry.nights.set(date, night);
    guilds.set(id, entry);
  }
  return [...guilds.values()]
    .map((entry) => ({
      guild: {
        name: entry.guild.name,
        region: entry.guild.region,
        realm: entry.guild.realm
      },
      nights: [...entry.nights.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, characters]) => ({
          date,
          characters: [...characters.values()].sort(byCharacter)
        }))
    }))
    .sort(
      (a, b) =>
        (a.nights[0]!.date < b.nights[0]!.date
          ? -1
          : a.nights[0]!.date > b.nights[0]!.date
            ? 1
            : 0) || a.guild.name.localeCompare(b.guild.name)
    );
}

/** One continuous stretch of raid nights in a guild. */
export type GuildTimelineSpan = Readonly<{
  guild: CharacterGuild;
  guildId: string;
  firstNight: string;
  lastNight: string;
  nights: number;
  characters: readonly CharacterKey[];
  /** The tiers its nights fall in, oldest first. */
  tiers: readonly string[];
}>;

export type GuildTimelineOptions = Readonly<{
  tiers: readonly RaidTier[];
  /** Characters the viewer has hidden contribute no nights. */
  isCharacterVisible?: (key: CharacterKey) => boolean;
}>;

/** A guild seen on a single night is a pug or a favour, not a membership. */
const MINIMUM_GUILD_NIGHTS = 2;

function tierIndex(tiers: readonly RaidTier[], date: string): number {
  let index = -1;
  for (const [candidate, tier] of tiers.entries()) {
    if (tier.startsOn > date) break;
    index = candidate;
  }
  return index;
}

/**
 * The stretches a timeline draws for a dossier's guilds.
 *
 * A guild's stretch runs from one raid night to the next for as long as no
 * whole tier passes between them: a gap inside a tier, or across two
 * neighbouring tiers, is a quiet spell rather than a departure. Guilds left
 * with a single night once hidden characters are removed are not shown.
 */
export function guildTimelineSpans(
  history: readonly DossierGuildHistoryEntry[],
  options: GuildTimelineOptions
): GuildTimelineSpan[] {
  const visible = options.isCharacterVisible ?? (() => true);
  const spans: GuildTimelineSpan[] = [];
  for (const entry of history) {
    const nights = entry.nights.flatMap((night) => {
      const characters = night.characters.filter(visible);
      return characters.length === 0 ? [] : [{ ...night, characters }];
    });
    if (nights.length < MINIMUM_GUILD_NIGHTS) continue;
    const guildId = guildIdentity(entry.guild);
    let current:
      | {
          firstNight: string;
          lastNight: string;
          nights: number;
          tier: number;
          characters: Map<string, CharacterKey>;
          tiers: Set<number>;
        }
      | undefined;
    const close = () => {
      if (!current) return;
      spans.push({
        guild: entry.guild,
        guildId,
        firstNight: current.firstNight,
        lastNight: current.lastNight,
        nights: current.nights,
        characters: [...current.characters.values()].sort(byCharacter),
        tiers: [...current.tiers]
          .filter((index) => index >= 0)
          .sort((a, b) => a - b)
          .map((index) => options.tiers[index]!.name)
      });
    };
    for (const night of nights) {
      const tier = tierIndex(options.tiers, night.date);
      if (!current || tier > current.tier + 1) {
        close();
        current = {
          firstNight: night.date,
          lastNight: night.date,
          nights: 0,
          tier,
          characters: new Map(),
          tiers: new Set()
        };
      }
      current.lastNight = night.date;
      current.nights += 1;
      current.tier = tier;
      current.tiers.add(tier);
      for (const character of night.characters) {
        current.characters.set(canonicalCharacterId(character), character);
      }
    }
    close();
  }
  return spans.sort(
    (a, b) =>
      (a.firstNight < b.firstNight
        ? -1
        : a.firstNight > b.firstNight
          ? 1
          : 0) || a.guild.name.localeCompare(b.guild.name)
  );
}
