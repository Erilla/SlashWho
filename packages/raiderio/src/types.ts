import type { CharacterGuild, CharacterKey } from "@slashwho/domain";

export interface RaiderIoCharacter {
  readonly key: CharacterKey;
  readonly displayName: string;
  readonly className: string;
  readonly level: number;
  /** The character's guild as at this observation, or null when guildless. */
  readonly guild: CharacterGuild | null;
  readonly ownerId: string | null;
  readonly profileGuess: string | null;
  readonly declaredMain: CharacterKey | null;
  /** Explicit upstream tournament evidence; never infer this from a realm name. */
  readonly isTournamentProfile?: boolean;
  /**
   * True when the upstream payload named at least one related character this
   * system cannot represent, so anything derived from it is knowingly incomplete.
   */
  readonly omittedMembers?: boolean;
}

export interface RaiderIoProfile {
  readonly characters: readonly RaiderIoCharacter[];
  /** See {@link RaiderIoCharacter.omittedMembers}. */
  readonly omittedMembers?: boolean;
}

/** @deprecated Raider.IO does not publish per-character historic kills. */
export type RaiderIoEvidenceLimitation =
  | "not_found"
  | "private"
  | "rate_limited"
  | "request_cap"
  | "unavailable"
  | "schema_drift";

/** @deprecated Never use as dossier evidence; retained temporarily for API compatibility. */
export type HistoricMythicKill = Readonly<{
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  bossOrder: number;
  isFinalBoss: boolean;
  firstDefeated: string;
  guild: { name: string; realm: string } | null;
  historicWorldRank: number | null;
}>;

export type HistoricMythicKillResult =
  | { kind: "evidence"; kills: readonly HistoricMythicKill[] }
  | {
      kind: "limitation";
      code: RaiderIoEvidenceLimitation;
      retryAfterMs?: number;
    };

export type HistoricMythicKillOptions = Readonly<{
  tierOrdinals: readonly number[];
  requestCap?: number;
  signal?: AbortSignal;
}>;

export type MythicBossRanking = Readonly<{
  bossSlug?: string;
  rank: number;
  guildName: string;
  guildRealm: string;
  guildRegion: string;
  firstDefeated: string;
}>;

export type MythicBossRankingsOptions = Readonly<{
  raidSlug: string;
  bossSlug: string;
  /** When supplied, returns all confirmed boss ranks for this guild and raid. */
  guild?: Readonly<{ name: string; realm: string; region: string }>;
}>;

export type MythicBossRankingsResult =
  | { kind: "rankings"; rows: readonly MythicBossRanking[] }
  | {
      kind: "limitation";
      code: RaiderIoEvidenceLimitation;
      retryAfterMs?: number;
      /**
       * When the limitation was actually observed, as an ISO timestamp. Set by
       * the dossier gateway so a replayed (negatively cached) limitation is
       * reported with the age of the failure that produced it rather than the
       * time it was replayed.
       */
      observedAt?: string;
    };

export interface RaiderIoGateway {
  getCharacter(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<RaiderIoCharacter>;
  getClaimedCharacters(
    ownerId: string,
    signal?: AbortSignal
  ): Promise<RaiderIoProfile>;
  resolveProfileGuess(
    value: string,
    signal?: AbortSignal
  ): Promise<RaiderIoProfile | null>;
  /** @deprecated Dossier evidence must come from Warcraft Logs. */
  getHistoricMythicKills(
    key: CharacterKey,
    options: HistoricMythicKillOptions
  ): Promise<HistoricMythicKillResult>;
  getMythicBossRankings(
    options: MythicBossRankingsOptions,
    signal?: AbortSignal
  ): Promise<MythicBossRankingsResult>;
}
