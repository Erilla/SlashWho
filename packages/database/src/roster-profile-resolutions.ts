import type { Pool } from "pg";
import { isValidCharacterKey, type Region } from "@slashwho/domain";
import { randomUUID } from "node:crypto";

const resolverVersion = 1;
const answerLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const leaseMs = 5 * 60 * 1000;

export type RosterProfileLocator = Readonly<{
  region: string;
  realm: string;
  name: string;
  historicId: number;
}>;

export type StoredRosterProfileResolution = RosterProfileLocator &
  Readonly<{
    resolvedId: number | null;
    limitationCode: string | null;
    answeredAt: Date | null;
    lastAttemptAt: Date | null;
    retryNotBefore: Date | null;
  }>;

export type RosterProfileResolutionAnswer = Readonly<{
  resolvedId: number | null;
  limitationCode: string | null;
  retryNotBefore?: Date | null;
}>;

export interface RosterProfileResolutionRepository {
  load(
    locators: readonly RosterProfileLocator[]
  ): Promise<StoredRosterProfileResolution[]>;
  reserve(locator: RosterProfileLocator, at: Date): Promise<string | null>;
  answer(
    locator: RosterProfileLocator,
    token: string,
    answer: RosterProfileResolutionAnswer,
    at: Date
  ): Promise<boolean>;
}

function validateLocator(locator: RosterProfileLocator): void {
  const suffix = /^(.+)-([1-9][0-9]*)$/.exec(locator.name);
  if (
    !Number.isSafeInteger(locator.historicId) ||
    locator.historicId < 1 ||
    !suffix ||
    Number(suffix[2]) !== locator.historicId ||
    !isValidCharacterKey({
      region: locator.region as Region,
      realm: locator.realm,
      name: suffix[1]!
    })
  ) {
    throw new Error("invalid_roster_profile_locator");
  }
}

const permanentCodes = new Set(["not_found", "private", "schema_drift"]);
const transientCodes = new Set(["rate_limited", "unavailable", "transient"]);

function validateAnswer(answer: RosterProfileResolutionAnswer): void {
  const positive =
    answer.resolvedId !== null &&
    Number.isSafeInteger(answer.resolvedId) &&
    answer.resolvedId > 0 &&
    answer.limitationCode === null;
  const limitation =
    answer.resolvedId === null &&
    answer.limitationCode !== null &&
    (permanentCodes.has(answer.limitationCode) ||
      transientCodes.has(answer.limitationCode));
  if (!positive && !limitation)
    throw new Error("invalid_roster_profile_answer");
  if (
    answer.retryNotBefore != null &&
    !Number.isFinite(answer.retryNotBefore.getTime())
  )
    throw new Error("invalid_roster_profile_answer");
}

type ResolutionRow = {
  region: string;
  realm: string;
  name: string;
  historic_id: string;
  resolved_id: string | null;
  limitation_code: string | null;
  answered_at: Date | null;
  last_attempt_at: Date;
  retry_not_before: Date | null;
};

function locatorValues(locator: RosterProfileLocator): unknown[] {
  validateLocator(locator);
  return [
    locator.region,
    locator.realm,
    locator.name,
    locator.historicId,
    resolverVersion
  ];
}

function validateTime(at: Date): void {
  if (!Number.isFinite(at.getTime()))
    throw new Error("invalid_roster_profile_time");
}

/** Parsed upstream answers shared by every subject; presence is decided by callers. */
export function createRosterProfileResolutionRepository(
  pool: Pool
): RosterProfileResolutionRepository {
  return {
    async load(locators) {
      for (const locator of locators) validateLocator(locator);
      if (locators.length === 0) return [];
      const result = await pool.query<ResolutionRow>(
        `SELECT resolution.region, resolution.realm, resolution.name,
                resolution.historic_id, resolved_id, limitation_code,
                answered_at, last_attempt_at, retry_not_before
           FROM raiderio_roster_profile_resolutions resolution
          WHERE resolver_version = $5 AND EXISTS (
            SELECT 1 FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[])
              AS locator(region, realm, name, historic_id)
             WHERE locator.region = resolution.region AND locator.realm = resolution.realm
               AND locator.name = resolution.name AND locator.historic_id = resolution.historic_id
          )
          ORDER BY resolution.region, resolution.realm, resolution.name, resolution.historic_id`,
        [
          locators.map((locator) => locator.region),
          locators.map((locator) => locator.realm),
          locators.map((locator) => locator.name),
          locators.map((locator) => locator.historicId),
          resolverVersion
        ]
      );
      return result.rows.map((row) => ({
        region: row.region,
        realm: row.realm,
        name: row.name,
        historicId: Number(row.historic_id),
        resolvedId: row.resolved_id === null ? null : Number(row.resolved_id),
        limitationCode: row.limitation_code,
        answeredAt: row.answered_at,
        lastAttemptAt: row.last_attempt_at,
        retryNotBefore: row.retry_not_before
      }));
    },
    async reserve(locator, at) {
      const values = locatorValues(locator);
      validateTime(at);
      const token = randomUUID();
      // The conflict predicate is rechecked under PostgreSQL's row lock, so
      // overlapping subjects cannot dispatch the same historic profile.
      const result = await pool.query<{ attempt_token: string }>(
        `INSERT INTO raiderio_roster_profile_resolutions AS resolution
           (region, realm, name, historic_id, resolver_version, last_attempt_at, attempt_token, lease_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (region, realm, name, historic_id, resolver_version) DO UPDATE
           SET last_attempt_at = EXCLUDED.last_attempt_at,
               attempt_token = EXCLUDED.attempt_token, lease_until = EXCLUDED.lease_until
         WHERE resolution.last_attempt_at < $6
           AND (resolution.lease_until IS NULL OR resolution.lease_until <= $6)
           AND (resolution.retry_not_before IS NULL OR resolution.retry_not_before <= $6)
           AND (resolution.answered_at IS NULL OR resolution.answered_at <= $9)
         RETURNING attempt_token`,
        [
          ...values,
          at,
          token,
          new Date(at.getTime() + leaseMs),
          new Date(at.getTime() - answerLifetimeMs)
        ]
      );
      return result.rows[0]?.attempt_token ?? null;
    },
    async answer(locator, token, answer, at) {
      const values = locatorValues(locator);
      validateAnswer(answer);
      validateTime(at);
      const definitive =
        answer.resolvedId !== null ||
        permanentCodes.has(answer.limitationCode!);
      // Lock and inspect the original token, before clearing it. A late
      // response may extend Retry-After, but cannot change an answer or end
      // a newer reservation. GREATEST never shortens a provider cooldown.
      const result = await pool.query<{ accepted: boolean }>(
        `WITH locked AS MATERIALIZED (
           SELECT *, (attempt_token::text = $6 AND last_attempt_at <= $10) AS accepted
             FROM raiderio_roster_profile_resolutions
            WHERE region = $1 AND realm = $2 AND name = $3
              AND historic_id = $4 AND resolver_version = $5
            FOR UPDATE
         )
         UPDATE raiderio_roster_profile_resolutions AS resolution
            SET resolved_id = CASE WHEN locked.accepted THEN $7::bigint ELSE resolution.resolved_id END,
                limitation_code = CASE WHEN locked.accepted THEN $8::text ELSE resolution.limitation_code END,
                answered_at = CASE WHEN locked.accepted THEN $9::timestamptz ELSE resolution.answered_at END,
                retry_not_before = GREATEST(resolution.retry_not_before, $11::timestamptz),
                attempt_token = CASE WHEN locked.accepted THEN NULL ELSE resolution.attempt_token END,
                lease_until = CASE WHEN locked.accepted THEN NULL ELSE resolution.lease_until END
           FROM locked
          WHERE resolution.region = locked.region AND resolution.realm = locked.realm
            AND resolution.name = locked.name AND resolution.historic_id = locked.historic_id
            AND resolution.resolver_version = locked.resolver_version
         RETURNING COALESCE(locked.accepted, false) AS accepted`,
        [
          ...values,
          token,
          answer.resolvedId,
          answer.limitationCode,
          definitive ? at : null,
          at,
          answer.retryNotBefore ?? null
        ]
      );
      return result.rows[0]?.accepted ?? false;
    }
  };
}
