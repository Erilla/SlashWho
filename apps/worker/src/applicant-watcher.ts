import type { Pool } from "pg";
import type { DiscoveryQueue, Repositories } from "@slashwho/database";
import { startApplicantCollection } from "@slashwho/application";
import type { CharacterKey, RaiderIoGateway } from "@slashwho/domain";
import type { WarcraftLogsGateway } from "@slashwho/warcraftlogs";
import { parseApplicantCandidates } from "./applicant-candidates";
import {
  characterIdentity,
  decodeApplicantIdentity
} from "./applicant-identity";
import type { WorkerConfig } from "./config";

const source = "applicant_sheet";
type CountRow = { identity: string; occurrence_count: number };
type IntentRow = {
  sequence: string;
  identity: string;
  observed_at: Date;
  attempts: number;
};

/** Reconciliation commits all count changes and their intents together. */
export async function reconcileApplicantCounts(
  pool: Pool,
  counts: ReadonlyMap<string, number>,
  backlogLimit: number,
  at = new Date(),
  isSuppressed?: (identity: string) => Promise<boolean | "defer">
): Promise<{ baseline: boolean; created: number; backlog: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [source]
    );
    const state = await client.query(
      "SELECT 1 FROM applicant_source_state WHERE source = $1",
      [source]
    );
    if (state.rowCount === 0) {
      await client.query(
        "INSERT INTO applicant_source_state (source, initialized_at, last_polled_at) VALUES ($1, $2, $2)",
        [source, at]
      );
      for (const [identity, count] of counts)
        await client.query(
          "INSERT INTO applicant_source_counts (source, identity, occurrence_count) VALUES ($1, $2, $3)",
          [source, identity, count]
        );
      await client.query("COMMIT");
      return { baseline: true, created: 0, backlog: 0 };
    }
    const existing = await client.query<CountRow>(
      "SELECT identity, occurrence_count FROM applicant_source_counts WHERE source = $1",
      [source]
    );
    const previous = new Map(
      existing.rows.map((row) => [row.identity, row.occurrence_count])
    );
    const pending = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM applicant_source_intents WHERE source = $1 AND state IN ('pending', 'claimed')",
      [source]
    );
    let backlog = Number(pending.rows[0]?.count ?? 0);
    let created = 0;
    for (const identity of new Set([...previous.keys(), ...counts.keys()])) {
      const before = previous.get(identity) ?? 0;
      const current = counts.get(identity) ?? 0;
      const increase = Math.max(0, current - before);
      const decision = increase > 0 ? await isSuppressed?.(identity) : false;
      const admitted =
        decision === "defer"
          ? 0
          : decision === true
            ? Math.min(increase, 1_000)
            : Math.min(increase, Math.max(0, backlogLimit - backlog));
      for (let index = 0; index < admitted; index++) {
        const suppressed = decision === true;
        await client.query(
          "INSERT INTO applicant_source_intents (source, identity, observed_at, state) VALUES ($1, $2, $3, $4)",
          [source, identity, at, suppressed ? "suppressed" : "pending"]
        );
        if (suppressed) backlog--;
      }
      const recorded = current < before ? current : before + admitted;
      if (previous.has(identity))
        await client.query(
          "UPDATE applicant_source_counts SET occurrence_count = $3 WHERE source = $1 AND identity = $2",
          [source, identity, recorded]
        );
      else
        await client.query(
          "INSERT INTO applicant_source_counts (source, identity, occurrence_count) VALUES ($1, $2, $3)",
          [source, identity, recorded]
        );
      backlog += admitted;
      created += admitted;
    }
    await client.query(
      "UPDATE applicant_source_state SET last_polled_at = $2 WHERE source = $1",
      [source, at]
    );
    await client.query("COMMIT");
    return { baseline: false, created, backlog };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function pollApplicantSheet(input: {
  pool: Pool;
  readColumn(): Promise<unknown[]>;
  backlogLimit: number;
  now?: () => Date;
  isSuppressed?: (identity: string) => Promise<boolean | "defer">;
}): Promise<{
  baseline: boolean;
  created: number;
  backlog: number;
  invalid: number;
  truncated: number;
}> {
  // A failed read never enters the transaction or advances durable state.
  const cells = await input.readColumn();
  if (cells.length > 5_000) throw new Error("applicant_sheet_bounds_exceeded");
  const counts = new Map<string, number>();
  let invalid = 0;
  let truncated = 0;
  for (const cell of cells) {
    const parsed = parseApplicantCandidates(cell);
    invalid += parsed.invalid;
    truncated += Number(parsed.truncated);
    for (const candidate of parsed.candidates)
      counts.set(candidate.identity, (counts.get(candidate.identity) ?? 0) + 1);
  }
  return {
    ...(await reconcileApplicantCounts(
      input.pool,
      counts,
      input.backlogLimit,
      input.now?.(),
      input.isSuppressed
    )),
    invalid,
    truncated
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
