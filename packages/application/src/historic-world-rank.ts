import { lookupRaiderIoBoss, type CharacterKey } from "@slashwho/domain";
import type {
  MythicBossRanking,
  MythicBossRankingsOptions
} from "@slashwho/raiderio";

type RankableKill = Readonly<{
  raidName: string;
  bossName: string;
  killedAt: string;
  guild: { name: string; realm: string } | null;
}>;

function normalizedIdentity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleLowerCase("en-US");
}

function normalizedRealm(value: string): string {
  return normalizedIdentity(value).replace(/^connected/, "");
}

export function historicWorldRankForKill(
  kill: RankableKill,
  region: CharacterKey["region"],
  rankings: readonly MythicBossRanking[]
): number | null {
  if (!kill.guild) return null;
  const killedAt = Date.parse(kill.killedAt);
  if (!Number.isFinite(killedAt)) return null;
  const boss = lookupRaiderIoBoss(kill.raidName, kill.bossName);
  const matches = rankings.filter(
    (ranking) =>
      (!ranking.bossSlug || ranking.bossSlug === boss?.bossSlug) &&
      normalizedIdentity(ranking.guildName) ===
        normalizedIdentity(kill.guild!.name) &&
      normalizedRealm(ranking.guildRealm) ===
        normalizedRealm(kill.guild!.realm) &&
      normalizedIdentity(ranking.guildRegion) === normalizedIdentity(region) &&
      Math.abs(Date.parse(ranking.firstDefeated) - killedAt) <= 120_000
  );
  return matches.length === 1 ? matches[0]!.rank : null;
}

export function raiderIoRankingRequest(
  kill: RankableKill,
  region: CharacterKey["region"]
): MythicBossRankingsOptions | null {
  if (!kill.guild) return null;
  const boss = lookupRaiderIoBoss(kill.raidName, kill.bossName);
  return boss ? { ...boss, guild: { ...kill.guild, region } } : null;
}

export function rankingRequestKey(request: MythicBossRankingsOptions): string {
  return JSON.stringify(
    request.guild
      ? [
          request.raidSlug,
          request.guild.region,
          request.guild.realm,
          request.guild.name
        ]
      : [request.raidSlug, request.bossSlug]
  );
}
