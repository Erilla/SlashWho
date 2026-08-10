import type { CharacterKey } from "@slashwho/domain";

export type AchievementFingerprint = ReadonlyMap<number, number>;

export type BlizzardRosterCharacter = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string;
  level: number;
}>;

export interface BlizzardGateway {
  getGuildRoster(
    root: CharacterKey,
    signal?: AbortSignal
  ): Promise<readonly BlizzardRosterCharacter[]>;
  getAchievementFingerprint(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<AchievementFingerprint>;
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
