import type {
  DossierLimitation as ContractDossierLimitation,
  DossierLimitationAffects,
  DossierLimitationCode
} from "@slashwho/contracts";
import type { CharacterKey, DossierLimitation } from "@slashwho/domain";

/**
 * Every code a limitation is recorded under, and the one the contract names it
 * by. Exhaustive over the contract, so a code the contract gains fails the
 * build here until it is mapped; `schema_drift` is the stored spelling of
 * `schema_changed`.
 */
const CONTRACT_LIMITATION_CODES: Readonly<
  Record<DossierLimitationCode | "schema_drift", DossierLimitationCode>
> = {
  not_found: "not_found",
  private: "private",
  rate_limited: "rate_limited",
  points_budget_low: "points_budget_low",
  collection_failed: "collection_failed",
  request_cap: "request_cap",
  unavailable: "unavailable",
  schema_changed: "schema_changed",
  schema_drift: "schema_changed",
  invalid_fight_timestamp: "invalid_fight_timestamp",
  parse_private: "parse_private",
  parse_rate_limited: "parse_rate_limited",
  parse_request_cap: "parse_request_cap",
  parse_unavailable: "parse_unavailable",
  parse_schema_drift: "parse_schema_drift",
  parse_identity_unmatched: "parse_identity_unmatched",
  current_content_window_unknown: "current_content_window_unknown",
  current_content_evidence_withheld: "current_content_evidence_withheld",
  unmatched_encounter: "unmatched_encounter"
};

function isRecordedCode(
  code: string
): code is keyof typeof CONTRACT_LIMITATION_CODES {
  return Object.hasOwn(CONTRACT_LIMITATION_CODES, code);
}

/** The contract's name for a recorded code; null for one it does not name. */
export function contractLimitationCode(
  code: string
): DossierLimitationCode | null {
  return isRecordedCode(code) ? CONTRACT_LIMITATION_CODES[code] : null;
}

export type EvidenceSource = "raiderio" | "warcraft_logs" | "blizzard";

function limitationMessage(
  source: EvidenceSource,
  code: ContractDossierLimitation["code"]
): string {
  if (source === "warcraft_logs" && code.startsWith("parse_")) {
    // The cap is not a verdict. Since #280 a capped run sets a retry and
    // resumes, so wording that read as terminal described the opposite of
    // what happens next; it clears itself once a later run publishes without
    // the code (#297).
    if (code === "parse_request_cap") {
      return (
        "Parse availability is partial because this dossier reached its " +
        "parse request cap. Collection resumes automatically and fills in " +
        "the rest; verified kill evidence is still shown."
      );
    }
    const reason =
      code === "parse_private"
        ? "the supporting reports are private"
        : code === "parse_rate_limited"
          ? "Warcraft Logs is temporarily rate limited"
          : code === "parse_schema_drift"
            ? "Warcraft Logs returned an unexpected ranking response"
            : // Not a fault, most of the time: the usual way here is a
              // character who was in the fight and simply not ranked in it.
              // Saying "unexpected response" of that would be alarming and
              // wrong, which is half of why #349 split the two codes.
              code === "parse_identity_unmatched"
              ? "Warcraft Logs ranked nobody matching this character in those reports"
              : "Warcraft Logs could not load the rankings";
    return `Parse availability is partial because ${reason}. Verified kill evidence is still shown.`;
  }
  if (source === "raiderio") {
    const reason =
      code === "schema_changed"
        ? "an unexpected response"
        : code === "rate_limited"
          ? "rate limiting"
          : code === "not_found"
            ? "a missing leaderboard"
            : code === "private"
              ? "denied leaderboard access"
              : "a lookup failure";
    return `Some historic boss world ranks could not be checked because of ${reason} from Raider.IO. Verified kill evidence is still shown.`;
  }
  const label =
    source === "blizzard" ? "Blizzard achievement data" : "Warcraft Logs";
  switch (code) {
    case "unmatched_encounter":
      return `${label} reported Mythic kills this dossier could not match to a known raid boss, so they are not shown. Other kills may exist.`;
    case "not_found":
      return `${label} has no public evidence for this character.`;
    case "private":
      return `${label} evidence for this character is private.`;
    case "rate_limited":
      return `${label} is temporarily rate limited.`;
    case "points_budget_low":
      return `${label} collection was deferred because this dossier's hourly points allowance is nearly spent. It resumes automatically once the allowance resets; shown evidence is partial.`;
    case "collection_failed":
      return `${label} collection was interrupted by an error before it could be stored. Shown evidence is partial and collection is retried automatically; other kills or wipes may exist.`;
    case "request_cap":
      return `${label} history is incomplete because this dossier reached its request cap. Shown evidence is partial; other kills or wipes may exist.`;
    case "unavailable":
      if (source === "blizzard")
        return `${label} could not be read; Cutting Edge status is unknown for this character.`;
      return `${label} history could not be fully loaded. Shown evidence is partial; other kills or wipes may exist.`;
    case "schema_changed":
      return `${label} returned an unexpected response, so history is incomplete. Shown evidence is partial; other kills or wipes may exist.`;
    case "invalid_fight_timestamp":
      return `${label} fights with impossible timestamps were omitted. Those fights cannot be shown as kills or wipes and will not be retried.`;
    case "current_content_window_unknown":
      return `${label} evidence could not be shown because this raid's current-content window has not been reviewed.`;
    case "current_content_evidence_withheld":
      return `${label} evidence outside this raid's current-content window is not shown.`;
    // Parse codes are answered above, before the source is looked at.
    case "parse_private":
    case "parse_rate_limited":
    case "parse_request_cap":
    case "parse_unavailable":
    case "parse_identity_unmatched":
    case "parse_schema_drift":
      return `${label} parse availability is partial. Verified kill evidence is still shown.`;
  }
}

/** The part of the dossier a shortfall leaves incomplete (#526). */
export function limitationAffects(
  source: EvidenceSource,
  code: ContractDossierLimitation["code"]
): DossierLimitationAffects {
  if (source === "raiderio") return "world_ranks";
  if (source === "blizzard") return "cutting_edge";
  if (code.startsWith("parse_")) return "parses";
  if (
    code === "current_content_window_unknown" ||
    code === "current_content_evidence_withheld" ||
    code === "unmatched_encounter"
  )
    return "hidden_kills";
  return "kill_history";
}

/**
 * Whether collection clears a shortfall on its own. For Warcraft Logs this is
 * `retryDelayMsFor`'s classification, which a test holds it to; the rest are
 * decided by what would have to change: an upstream profile, a code fix, or a
 * reviewed content window, none of which waiting brings about.
 */
export function limitationRecovery(
  code: ContractDossierLimitation["code"]
): ContractDossierLimitation["recovery"] {
  switch (code) {
    case "not_found":
    case "private":
    case "schema_changed":
    case "parse_private":
    case "parse_schema_drift":
    case "invalid_fight_timestamp":
    case "current_content_window_unknown":
    case "current_content_evidence_withheld":
    case "unmatched_encounter":
      return "none";
    case "rate_limited":
    case "points_budget_low":
    case "collection_failed":
    case "request_cap":
    case "unavailable":
    case "parse_rate_limited":
    case "parse_request_cap":
    case "parse_unavailable":
    case "parse_identity_unmatched":
      return "automatic";
  }
}

export function limitation(
  source: EvidenceSource,
  character: CharacterKey,
  code: string,
  observedAt: Date = new Date(),
  retryAfterAt?: Date | null,
  encounters?: DossierLimitation["encounters"]
): DossierLimitation {
  return {
    source,
    character,
    code,
    observedAt: observedAt.toISOString(),
    ...(retryAfterAt && !Number.isNaN(retryAfterAt.valueOf())
      ? { retryAt: retryAfterAt.toISOString() }
      : {}),
    ...(encounters?.length ? { encounters } : {})
  };
}

export function retryAfterAt(error: unknown): Date | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("retryAfterMs" in error) ||
    typeof error.retryAfterMs !== "number" ||
    !Number.isFinite(error.retryAfterMs)
  ) {
    return null;
  }
  return new Date(Date.now() + Math.max(0, error.retryAfterMs));
}

export function blizzardLimitationCode(
  error: unknown
): "not_found" | "schema_drift" | "unavailable" {
  if (typeof error !== "object" || error === null || !("kind" in error))
    return "unavailable";
  if (error.kind === "not_found" || error.kind === "schema_drift")
    return error.kind;
  return "unavailable";
}

/**
 * One limitation per source and code across a subject's names, the first
 * keeping its time and retry. The encounters each name affected are all kept,
 * or the alias's raids would vanish from the detail.
 */
export function mergeLimitations(
  limitations: readonly DossierLimitation[]
): DossierLimitation[] {
  const merged = new Map<string, DossierLimitation>();
  for (const item of limitations) {
    const key = `${item.source}\0${contractLimitationCode(item.code) ?? item.code}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, item);
      continue;
    }
    const encounters = new Map(
      (existing.encounters ?? []).map((entry) => [
        `${entry.raidName}\0${entry.bossName ?? ""}`,
        entry
      ])
    );
    for (const entry of item.encounters ?? []) {
      const encounterKey = `${entry.raidName}\0${entry.bossName ?? ""}`;
      const prior = encounters.get(encounterKey);
      encounters.set(
        encounterKey,
        prior ? { ...prior, kills: prior.kills + entry.kills } : entry
      );
    }
    if (encounters.size > 0) {
      merged.set(key, {
        ...existing,
        encounters: [...encounters.values()].sort(
          (a, b) =>
            b.kills - a.kills ||
            a.raidName.localeCompare(b.raidName) ||
            (a.bossName ?? "").localeCompare(b.bossName ?? "")
        )
      });
    }
  }
  return [...merged.values()];
}

/**
 * A dossier limitation as the contract carries it: the one place a recorded
 * code becomes a contract code. A code the contract does not name fails here,
 * by name, rather than as a schema error on the whole dossier.
 */
export function contractLimitation(item: DossierLimitation) {
  const code = contractLimitationCode(item.code);
  if (code === null) throw new Error(`unknown_limitation_code:${item.code}`);
  return {
    ...item,
    observedAt: item.observedAt ?? new Date().toISOString(),
    code,
    message: limitationMessage(item.source, code),
    affects: limitationAffects(item.source, code),
    recovery: item.recovery ?? limitationRecovery(code)
  };
}
