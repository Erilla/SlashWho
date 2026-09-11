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

export type WarcraftLogsFirstKillReport = Readonly<{
  encounterId: number;
  killedAt: string;
  reportUrl: string;
  fightUrl: string;
}>;

export type WarcraftLogsReportResult =
  | Readonly<{
      kind: "evidence";
      reports: readonly WarcraftLogsFirstKillReport[];
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
