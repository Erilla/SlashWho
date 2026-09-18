import type { CharacterKey } from "@slashwho/domain";

export type WarcraftLogsLimitationCode =
  | "not_found"
  | "private"
  | "rate_limited"
  /** We declined to start: too little of the hourly allowance was left. */
  | "points_budget_low"
  | "request_cap"
  | "unavailable"
  | "schema_drift"
  | "parse_private"
  | "parse_rate_limited"
  | "parse_request_cap"
  | "parse_unavailable"
  | "parse_schema_drift";

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

/**
 * The Warcraft Logs hourly points allowance as the API reports it. Normalised
 * facts only: the reserve threshold that decides what is "too little left" is
 * policy and lives with the caller.
 */
export type WarcraftLogsRateLimit = Readonly<{
  kind: "rate_limit";
  limitPerHour: number;
  /** Fractional upstream; a real observed value is 9058.65. */
  pointsSpentThisHour: number;
  /** Upstream calls this `pointsResetIn`. It reaches 3600. */
  pointsResetInSeconds: number;
}>;

export type WarcraftLogsRateLimitResult =
  WarcraftLogsRateLimit | WarcraftLogsLimitation;

export type WarcraftLogsParseMetric =
  | Readonly<{ state: "available"; percentile: number }>
  | Readonly<{ state: "not_applicable" | "unavailable" }>;

export type WarcraftLogsPerformance = Readonly<{
  spec?: Readonly<{ name: string; iconUrl: string }> | null;
  damage: WarcraftLogsParseMetric;
  healing: WarcraftLogsParseMetric;
  bossDamage: WarcraftLogsParseMetric;
}>;

export type WarcraftLogsFirstKillEvidence = Readonly<{
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  /** Blizzard's Encounter Journal identifier when WCL exposes the mapping. */
  journalBossId: string | null;
  /** Warcraft Logs does not expose encounter ordering in report lists. */
  bossOrder: number;
  /** The public report schema does not declare final-boss status. */
  isFinalBoss: false;
  killedAt: string;
  reportCode: string;
  fightId: number;
  difficulty: number;
  performance: WarcraftLogsPerformance;
  reportUrl: string;
  fightUrl: string;
  guild: Readonly<{
    name: string;
    region: CharacterKey["region"];
    realm: string;
  }> | null;
  historicWorldRank: null;
}>;

/**
 * The character's best Mythic parse for one encounter of one raid zone, read
 * from `zoneRankings` rather than from any single report. It is a claim about
 * the character's history, never about a particular fight, so it carries a
 * rankings link instead of a fight link.
 */
export type WarcraftLogsTierBestParse = Readonly<{
  /** The Warcraft Logs zone id, matching the `raidId` on this zone's kills. */
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  /** The character's own Mythic rankings for this encounter. */
  rankingsUrl: string;
  performance: WarcraftLogsPerformance;
}>;

export type WarcraftLogsWipeEvidence = Readonly<{
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  journalBossId: string | null;
  bossOrder: number;
  attemptedAt: string;
  reportUrl: string;
  fightUrl: string;
}>;

export type WarcraftLogsReportResult =
  | Readonly<{
      kind: "evidence";
      kills: readonly WarcraftLogsFirstKillEvidence[];
      wipes: readonly WarcraftLogsWipeEvidence[];
      tierBests: readonly WarcraftLogsTierBestParse[];
      /**
       * Raids a limitation was attributed to during this read. A caller storing
       * evidence indefinitely must not mark these terminal: the tier was read,
       * but not cleanly. Kept per raid rather than per run so one zone's drift
       * does not stop every other zone settling.
       */
      troubledRaidIds: readonly string[];
      limitation?: WarcraftLogsLimitation;
      parseLimitation?: WarcraftLogsLimitation;
    }>
  | WarcraftLogsLimitation;

export interface WarcraftLogsGateway {
  resolveCharacter(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<WarcraftLogsIdentityResult>;
  getRateLimit(signal?: AbortSignal): Promise<WarcraftLogsRateLimitResult>;
  getFirstKillReports(
    key: CharacterKey,
    options: Readonly<{
      requestCap: number;
      parseRequestCap: number;
      /** The character's known class, used to settle shared specialisation names. */
      className?: string;
      /**
       * Fight URLs whose parses are already stored, so a budget-limited run
       * spends its requests on what is still missing.
       */
      hydratedFightUrls?: ReadonlySet<string>;
      /**
       * When each zone's tier bests were last collected, keyed by raid id. A
       * zone collected after its newest kill has nothing left to fetch, so it
       * neither spends a request nor counts towards the zone budget -- without
       * this a veteran's zone list always exceeds the budget and the run
       * raises `parse_request_cap` forever, however saturated it is.
       */
      collectedTierZones?: ReadonlyMap<string, string>;
      /**
       * Raids this character is finished with, per collection domain. A
       * terminal raid costs no request: its zone is dropped before the zone
       * budget is measured, and its kills are never grouped for hydration.
       *
       * Whether a raid is terminal is entirely the caller's policy -- the
       * content window, the settling period and the clean-read rule all live
       * with them. The gateway only spends, or does not spend, requests.
       */
      terminalRaidIds?: Readonly<{
        kills: ReadonlySet<string>;
        parses: ReadonlySet<string>;
        tierBests: ReadonlySet<string>;
      }>;
      /**
       * The instant below which the report scan may stop, as an ISO string.
       * Set when every tier that closed before it is terminal for kills, so
       * pages older than it can only re-find evidence already stored.
       *
       * Reports arrive newest first, so a page whose fights all predate this
       * ends the scan -- cleanly, raising no limitation. A cap here would mark
       * the run partial and, under the clean-read rule, block the very marks
       * that allowed the stop, so the character would never settle.
       */
      killScanFloor?: string;
      signal?: AbortSignal;
    }>
  ): Promise<WarcraftLogsReportResult>;
}
