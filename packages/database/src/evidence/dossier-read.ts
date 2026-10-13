import type { CharacterKey } from "@slashwho/domain";
import type { Pool, PoolClient } from "pg";
import {
  type CompletedEvidenceSelection,
  type DossierEvidenceCandidate,
  type DossierEvidencePayload,
  type DossierEvidenceReadResult,
  type EvidenceReadStepMeasurement,
  type EvidenceRunPhase
} from "../repositories";
import {
  evidenceRunColumns,
  mapEvidenceRun,
  type EvidenceRunRow
} from "../mappers";
import { withConsistentRead, type Queryable } from "../sql";
import { CURRENT_EVIDENCE_VERSION, isEvidenceFresh } from "./freshness";
import { hydrateCompletedEvidenceBatch } from "./load";

type SelectedRun = EvidenceRunRow & {
  key_index: number;
  selected: "snapshot" | "full";
  evidence_version: number;
  publication_scope: "full" | "tier";
};

function keyId(key: CharacterKey): string {
  return JSON.stringify([key.region, key.realm, key.name]);
}

function uniqueKeys(keys: readonly CharacterKey[]): readonly CharacterKey[] {
  const seen = new Set<string>();
  return keys.filter((key) => {
    const id = keyId(key);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function arrays(keys: readonly CharacterKey[]) {
  return [
    keys.map((key) => key.region),
    keys.map((key) => key.realm),
    keys.map((key) => key.name)
  ];
}

async function hydratePayloads(
  client: Queryable,
  candidates: readonly DossierEvidenceCandidate[],
  measureReadStep?: EvidenceReadStepMeasurement
): Promise<readonly DossierEvidencePayload[]> {
  if (candidates.length === 0) return [];
  const selections = candidates.flatMap((candidate) =>
    candidate.completed ? [candidate.completed] : []
  );
  const hydrated = await hydrateCompletedEvidenceBatch(
    client,
    selections,
    measureReadStep
  );
  const keys = candidates.map((candidate) => candidate.key);
  const aliases = await client.query<{
    key_index: number;
    region: CharacterKey["region"];
    realm_slug: string;
    normalized_name: string;
  }>(
    `WITH keys AS (
         SELECT region, realm_slug, normalized_name,
                ordinality::int - 1 AS key_index
           FROM unnest($1::text[], $2::text[], $3::text[])
             WITH ORDINALITY AS requested(region, realm_slug, normalized_name, ordinality)
       )
       SELECT keys.key_index, alias.region, alias.realm_slug, alias.normalized_name
         FROM keys
         JOIN characters character
           ON character.region = keys.region
          AND character.realm_slug = keys.realm_slug
          AND character.normalized_name = keys.normalized_name
         JOIN character_historic_aliases alias
           ON alias.character_id = character.id
        ORDER BY keys.key_index, alias.created_at, alias.region,
                 alias.realm_slug, alias.normalized_name`,
    arrays(keys)
  );
  const phaseRows = await client.query<{
    run_id: string;
    id: string;
    ordinal: number;
    state: EvidenceRunPhase["state"];
    started_at: Date | null;
    completed_at: Date | null;
    limitation_code: string | null;
  }>(
    `SELECT run_id, phase_id AS id, ordinal, state,
              started_at, completed_at, limitation_code
         FROM character_evidence_run_phases
        WHERE run_id = ANY($1::uuid[])
        ORDER BY run_id, ordinal`,
    [
      candidates.flatMap((candidate) =>
        candidate.active ? [candidate.active.id] : []
      )
    ]
  );
  const aliasesByIndex = new Map<number, CharacterKey[]>();
  for (const row of aliases.rows)
    aliasesByIndex.set(row.key_index, [
      ...(aliasesByIndex.get(row.key_index) ?? []),
      { region: row.region, realm: row.realm_slug, name: row.normalized_name }
    ]);
  const phasesByRun = new Map<string, EvidenceRunPhase[]>();
  for (const row of phaseRows.rows)
    phasesByRun.set(row.run_id, [
      ...(phasesByRun.get(row.run_id) ?? []),
      {
        id: row.id,
        ordinal: row.ordinal,
        state: row.state,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        limitationCode: row.limitation_code
      }
    ]);
  return candidates.map((candidate, index) => ({
    key: candidate.key,
    completed: candidate.completed
      ? (hydrated.get(candidate.completed.snapshotRunId) ?? null)
      : null,
    historicAliases: aliasesByIndex.get(index) ?? [],
    phases: candidate.active ? (phasesByRun.get(candidate.active.id) ?? []) : []
  }));
}

async function readCandidates(
  client: PoolClient,
  keys: readonly CharacterKey[],
  at: Date,
  freshnessCutoff: Date
): Promise<readonly DossierEvidenceCandidate[]> {
  const params = arrays(keys);
  const runs = await client.query<SelectedRun>(
    `WITH keys AS (
         SELECT region, realm_slug, normalized_name,
                ordinality::int - 1 AS key_index
           FROM unnest($1::text[], $2::text[], $3::text[])
             WITH ORDINALITY AS requested(region, realm_slug, normalized_name, ordinality)
       )
       SELECT keys.key_index, 'snapshot'::text AS selected, snapshot.*
         FROM keys
         JOIN LATERAL (
           SELECT ${evidenceRunColumns("run")}, run.evidence_version,
                  run.publication_scope
             FROM character_evidence_runs run
            WHERE run.region = keys.region AND run.realm_slug = keys.realm_slug
              AND run.normalized_name = keys.normalized_name
              AND run.status IN ('complete', 'partial')
            ORDER BY run.completed_at DESC, run.id DESC LIMIT 1
         ) snapshot ON true
       UNION ALL
       SELECT keys.key_index, 'full'::text AS selected, full_run.*
         FROM keys
         JOIN LATERAL (
           SELECT ${evidenceRunColumns("run")}, run.evidence_version,
                  run.publication_scope
             FROM character_evidence_runs run
            WHERE run.region = keys.region AND run.realm_slug = keys.realm_slug
              AND run.normalized_name = keys.normalized_name
              AND run.status IN ('complete', 'partial')
              AND run.publication_scope = 'full'
            ORDER BY run.completed_at DESC, run.id DESC LIMIT 1
         ) full_run ON true
       ORDER BY key_index, selected`,
    params
  );
  const aliasRows = await client.query<{ key_index: number; pending: boolean }>(
    `WITH keys AS (
         SELECT region, realm_slug, normalized_name,
                ordinality::int - 1 AS key_index
           FROM unnest($1::text[], $2::text[], $3::text[])
             WITH ORDINALITY AS requested(region, realm_slug, normalized_name, ordinality)
       )
       SELECT keys.key_index, EXISTS (
         SELECT 1 FROM character_alias_recollections pending
          WHERE pending.region = keys.region AND pending.realm_slug = keys.realm_slug
            AND pending.normalized_name = keys.normalized_name
       ) AS pending
       FROM keys`,
    params
  );
  const activeRows = await client.query<EvidenceRunRow & { key_index: number }>(
    `WITH keys AS (
         SELECT region, realm_slug, normalized_name,
                ordinality::int - 1 AS key_index
           FROM unnest($1::text[], $2::text[], $3::text[])
             WITH ORDINALITY AS requested(region, realm_slug, normalized_name, ordinality)
       )
       SELECT keys.key_index, active.*
         FROM keys
         JOIN LATERAL (
           SELECT ${evidenceRunColumns("run")}
             FROM character_evidence_runs run
            WHERE run.region = keys.region AND run.realm_slug = keys.realm_slug
              AND run.normalized_name = keys.normalized_name
              AND run.status IN ('queued', 'running', 'retrying')
            ORDER BY run.created_at DESC, run.id DESC LIMIT 1
         ) active ON true`,
    params
  );
  const continuationRows = await client.query<{
    key_index: number;
    due_at: Date;
  }>(
    `WITH keys AS (
         SELECT region, realm_slug, normalized_name,
                ordinality::int - 1 AS key_index
           FROM unnest($1::text[], $2::text[], $3::text[])
             WITH ORDINALITY AS requested(region, realm_slug, normalized_name, ordinality)
       ), latest AS (
         SELECT keys.key_index, run.tier_search_raid_id, run.created_at, run.status,
                run.ranked_backfill_attempted, run.ranked_backfill_cursor,
                run.retry_after_at
           FROM keys
           JOIN character_evidence_runs run
             ON run.region = keys.region AND run.realm_slug = keys.realm_slug
            AND run.normalized_name = keys.normalized_name
          WHERE run.mode = 'tier_search' AND run.status IN ('complete', 'partial')
            AND NOT EXISTS (
              SELECT 1 FROM character_evidence_runs newer
               WHERE newer.region = run.region AND newer.realm_slug = run.realm_slug
                 AND newer.normalized_name = run.normalized_name
                 AND newer.mode = 'tier_search'
                 AND newer.tier_search_raid_id = run.tier_search_raid_id
                 AND (newer.created_at, newer.id) > (run.created_at, run.id)
            )
       )
       SELECT latest.key_index, GREATEST(
                latest.retry_after_at,
                (SELECT MAX(failed.completed_at) + interval '30 minutes'
                   FROM character_evidence_runs failed
                  WHERE failed.region = keys.region AND failed.realm_slug = keys.realm_slug
                    AND failed.normalized_name = keys.normalized_name
                    AND failed.tier_search_raid_id = latest.tier_search_raid_id
                    AND failed.mode = 'tier_search' AND failed.status = 'failed'
                    AND failed.created_at > latest.created_at)
              ) AS due_at
         FROM latest JOIN keys USING (key_index)
        WHERE latest.status = 'partial' AND latest.ranked_backfill_attempted = true
          AND jsonb_typeof(latest.ranked_backfill_cursor) = 'object'
          AND latest.retry_after_at IS NOT NULL
        ORDER BY latest.key_index, due_at`,
    params
  );

  const snapshots = new Map<number, SelectedRun>();
  const fullRuns = new Map<number, SelectedRun>();
  for (const row of runs.rows)
    (row.selected === "snapshot" ? snapshots : fullRuns).set(
      row.key_index,
      row
    );
  const aliases = new Map(
    aliasRows.rows.map((row) => [row.key_index, row.pending])
  );
  const active = new Map(
    activeRows.rows.map((row) => [row.key_index, mapEvidenceRun(row)])
  );
  const continuations = new Map<number, Date[]>();
  for (const row of continuationRows.rows)
    continuations.set(row.key_index, [
      ...(continuations.get(row.key_index) ?? []),
      row.due_at
    ]);
  return keys.map((key, index) => {
    const snapshot = snapshots.get(index);
    const full = fullRuns.get(index);
    const run = snapshot
      ? snapshot.publication_scope === "tier"
        ? (full ?? snapshot)
        : snapshot
      : null;
    const completed: CompletedEvidenceSelection | null =
      snapshot && run
        ? {
            run: mapEvidenceRun(run),
            evidenceVersion: run.evidence_version,
            snapshotRunId: snapshot.id,
            wipeCapable: snapshot.evidence_version >= 2
          }
        : null;
    const due = continuations.get(index) ?? [];
    const dueNow = due.some((continuation) => continuation <= at);
    const future = due.filter((continuation) => continuation > at);
    const tierSearchResumesAt = future.length
      ? new Date(
          Math.min(...future.map((continuation) => continuation.getTime()))
        )
      : null;
    const completedVersionCurrent =
      completed?.evidenceVersion !== undefined &&
      completed.evidenceVersion >= CURRENT_EVIDENCE_VERSION;
    const fresh = Boolean(
      completed &&
      completedVersionCurrent &&
      completed.run.completedAt !== null &&
      aliases.get(index) !== true &&
      !dueNow &&
      isEvidenceFresh(
        completed.run.completedAt,
        completed.run.retryAfterAt,
        freshnessCutoff,
        at
      )
    );
    return {
      key,
      completed,
      completedVersionCurrent,
      fresh,
      active: active.get(index) ?? null,
      tierSearchResumesAt
    } satisfies DossierEvidenceCandidate;
  });
}

export async function readDossierEvidence(
  pool: Pool,
  input: Readonly<{
    keys: readonly CharacterKey[];
    root: CharacterKey;
    at: Date;
    freshnessCutoff: Date;
  }>,
  measureReadStep?: EvidenceReadStepMeasurement
): Promise<DossierEvidenceReadResult> {
  if (
    Number.isNaN(input.at.valueOf()) ||
    Number.isNaN(input.freshnessCutoff.valueOf())
  )
    throw new RangeError("dossier_evidence_read_time_invalid");
  const keys = uniqueKeys(input.keys);
  if (keys.length === 0) return { candidates: [], payloads: [] };
  return withConsistentRead(pool, async (client) => {
    const candidates = await readCandidates(
      client,
      keys,
      input.at,
      input.freshnessCutoff
    );
    const root = candidates.find(
      (candidate) => keyId(candidate.key) === keyId(input.root)
    );
    const payloads =
      root?.fresh === true
        ? await hydratePayloads(
            client,
            candidates.filter((candidate) => candidate.fresh),
            measureReadStep
          )
        : null;
    return { candidates, payloads };
  });
}

export async function hydrateDossierEvidence(
  pool: Pool,
  candidates: readonly DossierEvidenceCandidate[],
  measureReadStep?: EvidenceReadStepMeasurement
): Promise<readonly DossierEvidencePayload[]> {
  return withConsistentRead(pool, (client) =>
    hydratePayloads(client, candidates, measureReadStep)
  );
}
