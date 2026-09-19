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
  /**
   * The decoder could not connect a report's ranking rows to this character
   * although both sides of the match were in hand: the report ranked somebody
   * for a fight the character was in, and named the character in
   * `masterData.actors`.
   *
   * Split out of `parse_schema_drift` because the two want opposite handling.
   * Structural drift is rare, unexplained and unretryable. This is common and
   * mostly benign -- a character genuinely in a fight and genuinely unranked
   * reaches it, a trade #319 took knowingly -- so it must not strand the
   * character for a day. It stayed invisible only because a run that
   * exhausted its parse budget overwrote it before publishing (#346 stopped
   * the budget binding, and it surfaced on 7 of 10 characters at once).
   */
  | "parse_identity_unmatched"
  | "parse_schema_drift";

export type WarcraftLogsLimitation = Readonly<{
  kind: "limitation";
  code: WarcraftLogsLimitationCode;
  retryAfterMs?: number;
}>;

/**
 * The classes of upstream request one `getFirstKillReports` issues. A single
 * gateway call spans all four, so run cost can only be attributed -- to the
 * history scan or to rankings -- by counting them apart.
 */
export type WarcraftLogsQueryType =
  /** `RecentReports`, one per page of the history scan. */
  | "history_scan"
  /** `CharacterZoneParses`, one per raid zone read for tier bests. */
  | "zone_rankings"
  /** `ReportFightParses`, one per report group hydrated. */
  | "fight_parses"
  /** `RankingCharacterIdentities`, one shared lookup per run. */
  | "ranking_identities";

export type WarcraftLogsRequestEvent = Readonly<{
  query: WarcraftLogsQueryType;
  /**
   * Whether the request came back as a limitation rather than a payload. The
   * request was issued and paid for either way, so it is counted either way.
   */
  limited: boolean;
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
      /** True when history was intentionally omitted and only parses ran. */
      scanSkipped?: boolean;
      kills: readonly WarcraftLogsFirstKillEvidence[];
      wipes: readonly WarcraftLogsWipeEvidence[];
      tierBests: readonly WarcraftLogsTierBestParse[];
      /**
       * Fight URLs this read asked about and got an answer for, whatever the
       * answer was. A fight is listed once the rankings behind it were
       * fetched and resolved -- including when they resolved to no ranking at
       * all, or to a ranked report that matched nobody.
       *
       * It is deliberately not "fights that gained a percentile". Roughly half
       * of hydrated fights come back with nothing, and a caller that records
       * only the successes cannot tell those from fights it has never asked
       * about, so it asks again every run and never terminates (#297). A fight
       * whose read was cut short -- by the budget, by rate limiting, by a
       * response the decoder rejected -- is absent, because nothing was
       * learned about it.
       *
       * Fights skipped through `hydratedFightUrls` are absent too: this read
       * did not ask about them, and what is already stored for them stands.
       */
      parsedFightUrls: readonly string[];
      /**
       * Raids a limitation was attributed to during this read, per collection
       * domain. A caller storing evidence indefinitely must not mark these
       * terminal for that domain: the tier was read, but not cleanly. Kept per
       * raid rather than per run so one zone's drift does not stop every other
       * zone settling.
       *
       * Both domains are parse-side, and deliberately so. Kills and wipes come
       * from the history scan, which never attributes trouble to a single raid
       * -- a scan that goes wrong may be missing reports from any tier, so it
       * reports itself through `limitation` instead. A caller may therefore
       * treat a raid listed here as complete for kills (#304).
       */
      troubledRaidIds: Readonly<{
        /** `ReportFightParses` and the identity lookup behind it. */
        parses: readonly string[];
        /** `CharacterZoneParses`, including zones the zone budget never reached. */
        tierBests: readonly string[];
      }>;
      limitation?: WarcraftLogsLimitation;
      parseLimitation?: WarcraftLogsLimitation;
      /**
       * Every distinct parse limitation this read raised, in the order it
       * raised them.
       *
       * One run can hit more than one, and the record holds a single code, so
       * the rest used to be discarded by whichever assignment ran last. That
       * is how an attribution failure hid behind `parse_request_cap` for
       * weeks: the drift was raised, then overwritten by the budget running
       * out later in the same loop.
       *
       * The gateway reports them all and ranks none, because which one should
       * drive `retry_after_at` is a retry-policy question and the policy lives
       * in the caller.
       *
       * `parseLimitation` is untouched by this: it is whatever it always was,
       * which is the last one raised except where an earlier one was
       * deliberately kept. That rule was never stated anywhere and is not
       * worth relying on -- it is assignment order, not a decision, and
       * preferring it is what discarded the others. A caller that cares which
       * limitation the run should be judged by reads this list and applies
       * its own policy; `packages/application` does exactly that in
       * `drivingParseLimitation`, and the code it picks may differ from
       * `parseLimitation`.
       */
      parseLimitations?: readonly WarcraftLogsLimitation[];
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
      /**
       * Called once per upstream request this call issues, naming the class of
       * query. Scoped to the call rather than to the client so the counts
       * attribute to one run: the client is a process-wide singleton.
       *
       * It reports requests already being made and adds none. A throwing
       * observer is swallowed -- a counter must not cost the collection it
       * measures.
       */
      onRequest?(event: WarcraftLogsRequestEvent): void;
      signal?: AbortSignal;
    }>
  ): Promise<WarcraftLogsReportResult>;
}
