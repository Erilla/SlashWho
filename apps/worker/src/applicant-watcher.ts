import type { Pool } from "pg";
import type { DiscoveryQueue, Repositories } from "@slashwho/database";
import { startApplicantCollection } from "@slashwho/application";
import type { CharacterKey, RaiderIoGateway } from "@slashwho/domain";
import type { WarcraftLogsGateway } from "@slashwho/warcraftlogs";
import {
  applicantParserVersion,
  parseApplicantCandidates
} from "./applicant-candidates";
import {
  characterIdentity,
  decodeApplicantIdentity
} from "./applicant-identity";
import type { ApplicantSheetRow } from "./applicant-sheet";
import type { WorkerConfig } from "./config";

const source = "applicant_sheet";

export type NewApplicant = {
  battletag?: string;
  discordId?: string;
  characterName?: string;
  characterUrl: string;
  dossierPath?: string;
};

function displayField(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.trim().slice(0, 200) || undefined
    : undefined;
}

/** Expired suppressions may have been deleted before a deferred ID resolves. */
export async function wasSuppressedAt(
  pool: Pool,
  key: CharacterKey,
  at: Date
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM applicant_suppression_history
     WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
       AND suppressed_at <= $4 AND (expires_at IS NULL OR expires_at > $4)
       AND (ended_at IS NULL OR ended_at > $4)
     LIMIT 1`,
    [key.region, key.realm, key.name, at]
  );
  return result.rowCount === 1;
}
type CountRow = {
  identity: string;
  occurrence_count: number;
  deferred_observed_ats: (string | { at: string; index: number })[];
};
type DeferredObservation = { at: Date; index: number };
type IntentRow = {
  sequence: string;
  identity: string;
  observed_at: Date;
  attempts: number;
};

/**
 * Reconciliation commits all count changes and their intents together. Under a
 * new parser version it re-baselines: a count may rise only because the parser
 * now reads a response that was already there, so rises become the new counts,
 * and only submissions already deferred before the change are still admitted.
 */
export async function reconcileApplicantCounts(
  pool: Pool,
  counts: ReadonlyMap<string, number>,
  backlogLimit: number,
  at = new Date(),
  isSuppressed?: (
    identity: string,
    observedAt: Date
  ) => Promise<boolean | "defer">,
  parserVersion = applicantParserVersion
): Promise<{
  baseline: boolean;
  rebaselined: boolean;
  created: number;
  backlog: number;
  newOccurrences: { identity: string; index: number }[];
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [source]
    );
    const state = await client.query<{ parser_version: number }>(
      "SELECT parser_version FROM applicant_source_state WHERE source = $1",
      [source]
    );
    if (state.rowCount === 0) {
      await client.query(
        "INSERT INTO applicant_source_state (source, initialized_at, last_polled_at, parser_version) VALUES ($1, $2, $2, $3)",
        [source, at, parserVersion]
      );
      for (const [identity, count] of counts)
        await client.query(
          "INSERT INTO applicant_source_counts (source, identity, occurrence_count) VALUES ($1, $2, $3)",
          [source, identity, count]
        );
      await client.query("COMMIT");
      return {
        baseline: true,
        rebaselined: false,
        created: 0,
        backlog: 0,
        newOccurrences: []
      };
    }
    const rebaselined = state.rows[0]?.parser_version !== parserVersion;
    const existing = await client.query<CountRow>(
      "SELECT identity, occurrence_count, deferred_observed_ats FROM applicant_source_counts WHERE source = $1",
      [source]
    );
    const previous = new Map(
      existing.rows.map((row) => [row.identity, row.occurrence_count])
    );
    const deferredAt = new Map(
      existing.rows.map((row) => [row.identity, row.deferred_observed_ats])
    );
    const pending = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM applicant_source_intents WHERE source = $1 AND state IN ('pending', 'claimed')",
      [source]
    );
    let backlog = Number(pending.rows[0]?.count ?? 0);
    let created = 0;
    const newOccurrences: { identity: string; index: number }[] = [];
    for (const identity of new Set([...previous.keys(), ...counts.keys()])) {
      const current = counts.get(identity) ?? 0;
      const deferred = deferredAt.get(identity) ?? [];
      const counted = previous.get(identity) ?? 0;
      // Occurrences the new parser reads for the first time, taken to sit
      // ahead of the deferred ones, whose stored indexes shift past them.
      const shift = rebaselined
        ? Math.max(0, current - counted - deferred.length)
        : 0;
      const before = counted + shift;
      const pendingTimes =
        current < before
          ? []
          : deferred
              .slice(0, current - before)
              .map((value, index): DeferredObservation =>
                typeof value === "string"
                  ? { at: new Date(value), index: before + index }
                  : { at: new Date(value.at), index: value.index + shift }
              );
      while (pendingTimes.length < current - before)
        pendingTimes.push({ at, index: before + pendingTimes.length });
      const remaining: DeferredObservation[] = [];
      let admitted = 0;
      let suppressedCount = 0;
      for (const occurrence of pendingTimes) {
        const decision = await isSuppressed?.(identity, occurrence.at);
        if (
          decision === "defer" ||
          (decision === true && suppressedCount >= 1_000) ||
          (decision !== true && backlog >= backlogLimit)
        ) {
          remaining.push(occurrence);
          continue;
        }
        const suppressed = decision === true;
        await client.query(
          "INSERT INTO applicant_source_intents (source, identity, observed_at, state) VALUES ($1, $2, $3, $4)",
          [
            source,
            identity,
            occurrence.at,
            suppressed ? "suppressed" : "pending"
          ]
        );
        newOccurrences.push({ identity, index: occurrence.index });
        if (suppressed) suppressedCount++;
        else backlog++;
        admitted++;
      }
      const recorded = current < before ? current : before + admitted;
      if (previous.has(identity))
        await client.query(
          "UPDATE applicant_source_counts SET occurrence_count = $3, deferred_observed_ats = $4::jsonb WHERE source = $1 AND identity = $2",
          [source, identity, recorded, JSON.stringify(remaining)]
        );
      else
        await client.query(
          "INSERT INTO applicant_source_counts (source, identity, occurrence_count, deferred_observed_ats) VALUES ($1, $2, $3, $4::jsonb)",
          [source, identity, recorded, JSON.stringify(remaining)]
        );
      created += admitted;
    }
    await client.query(
      "UPDATE applicant_source_state SET last_polled_at = $2, parser_version = $3 WHERE source = $1",
      [source, at, parserVersion]
    );
    await client.query("COMMIT");
    return { baseline: false, rebaselined, created, backlog, newOccurrences };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function pollApplicantSheet(input: {
  pool: Pool;
  readColumn?(): Promise<unknown[]>;
  readRows?(): Promise<ApplicantSheetRow[]>;
  resolveDossierPath?: (identity: string) => string | undefined;
  backlogLimit: number;
  now?: () => Date;
  isSuppressed?: (
    identity: string,
    observedAt: Date
  ) => Promise<boolean | "defer">;
  parserVersion?: number;
}): Promise<{
  baseline: boolean;
  rebaselined: boolean;
  created: number;
  backlog: number;
  invalid: number;
  truncated: number;
  newApplicants: NewApplicant[];
}> {
  // A failed read never enters the transaction or advances durable state.
  const rows = input.readRows
    ? await input.readRows()
    : (await input.readColumn!()).map((linkCell, index) => ({
        row: index + 2,
        linkCell
      }));
  if (rows.length > 5_000) throw new Error("applicant_sheet_bounds_exceeded");
  const counts = new Map<string, number>();
  const occurrences = new Map<string, NewApplicant[]>();
  let invalid = 0;
  let truncated = 0;
  for (const row of rows) {
    const parsed = parseApplicantCandidates(row.linkCell);
    invalid += parsed.invalid;
    truncated += Number(parsed.truncated);
    for (const candidate of parsed.candidates) {
      counts.set(candidate.identity, (counts.get(candidate.identity) ?? 0) + 1);
      const applicant: NewApplicant = {
        battletag: displayField("battletag" in row ? row.battletag : undefined),
        discordId: displayField("discordId" in row ? row.discordId : undefined),
        characterName: displayField(
          "characterName" in row ? row.characterName : undefined
        ),
        characterUrl: candidate.url,
        ...(candidate.kind === "character"
          ? {
              dossierPath: `/dossiers/${candidate.key.region}/${candidate.key.realm}/${encodeURIComponent(candidate.key.name)}`
            }
          : {})
      };
      const list = occurrences.get(candidate.identity) ?? [];
      list.push(applicant);
      occurrences.set(candidate.identity, list);
    }
  }
  const reconciliation = await reconcileApplicantCounts(
    input.pool,
    counts,
    input.backlogLimit,
    input.now?.(),
    input.isSuppressed,
    input.parserVersion
  );
  const { newOccurrences, ...state } = reconciliation;
  return {
    ...state,
    invalid,
    truncated,
    newApplicants: newOccurrences.flatMap(({ identity, index }) => {
      const applicant = occurrences.get(identity)?.[index];
      if (!applicant) return [];
      const resolvedPath = input.resolveDossierPath?.(identity);
      return [
        {
          ...applicant,
          ...(resolvedPath ? { dossierPath: resolvedPath } : {})
        }
      ];
    })
  };
}

export async function claimNext(pool: Pool): Promise<IntentRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [source + ":drain"]
    );
    const result = await client.query<IntentRow>(
      "SELECT sequence, identity, observed_at, attempts FROM applicant_source_intents WHERE source = $1 AND (state = 'pending' OR (state = 'claimed' AND claimed_until < now())) AND (retry_after IS NULL OR retry_after <= now()) ORDER BY sequence LIMIT 1 FOR UPDATE SKIP LOCKED",
      [source]
    );
    const intent = result.rows[0];
    if (intent)
      await client.query(
        "UPDATE applicant_source_intents SET state = 'claimed', claimed_until = now() + interval '10 minutes', claimed_at = now(), attempts = attempts + 1 WHERE sequence = $1",
        [intent.sequence]
      );
    await client.query("COMMIT");
    return intent ?? null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Charges the daily budget once per canonical dispatch, after ID resolution. */
export async function admitCanonicalIntent(
  pool: Pool,
  intent: IntentRow,
  canonicalIdentity: string,
  perDay: number
): Promise<"admitted" | "duplicate" | "wait" | "daily_limit"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [source + ":drain"]
    );
    const earlier = await client.query<{ state: string }>(
      "SELECT state FROM applicant_source_intents WHERE source = $1 AND observed_at = $2 AND canonical_identity = $3 AND sequence < $4 AND state IN ('pending', 'claimed', 'done') ORDER BY sequence LIMIT 1",
      [source, intent.observed_at, canonicalIdentity, intent.sequence]
    );
    if (earlier.rows[0]) {
      if (earlier.rows[0].state === "done") {
        await client.query(
          "UPDATE applicant_source_intents SET canonical_identity = $2, state = 'done', claimed_until = NULL, claimed_at = NULL WHERE sequence = $1 AND state = 'claimed'",
          [intent.sequence, canonicalIdentity]
        );
        await client.query("COMMIT");
        return "duplicate";
      }
      await client.query(
        "UPDATE applicant_source_intents SET canonical_identity = $2, state = 'pending', claimed_until = NULL, claimed_at = NULL, retry_after = now() + interval '1 minute' WHERE sequence = $1 AND state = 'claimed'",
        [intent.sequence, canonicalIdentity]
      );
      await client.query("COMMIT");
      return "wait";
    }
    const current = await client.query<{ charged_at: Date | null }>(
      "SELECT charged_at FROM applicant_source_intents WHERE sequence = $1 FOR UPDATE",
      [intent.sequence]
    );
    if (!current.rows[0]?.charged_at) {
      const spent = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM applicant_source_intents WHERE source = $1 AND charged_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
        [source]
      );
      if (Number(spent.rows[0]?.count ?? 0) >= perDay) {
        await client.query(
          "UPDATE applicant_source_intents SET canonical_identity = $2, state = 'pending', claimed_until = NULL, claimed_at = NULL, retry_after = (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + interval '1 day' WHERE sequence = $1 AND state = 'claimed'",
          [intent.sequence, canonicalIdentity]
        );
        await client.query("COMMIT");
        return "daily_limit";
      }
    }
    await client.query(
      "UPDATE applicant_source_intents SET canonical_identity = $2, charged_at = COALESCE(charged_at, now()) WHERE sequence = $1 AND state = 'claimed'",
      [intent.sequence, canonicalIdentity]
    );
    await client.query("COMMIT");
    return "admitted";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function drainApplicantIntents(input: {
  pool: Pool;
  config: WorkerConfig;
  repositories: Repositories;
  queue: DiscoveryQueue;
  raiderio: Pick<RaiderIoGateway, "getCharacter">;
  warcraftlogs: Pick<
    WarcraftLogsGateway,
    "resolveCharacterById" | "getRateLimit"
  >;
}): Promise<{ admitted: number; suppressed: number; deferred: number }> {
  const policy = input.config.applicantWatcher;
  let admitted = 0,
    suppressed = 0,
    deferred = 0;
  for (let i = 0; i < policy.perTick; i++) {
    const waiting = await input.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM applicant_source_intents WHERE source = $1 AND (state = 'pending' OR (state = 'claimed' AND claimed_until < now())) AND (retry_after IS NULL OR retry_after <= now())",
      [source]
    );
    if (Number(waiting.rows[0]?.count ?? 0) === 0) break;
    const queueDepth = await input.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pgboss.job WHERE name = ANY($1::text[]) AND state < 'active'",
      [["discover-character", "collect-character-evidence"]]
    );
    if (Number(queueDepth.rows[0]?.count ?? 0) >= policy.queueDepth) break;
    const recentCost = await input.pool.query<{ reserve: number | null }>(
      "SELECT MAX(points_spent) * 1.2 AS reserve FROM character_evidence_run_costs WHERE credentials = 'own' AND points_spent > 0 AND recorded_at >= now() - interval '28 days'"
    );
    const neededPoints = Math.max(
      policy.minimumPoints,
      Number(recentCost.rows[0]?.reserve ?? 0)
    );
    const reserved = await input.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM character_evidence_runs WHERE status IN ('queued', 'running', 'retrying') AND wcl_client_id_encrypted IS NULL"
    );
    const reservedPoints = Number(reserved.rows[0]?.count ?? 0) * neededPoints;
    const allowance = await input.warcraftlogs.getRateLimit();
    if (
      allowance.kind !== "rate_limit" ||
      allowance.limitPerHour - allowance.pointsSpentThisHour - reservedPoints <
        neededPoints
    )
      break;
    const intent = await claimNext(input.pool);
    if (!intent) break;
    try {
      const identity = decodeApplicantIdentity(intent.identity);
      let key: CharacterKey;
      if (identity.kind === "warcraftlogs_id") {
        const resolved = await input.warcraftlogs.resolveCharacterById(
          identity.id
        );
        if (resolved.kind !== "identity")
          throw new Error("applicant_identity_unavailable");
        key = resolved.key;
      } else key = identity.key;
      const canonicalIdentity = characterIdentity(key);
      const admission = await admitCanonicalIntent(
        input.pool,
        intent,
        canonicalIdentity,
        policy.perDay
      );
      if (admission === "duplicate" || admission === "wait") continue;
      if (admission === "daily_limit") break;
      const outcome = await startApplicantCollection({
        key,
        observedAt: intent.observed_at,
        discoveryFreshnessHours: 24,
        evidenceFreshnessHours: input.config.evidenceFreshnessHours,
        repositories: input.repositories,
        queue: input.queue,
        raiderio: input.raiderio
      });
      if (outcome === "unavailable")
        throw new Error("applicant_collection_unavailable");
      const state = outcome === "suppressed" ? "suppressed" : "done";
      await input.pool.query(
        "UPDATE applicant_source_intents SET state = $2, claimed_until = NULL WHERE sequence = $1 AND state = 'claimed'",
        [intent.sequence, state]
      );
      if (state === "suppressed") suppressed++;
      else admitted++;
    } catch {
      deferred++;
      await input.pool.query(
        "UPDATE applicant_source_intents SET state = 'pending', claimed_until = NULL, retry_after = now() + make_interval(secs => $2::integer) WHERE sequence = $1 AND state = 'claimed'",
        [
          intent.sequence,
          Math.min(3600, 60 * 2 ** Math.min(intent.attempts, 6))
        ]
      );
    }
  }
  return { admitted, suppressed, deferred };
}
