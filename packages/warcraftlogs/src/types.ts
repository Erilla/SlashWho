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
 * gateway call spans all of them, so run cost can only be attributed -- to the
 * history scan, to attendance recovery or to rankings -- by counting them
 * apart. All three history classes draw on the same scan request cap.
 */
export type WarcraftLogsQueryType =
  /** `RecentReports`, one per page of the history scan, boundary probe included. */
  | "history_scan"
  /**
   * `CharacterGuilds`, at most one per tier search: the guilds Warcraft Logs
   * lists for the character, as places to walk attendance for.
   */
  | "character_guilds"
  /** `GuildAttendance`, one per attendance page searched for a verified kill. */
  | "guild_attendance"
  /** `ReportByCode`, one per attendance report hydrated. */
  | "report_hydration"
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
  /** The limitation returned by this request, when one was returned. */
  limitationCode?: WarcraftLogsLimitationCode;
}>;

export type WarcraftLogsIdentity = Readonly<{
  kind: "identity";
  key: CharacterKey;
  displayName: string;
  /**
   * Warcraft Logs' stable character ID. It survives renames and realm
   * transfers, so it names the character where `key` names only its current
   * name and realm. It is the ranking `characters[].id`, not a report actor ID.
   */
  characterId: number;
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
  /** The Warcraft Logs account that uploaded the report, when public. */
  uploader?: string | null;
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
  guild?: WarcraftLogsFirstKillEvidence["guild"];
  /** The Warcraft Logs account that uploaded the report, when public. */
  uploader?: string | null;
}>;

export type WarcraftLogsVerifiedKill = Readonly<{
  /** When the kill happened, as an ISO string. */
  at: string;
  /** The guild the kill was in, whose attendance is searched. */
  guild: Readonly<{
    name: string;
    realm: string;
    region: CharacterKey["region"];
  }>;
}>;

/**
 * One tier's explicit attendance search, asked for from the dossier (#435).
 *
 * Unlike verified-kill recovery it does not need a kill to look for: it walks
 * every known guild's attendance across the tier's window and hydrates each
 * report there that may list the character, so guildless kills, wipe-only
 * nights and kills below the scan floor can be found. It has its own request
 * cap, so it can neither starve the history scan nor be starved by it.
 */
export type WarcraftLogsTierSearch = Readonly<{
  /** The tier's window as ISO instants; kills outside it are not searched for. */
  from: string;
  to: string;
  /** Guilds known for the character from other sources. */
  guilds: readonly WarcraftLogsVerifiedKill["guild"][];
  /** Requests the search may make, attendance pages and hydrations alike. */
  requestCap: number;
  /**
   * Reports whose evidence is already stored, so hydrating them again would
   * re-read fights the character already holds.
   */
  skipReportCodes?: readonly string[];
}>;

/**
 * What a tier search did. `complete` means every guild was walked across the
 * whole window; `request_cap` that its budget ran out first; `incomplete` that
 * some guild's attendance could not be read. None of them limits the run: a
 * search only ever adds evidence.
 */
export type WarcraftLogsTierSearchOutcome = Readonly<{
  outcome: "complete" | "request_cap" | "incomplete";
  requests: number;
  guildsSearched: number;
  reportsHydrated: number;
  recoveredKills: number;
  recoveredWipes: number;
}>;

/** Position in one tier's ranked discovery, persisted across capped runs. */
export type WarcraftLogsRankedBackfillCursor = Readonly<{
  journalRaidId: string;
  characterId?: number;
  zoneIds: readonly number[];
  /** Aligned with zoneIds; absent only on a cursor saved before partition scans. */
  partitionIds?: readonly number[];
  /** Public fights already accepted by a capped scan, for resumed deduplication. */
  acceptedFightKeys?: readonly string[];
  zonesLoaded: boolean;
  zoneIndex: number;
  encounterIds: readonly number[];
  encountersLoaded: boolean;
  encounterIndex: number;
  metricIndex: number;
  reportIndex: number;
}>;

export type WarcraftLogsRankedBackfillResult =
  | Readonly<{
      kind: "evidence";
      kills: readonly WarcraftLogsFirstKillEvidence[];
      cursor?: WarcraftLogsRankedBackfillCursor;
      limitation?: WarcraftLogsLimitation;
    }>
  | WarcraftLogsLimitation;

export type WarcraftLogsReportResult =
  | Readonly<{
      kind: "evidence";
      /** Fight times were impossible; valid evidence on the page was retained. */
      omittedInvalidTimestamp?: true;
      /** Reports whose spans cannot rule out a verified kill. */
      omittedInvalidTimestampReportCodes?: readonly string[];
      /** True when history was intentionally omitted and only parses ran. */
      scanSkipped?: boolean;
      /**
       * The next report page after the newest contiguous prefix decoded by a
       * limited scan. It is absent unless a cleanly decoded page proves it.
       */
      historyScanResumePage?: number;
      /**
       * The last report code on the final proved page. It validates that the
       * page offset has not moved before a later run resumes below it.
       */
      historyScanResumeBoundaryReportCode?: string;
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
      /**
       * Kills attendance recovery added that the history scan had not already
       * found. Present only when attendance was searched: absent means no
       * search ran, which is not the same as a search that found nothing.
       */
      attendanceRecoveredKills?: number;
      /**
       * Verified kills whose night was searched to the end and held nothing:
       * the guild's attendance was walked past it, or Warcraft Logs has no such
       * guild, and no report read could have held it. A caller may stop
       * searching for these for a while. Absent when none qualified.
       */
      attendanceSearchedEmpty?: readonly WarcraftLogsVerifiedKill[];
      /** Present only when a tier search was asked for. */
      tierSearch?: WarcraftLogsTierSearchOutcome;
      /** Position after a capped ranked search; null means it completed. */
      rankedBackfillCursor?: WarcraftLogsRankedBackfillCursor | null;
    }>
  | WarcraftLogsLimitation;

export interface WarcraftLogsGateway {
  getRankedKillReports(
    key: CharacterKey,
    options: Readonly<{
      journalRaidId: string;
      requestCap: number;
      characterId?: number;
      cursor?: WarcraftLogsRankedBackfillCursor;
      onRequest?(event: WarcraftLogsRequestEvent): void;
      signal?: AbortSignal;
    }>
  ): Promise<WarcraftLogsRankedBackfillResult>;
  resolveCharacter(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<WarcraftLogsIdentityResult>;
  /**
   * Resolves a stable character ID to the character's current name, realm and
   * region. Throws `invalid_character_id` for an ID that is not a positive
   * safe integer, without issuing a request.
   */
  resolveCharacterById(
    characterId: number,
    signal?: AbortSignal
  ): Promise<WarcraftLogsIdentityResult>;
  getRateLimit(signal?: AbortSignal): Promise<WarcraftLogsRateLimitResult>;
  getFirstKillReports(
    key: CharacterKey,
    options: Readonly<{
      requestCap: number;
      parseRequestCap: number;
      /**
       * The first history page to scan. A persisted value resumes below a
       * prefix a prior capped scan decoded cleanly.
       */
      historyScanStartPage?: number;
      /** The final report code on the stored boundary page. */
      historyScanResumeBoundaryReportCode?: string;
      storedKills?: readonly WarcraftLogsFirstKillEvidence[];
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
       * The character's stable Warcraft Logs ID, from `resolveCharacter`. When
       * given, history and tier bests are read by it rather than by name. The
       * key still identifies the character among report actors and ranking
       * rows, so the two must name the same character.
       */
      characterId?: number;
      /**
       * Kills another provider attributes to the character, with the guild
       * they were in. They are where to look, never evidence: one that no
       * decoded report covers is searched for in that guild's attendance, on
       * that night, and counts only if a hydrated report attributes it.
       * Absent or empty, attendance is not read at all.
       */
      verifiedKills?: readonly WarcraftLogsVerifiedKill[];
      /**
       * Report codes of stored kills outside terminal raids. A complete publish
       * keeps only what the run finds again there, and a kill recovered from
       * guild attendance is not in the character's own history to be found. So
       * after a fresh scan that finishes, any of these the scan did not read is
       * re-read directly. Taken from stored evidence, never from another
       * provider, so a Raider.IO failure cannot drop what it once helped find.
       */
      storedKillReportCodes?: readonly string[];
      /**
       * A targeted collection that deliberately reads no history (#450).
       * Requires a request cap of zero. Unlike a parse-only resume, whose zero
       * cap reports the history it left unread as `request_cap`, nothing
       * here was asked of the history, so nothing fell short of it: only the
       * tier search, the ranked walk and parse work can limit the result.
       */
      targetedOnly?: boolean;
      /**
       * The one Journal raid whose kills are parsed. A targeted search's
       * reports can hold another raid's fights from the same nights, and
       * parsing them would spend its budget on work it does not publish.
       * Resolved by boss as well as zone, so a combined zone's kills are
       * placed in their own raid.
       */
      parseJournalRaidId?: string;
      /** An explicit search of one tier's guild attendance (#435). */
      tierSearch?: WarcraftLogsTierSearch;
      /** Ranked reports for the same explicit tier search, with durable resume. */
      rankedBackfill?: Readonly<{
        journalRaidId: string;
        requestCap: number;
        cursor?: WarcraftLogsRankedBackfillCursor;
      }>;
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
      /** Called when decoding a successful request raises a limitation. */
      onLimitation?(
        query: WarcraftLogsQueryType,
        code: WarcraftLogsLimitationCode
      ): void;
      signal?: AbortSignal;
    }>
  ): Promise<WarcraftLogsReportResult>;
}
