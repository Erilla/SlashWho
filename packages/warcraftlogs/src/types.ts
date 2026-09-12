import type { CharacterKey } from "@slashwho/domain";

export type WarcraftLogsLimitationCode =
  | "not_found"
  | "private"
  | "rate_limited"
  | "request_cap"
  | "unavailable"
  | "schema_drift";

export type WarcraftLogsLimitation = Readonly<{
  kind: "limitation";
  code: WarcraftLogsLimitationCode;
  retryAfterMs?: number;
}>;

export type WarcraftLogsIdentity = Readonly<{
  kind: "identity";
  key: CharacterKey;
  displayName: string;
}>;

export type WarcraftLogsIdentityResult =
  WarcraftLogsIdentity | WarcraftLogsLimitation;

export type WarcraftLogsFirstKillEvidence = Readonly<{
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  /** Warcraft Logs does not expose encounter ordering in report lists. */
  bossOrder: number;
  /** The public report schema does not declare final-boss status. */
  isFinalBoss: false;
  killedAt: string;
  reportUrl: string;
  fightUrl: string;
  guild: Readonly<{ name: string; realm: string }> | null;
  historicWorldRank: null;
}>;

export type WarcraftLogsReportResult =
  | Readonly<{
      kind: "evidence";
      kills: readonly WarcraftLogsFirstKillEvidence[];
      limitation?: WarcraftLogsLimitation;
    }>
  | WarcraftLogsLimitation;

export interface WarcraftLogsGateway {
  resolveCharacter(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<WarcraftLogsIdentityResult>;
  getFirstKillReports(
    key: CharacterKey,
    options: Readonly<{ requestCap: number; signal?: AbortSignal }>
  ): Promise<WarcraftLogsReportResult>;
}
