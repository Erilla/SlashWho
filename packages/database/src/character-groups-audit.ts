import type { Pool, PoolClient } from "pg";
import {
  canonicalCharacterId,
  familyOf,
  type CharacterKey,
  type GroupGraph,
  type ObservationSource,
  type StrengthLink
} from "@slashwho/domain";
import { withConsistentRead } from "./sql";

/** One `character_connection_write_log` row (#738). */
export type CharacterGroupsLedgerRow = Readonly<{
  runId: string;
  sweepReservationId: string | null;
  observerId: string;
  family: string;
  decision: string;
  reason: string;
  runStartedAt: Date;
  writtenAt: Date;
}>;

/** One `observed` `character_connections` row (#738). */
export type CharacterGroupsObservation = Readonly<{
  lowId: string;
  highId: string;
  source: string;
  observerId: string;
  runId: string;
  observedAt: Date;
}>;

/**
 * Something that owes the ledger a row: a completed discovery run, which owes
 * a Raider.IO row, or a published sweep reservation, which owes a fingerprint
 * row. `at` is when it was published: the run's `completed_at`, or the
 * reservation's `finished_at`, since an amend never moves `refreshed_at`.
 */
export type CharacterGroupsPublication = Readonly<
  | { kind: "run"; runId: string; observerId: string; at: Date }
  | {
      kind: "reservation";
      reservationId: string;
      runId: string;
      observerId: string;
      at: Date;
    }
>;

/** Everything the character groups replay reads, from one database snapshot. */
export type CharacterGroupsAudit = Readonly<{
  now: Date;
  /** The phase 2 read model, suppression and all; `groupOf` is the stored groups. */
  graph: GroupGraph;
  groups: ReadonlyMap<
    string,
    Readonly<{ recomputedAt: Date; members: readonly string[] }>
  >;
  maintenance: Readonly<{
    lastCycleStartedAt: Date | null;
    lastCycleCompletedAt: Date | null;
  }>;
  observations: readonly CharacterGroupsObservation[];
  ledger: readonly CharacterGroupsLedgerRow[];
  publications: readonly CharacterGroupsPublication[];
  /** Root id to its latest snapshot's member ids, ignoring suppression. */
  latestRawMembership: ReadonlyMap<string, readonly string[]>;
  /** The newest `manual_dossier_connections.created_at` or `excluded_at`. */
  manualChangedAt: Date | null;
  /** Every character in any latest snapshot, suppressed ones left out. */
  roots: readonly CharacterKey[];
  /**
   * Characters in no group, by when their row was created: the recompute
   * pass assigns them, so each is pending until a cycle that started after
   * its creation completes.
   */
  ungroupedSince: ReadonlyMap<string, Date>;
}>;

/**
 * Counting links over every character, each labelled with its strength:
 * observed links by source family, except pairs with a rejection row, and
 * every resolved manual connection. Mirrors `COUNTING_LINKS_FROM` in
 * `character-connections.ts` without its `= ANY` filters.
 */
const COUNTING_LINKS_WITH_STRENGTH = `
  SELECT DISTINCT connection.character_low_id AS a,
         connection.character_high_id AS b,
         connection.source AS source
  FROM character_connections connection
  WHERE connection.kind = 'observed'
    AND NOT EXISTS (
      SELECT 1 FROM character_connections rejection
      WHERE rejection.kind = 'rejected'
        AND rejection.character_low_id = connection.character_low_id
        AND rejection.character_high_id = connection.character_high_id
    )
  UNION
  SELECT manual.root_character_id, target.id, NULL
  FROM manual_dossier_connections manual
  JOIN characters target ON target.region = manual.connected_region
    AND target.realm_slug = manual.connected_realm_slug
    AND target.normalized_name = manual.connected_normalized_name
  WHERE target.id <> manual.root_character_id`;

/** Each root's latest snapshot, as `getCurrent` chooses it, before suppression. */
const LATEST_SNAPSHOTS = `
  SELECT DISTINCT ON (snapshot.root_character_id)
    snapshot.id, snapshot.root_character_id, snapshot.state, snapshot.limitation_code
  FROM snapshots snapshot
  JOIN discovery_runs run ON run.id = snapshot.discovery_run_id AND run.status = 'complete'
  ORDER BY snapshot.root_character_id, snapshot.refreshed_at DESC, snapshot.id DESC`;

/**
 * Loads the character groups replay's inputs in one consistent read (#738).
 * Read-only: it runs in a `READ ONLY` transaction and writes nothing.
 */
export function loadCharacterGroupsAudit(
  pool: Pool,
  now: Date = new Date()
): Promise<CharacterGroupsAudit> {
  return withConsistentRead(pool, (client) => load(client, now));
}

async function load(
  client: PoolClient,
  now: Date
): Promise<CharacterGroupsAudit> {
  const characterRows = await client.query<{
    id: string;
    region: CharacterKey["region"];
    realm_slug: string;
    normalized_name: string;
    display_name: string;
    class_name: string;
    level: number;
    raider_io_url: string;
  }>(
    `SELECT id, region, realm_slug, normalized_name, display_name, class_name,
            level, raider_io_url
     FROM characters`
  );
  const characters = new Map(
    characterRows.rows.map((row) => [
      row.id,
      {
        key: {
          region: row.region,
          realm: row.realm_slug,
          name: row.normalized_name
        },
        displayName: row.display_name,
        className: row.class_name,
        level: row.level,
        raiderIoUrl: row.raider_io_url
      }
    ])
  );
  const idByCanonical = new Map(
    [...characters].map(([id, character]) => [
      canonicalCharacterId(character.key),
      id
    ])
  );

  const membershipRows = await client.query<{
    character_id: string;
    group_id: string;
  }>(`SELECT character_id, group_id FROM character_group_members`);
  const groupOf = new Map(
    membershipRows.rows.map((row) => [row.character_id, row.group_id])
  );
  const groupRows = await client.query<{ id: string; recomputed_at: Date }>(
    `SELECT id, recomputed_at FROM character_groups`
  );
  const membersOf = new Map<string, string[]>();
  for (const row of membershipRows.rows) {
    membersOf.set(row.group_id, [
      ...(membersOf.get(row.group_id) ?? []),
      row.character_id
    ]);
  }
  const groups = new Map(
    groupRows.rows.map((row) => [
      row.id,
      {
        recomputedAt: row.recomputed_at,
        members: [...(membersOf.get(row.id) ?? [])].sort()
      }
    ])
  );
  const ungroupedRows = await client.query<{ id: string; created_at: Date }>(
    `SELECT character.id, character.created_at
     FROM characters character
     LEFT JOIN character_group_members member ON member.character_id = character.id
     WHERE member.character_id IS NULL`
  );

  const linkRows = await client.query<{
    a: string;
    b: string;
    source: ObservationSource | null;
  }>(COUNTING_LINKS_WITH_STRENGTH);
  const links = linkRows.rows.map((row): StrengthLink => ({
    a: row.a,
    b: row.b,
    strength: row.source === null ? "manual" : familyOf(row.source)
  }));

  const manualRows = await client.query<{
    maker: string;
    target: string;
    excluded: boolean;
  }>(
    `SELECT manual.root_character_id AS maker, target.id AS target,
            manual.excluded_at IS NOT NULL AS excluded
     FROM manual_dossier_connections manual
     JOIN characters target ON target.region = manual.connected_region
       AND target.realm_slug = manual.connected_realm_slug
       AND target.normalized_name = manual.connected_normalized_name`
  );
  const manualChanged = await client.query<{ changed_at: Date | null }>(
    `SELECT max(GREATEST(created_at, COALESCE(excluded_at, created_at))) AS changed_at
     FROM manual_dossier_connections`
  );

  const exclusionRows = await client.query<{ maker: string; target: string }>(
    `SELECT exclusion.root_character_id AS maker, target.id AS target
     FROM dossier_character_exclusions exclusion
     JOIN characters target ON target.region = exclusion.region
       AND target.realm_slug = exclusion.realm_slug
       AND target.normalized_name = exclusion.normalized_name`
  );

  const suppressedRows = await client.query<{ id: string }>(
    `SELECT character.id
     FROM characters character
     JOIN suppressed_characters suppression
       ON suppression.region = character.region
      AND suppression.realm_slug = character.realm_slug
      AND suppression.normalized_name = character.normalized_name
     WHERE suppression.expires_at IS NULL OR suppression.expires_at > now()`
  );
  const suppressed = new Set(suppressedRows.rows.map((row) => row.id));

  const warcraftLogsRows = await client.query<{
    id: string;
    character_id: number;
  }>(
    `SELECT character.id, ids.character_id
     FROM warcraft_logs_character_ids ids
     JOIN characters character ON character.region = ids.region
       AND character.realm_slug = ids.realm_slug
       AND character.normalized_name = ids.normalized_name`
  );
  const warcraftLogsIds = new Map(
    warcraftLogsRows.rows.map((row) => [row.id, row.character_id])
  );
  const idsByWarcraftLogsId = new Map<number, string[]>();
  for (const [id, wcl] of warcraftLogsIds) {
    idsByWarcraftLogsId.set(wcl, [...(idsByWarcraftLogsId.get(wcl) ?? []), id]);
  }

  const latestRows = await client.query<{
    id: string;
    root_character_id: string;
    state: "complete" | "partial";
    limitation_code: string | null;
  }>(LATEST_SNAPSHOTS);
  const latestSnapshot = new Map(
    latestRows.rows
      .filter((row) => !suppressed.has(row.root_character_id))
      .map((row) => [
        row.root_character_id,
        { state: row.state, limitationCode: row.limitation_code }
      ])
  );
  const rawMembershipRows = await client.query<{
    root_character_id: string;
    character_id: string;
  }>(
    `WITH latest AS (${LATEST_SNAPSHOTS})
     SELECT latest.root_character_id, member.character_id
     FROM latest
     JOIN snapshot_characters member ON member.snapshot_id = latest.id
     ORDER BY latest.root_character_id, member.display_order`
  );
  const latestRawMembership = new Map<string, string[]>();
  for (const row of rawMembershipRows.rows) {
    latestRawMembership.set(row.root_character_id, [
      ...(latestRawMembership.get(row.root_character_id) ?? []),
      row.character_id
    ]);
  }

  const observationRows = await client.query<{
    character_low_id: string;
    character_high_id: string;
    source: string;
    observed_from_character_id: string;
    discovery_run_id: string;
    observed_at: Date;
  }>(
    `SELECT character_low_id, character_high_id, source,
            observed_from_character_id, discovery_run_id, observed_at
     FROM character_connections WHERE kind = 'observed'`
  );

  const ledgerRows = await client.query<{
    run_id: string;
    sweep_reservation_id: string | null;
    observer_character_id: string;
    family: string;
    decision: string;
    reason: string;
    run_started_at: Date;
    written_at: Date;
  }>(
    `SELECT run_id, sweep_reservation_id, observer_character_id, family,
            decision, reason, run_started_at, written_at
     FROM character_connection_write_log ORDER BY id`
  );

  // A run's root is found by its key, not `root_character_id`: a run that
  // completes against a live sweep's snapshot never sets that column, and
  // still owes a Raider.IO row.
  const runRows = await client.query<{
    id: string;
    root_id: string;
    completed_at: Date;
  }>(
    `SELECT run.id, root.id AS root_id, run.completed_at
     FROM discovery_runs run
     JOIN characters root ON root.region = run.root_region
       AND root.realm_slug = run.root_realm_slug
       AND root.normalized_name = run.root_normalized_name
     WHERE run.status = 'complete' AND run.completed_at IS NOT NULL`
  );
  const reservationRows = await client.query<{
    id: string;
    discovery_run_id: string;
    root_id: string;
    finished_at: Date;
  }>(
    `SELECT reservation.id, admission.discovery_run_id, root.id AS root_id,
            reservation.finished_at
     FROM fingerprint_sweep_reservations reservation
     JOIN fingerprint_sweep_admissions admission ON admission.id = reservation.admission_id
     JOIN discovery_runs run ON run.id = admission.discovery_run_id
     JOIN characters root ON root.region = run.root_region
       AND root.realm_slug = run.root_realm_slug
       AND root.normalized_name = run.root_normalized_name
     WHERE reservation.published AND reservation.finished_at IS NOT NULL`
  );

  const maintenanceRows = await client.query<{
    last_cycle_started_at: Date | null;
    last_cycle_completed_at: Date | null;
  }>(
    `SELECT last_cycle_started_at, last_cycle_completed_at
     FROM character_groups_maintenance WHERE id = 1`
  );

  const rootIds = new Set(
    rawMembershipRows.rows
      .map((row) => row.character_id)
      .filter((id) => !suppressed.has(id))
  );

  const graph: GroupGraph = {
    characters,
    idOf: (key) => idByCanonical.get(canonicalCharacterId(key)),
    groupOf,
    links,
    manual: manualRows.rows.map((row) => ({
      makerId: row.maker,
      targetId: row.target,
      excluded: row.excluded
    })),
    discoveredExclusions: exclusionRows.rows.map((row) => ({
      makerId: row.maker,
      targetId: row.target
    })),
    suppressed,
    warcraftLogsIds,
    sharedIdentity: (id) => {
      const wcl = warcraftLogsIds.get(id);
      return new Set([
        id,
        ...(wcl === undefined ? [] : (idsByWarcraftLogsId.get(wcl) ?? []))
      ]);
    },
    latestSnapshot
  };

  return {
    now,
    graph,
    groups,
    maintenance: {
      lastCycleStartedAt:
        maintenanceRows.rows[0]?.last_cycle_started_at ?? null,
      lastCycleCompletedAt:
        maintenanceRows.rows[0]?.last_cycle_completed_at ?? null
    },
    observations: observationRows.rows.map((row) => ({
      lowId: row.character_low_id,
      highId: row.character_high_id,
      source: row.source,
      observerId: row.observed_from_character_id,
      runId: row.discovery_run_id,
      observedAt: row.observed_at
    })),
    ledger: ledgerRows.rows.map((row) => ({
      runId: row.run_id,
      sweepReservationId: row.sweep_reservation_id,
      observerId: row.observer_character_id,
      family: row.family,
      decision: row.decision,
      reason: row.reason,
      runStartedAt: row.run_started_at,
      writtenAt: row.written_at
    })),
    publications: [
      ...runRows.rows.map((row) => ({
        kind: "run" as const,
        runId: row.id,
        observerId: row.root_id,
        at: row.completed_at
      })),
      ...reservationRows.rows.map((row) => ({
        kind: "reservation" as const,
        reservationId: row.id,
        runId: row.discovery_run_id,
        observerId: row.root_id,
        at: row.finished_at
      }))
    ],
    latestRawMembership,
    manualChangedAt: manualChanged.rows[0]?.changed_at ?? null,
    roots: [...rootIds]
      .map((id) => characters.get(id)?.key)
      .filter((key): key is CharacterKey => key !== undefined)
      .sort((left, right) =>
        canonicalCharacterId(left) < canonicalCharacterId(right) ? -1 : 1
      ),
    ungroupedSince: new Map(
      ungroupedRows.rows.map((row) => [row.id, row.created_at])
    )
  };
}
