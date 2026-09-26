import type {
  WarcraftLogsLimitation,
  WarcraftLogsLimitationCode,
  WarcraftLogsQueryType
} from "./types";

/** A request-level limitation, restated as the parse-side gap it leaves. */
export function toParseLimitation(
  limitation: WarcraftLogsLimitation
): WarcraftLogsLimitation {
  switch (limitation.code) {
    case "private":
      return { kind: "limitation", code: "parse_private" };
    case "rate_limited":
      return {
        kind: "limitation",
        code: "parse_rate_limited",
        ...(limitation.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: limitation.retryAfterMs })
      };
    case "schema_drift":
      return { kind: "limitation", code: "parse_schema_drift" };
    case "not_found":
    case "points_budget_low":
    case "request_cap":
    case "unavailable":
    case "parse_private":
    case "parse_rate_limited":
    case "parse_request_cap":
    case "parse_unavailable":
    case "parse_identity_unmatched":
    case "parse_schema_drift":
      return { kind: "limitation", code: "parse_unavailable" };
  }
}

export type ParseLedgerOutcome = Readonly<{
  /** The zone-rankings limitation when no report-group one was raised. */
  parseLimitation?: WarcraftLogsLimitation;
  parseLimitations: readonly WarcraftLogsLimitation[];
  troubledRaidIds: Readonly<{
    parses: readonly string[];
    tierBests: readonly string[];
  }>;
  parsedFightUrls: readonly string[];
}>;

export type ParseLedger = Readonly<{
  /** Tells the caller's observer, and records nothing. */
  note(query: WarcraftLogsQueryType, code: WarcraftLogsLimitationCode): void;
  /**
   * Records a report-group or identity limitation, and makes it the reported
   * one.
   *
   * `preferExisting` keeps an earlier limitation as the reported value while
   * still recording this one, which is what the old `??=` meant: the budget
   * running out after something else already went wrong is worth recording,
   * but it is not the more informative answer.
   */
  raise(
    limitation: WarcraftLogsLimitation,
    query: WarcraftLogsQueryType,
    options?: Readonly<{ preferExisting?: boolean }>
  ): void;
  /**
   * Records a zone-rankings limitation. Kept apart from the report-group one
   * so it never hides a later per-fight failure, nor stops per-fight
   * hydration being tried.
   */
  raiseTier(limitation: WarcraftLogsLimitation): void;
  troubleParses(raidId: string): void;
  troubleTierBests(raidId: string): void;
  markParsed(fightUrl: string): void;
  outcome(): ParseLedgerOutcome;
}>;

/**
 * What the parse side of one read ran into, and which raids and fights that
 * touches.
 */
export function createParseLedger(
  onLimitation?: (
    query: WarcraftLogsQueryType,
    code: WarcraftLogsLimitationCode
  ) => void
): ParseLedger {
  let parseLimitation: WarcraftLogsLimitation | undefined;
  let tierParseLimitation: WarcraftLogsLimitation | undefined;
  // Every distinct parse limitation raised, first occurrence wins, insertion
  // ordered. One run can hit several and the run record holds one code, so
  // until #349 the rest were lost to whichever assignment ran last -- which
  // is how an attribution failure hid behind `parse_request_cap` for weeks.
  // The gateway ranks none of them: choosing which drives `retry_after_at`
  // needs the retry policy, which lives in the caller.
  const seen = new Map<WarcraftLogsLimitationCode, WarcraftLogsLimitation>();
  // Raids this read had trouble with, split by the collection domain the
  // trouble belongs to. Kept per raid rather than per run so one zone's
  // failure does not stop every other zone settling, and per domain so a
  // parse shortfall does not stop the raid's kills settling either (#304).
  // Neither set is ever written by the history scan: a scan that goes wrong
  // may be missing reports from any tier, so it reports itself through its
  // own limitation rather than blaming a raid.
  const troubledTierBestRaidIds = new Set<string>();
  const troubledParseRaidIds = new Set<string>();
  // Fights this read got an answer about, so a later run can tell them from
  // fights it has never asked about (#297).
  const parsedFightUrls = new Set<string>();

  const note: ParseLedger["note"] = (query, code) => {
    try {
      onLimitation?.(query, code);
    } catch {
      // Progress observation cannot change the collected evidence.
    }
  };

  return {
    note,
    raise(limitation, query, options) {
      note(query, limitation.code);
      if (!seen.has(limitation.code)) seen.set(limitation.code, limitation);
      if (!options?.preferExisting || parseLimitation === undefined) {
        parseLimitation = limitation;
      }
    },
    raiseTier(limitation) {
      tierParseLimitation = limitation;
      note("zone_rankings", limitation.code);
    },
    troubleParses(raidId) {
      troubledParseRaidIds.add(raidId);
    },
    troubleTierBests(raidId) {
      troubledTierBestRaidIds.add(raidId);
    },
    markParsed(fightUrl) {
      parsedFightUrls.add(fightUrl);
    },
    outcome() {
      const reported = parseLimitation ?? tierParseLimitation;
      // The zone-rankings limitation is kept apart from the report-group one
      // all the way to here, but it is still something this read hit, so it
      // belongs in the record of what happened rather than only in what got
      // reported.
      const all = new Map(seen);
      if (tierParseLimitation && !all.has(tierParseLimitation.code)) {
        all.set(tierParseLimitation.code, tierParseLimitation);
      }
      return {
        ...(reported ? { parseLimitation: reported } : {}),
        parseLimitations: [...all.values()],
        troubledRaidIds: {
          parses: [...troubledParseRaidIds].sort(),
          tierBests: [...troubledTierBestRaidIds].sort()
        },
        parsedFightUrls: [...parsedFightUrls].sort()
      };
    }
  };
}
