import type { CharacterGuild, CharacterKey } from "@slashwho/domain";

export type AchievementFingerprint = ReadonlyMap<number, number>;

export type CompletedAchievement = Readonly<{
  achievementId: string;
  completedAt: string;
}>;

export type BlizzardRosterCharacter = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string;
  level: number;
  /**
   * The guild whose roster named this member; the same for every member.
   * Nullable to match how a guild is carried everywhere else: absent is an
   * ordinary state, never a reason to fail a sweep.
   */
  guild: CharacterGuild | null;
}>;

/** Called immediately before a request to the Blizzard profile API. */
export type BlizzardProfileRequestObserver = () => Promise<void> | void;

export interface BlizzardGateway {
  getGuildRoster(
    root: CharacterKey,
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver
  ): Promise<readonly BlizzardRosterCharacter[]>;
  /** Reads a roster from a previously observed public guild identity. */
  getGuildRosterByIdentity(
    guild: CharacterGuild,
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver
  ): Promise<readonly BlizzardRosterCharacter[]>;
  getAchievementFingerprint(
    key: CharacterKey,
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver
  ): Promise<AchievementFingerprint>;
  getCompletedAchievements(
    key: CharacterKey,
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver
  ): Promise<readonly CompletedAchievement[]>;
}

export type BlizzardFailure =
  | { kind: "not_found" }
  | {
      kind: "transient";
      status?: number;
      retryAfterMs?: number;
    }
  | { kind: "schema_drift" };

export type BlizzardError = Error & BlizzardFailure;
