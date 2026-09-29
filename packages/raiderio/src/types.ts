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
  /**
   * Raider.IO's own id for the character, which a logged encounter's roster
   * names it by. Absent from profile lists, which do not carry it.
   */
  readonly raiderIoCharacterId?: number;
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

/**
 * A Mythic kill Raider.IO attributes to the character. On its own it is only a
 * place to search: it tells the Warcraft Logs scan which guild's logs to read
 * and on which night. Where Raider.IO also holds a parsed combat log of it
 * (`loggedEncounterId`), that log is evidence (#732).
 */
export type HistoricMythicKill = Readonly<{
  raidSlug: string;
  bossSlug: string;
  firstDefeated: string;
  guild: { name: string; realm: string; region: string } | null;
  /**
   * Raider.IO's logged encounter of this first kill, or null when it has
   * none. It always names the first kill, never a reclear. Always set by the
   * client; optional so a kill built without it still types.
   */
  loggedEncounterId?: number | null;
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
  /** Called once per tier request actually sent, so a run can count its cost. */
  onPhysicalRequest?: RaiderIoPhysicalRequestObserver;
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

/** Receives no request identity, payload, or credential information. */
export type RaiderIoPhysicalRequestObserver = () => void;

export type RaiderIoRosterRole = "tank" | "healer" | "dps";

/** One raider on a logged encounter's roster. */
export type LoggedEncounterMember = Readonly<{
  raiderIoCharacterId: number;
  name: string;
  realm: string;
  region: string;
  className: string;
  specName: string;
  role: RaiderIoRosterRole;
  /** Null when Raider.IO did not say; never zero. */
  itemLevel: number | null;
}>;

/**
 * Raider.IO's parsed combat log of one Mythic kill: only the fields #732
 * keeps. Never the uploaders, never the response.
 */
export type LoggedEncounter = Readonly<{
  kind: "encounter";
  raidSlug: string;
  bossSlug: string;
  pulledAt: string;
  defeatedAt: string;
  durationMs: number;
  itemLevel: Readonly<{ average: number; min: number; max: number }>;
  /** Null for a kill with no guild: a pug. */
  guild: Readonly<{ name: string; realm: string; region: string }> | null;
  deathCount: number;
  /** Null where Raider.IO gives no Vantus data for the boss; never zero runes. */
  vantusCount: number | null;
  /**
   * `guildPrivacy.shareRaidUntil`: until when the guild shares its raids, or
   * null when Raider.IO names no end.
   */
  shareRaidUntil: string | null;
  roster:
    | Readonly<{
        state: "available";
        members: readonly LoggedEncounterMember[];
      }>
    | Readonly<{ state: "unavailable"; reason: "private" }>;
}>;

export type LoggedEncounterResult =
  | LoggedEncounter
  | {
      kind: "limitation";
      code: RaiderIoEvidenceLimitation;
      retryAfterMs?: number;
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
    signal?: AbortSignal,
    onPhysicalRequest?: RaiderIoPhysicalRequestObserver
  ): Promise<MythicBossRankingsResult>;
  /** One logged encounter. The phase decides when one is read again (#732). */
  getLoggedEncounter(
    raidSlug: string,
    loggedEncounterId: number,
    signal?: AbortSignal,
    onPhysicalRequest?: RaiderIoPhysicalRequestObserver
  ): Promise<LoggedEncounterResult>;
}
