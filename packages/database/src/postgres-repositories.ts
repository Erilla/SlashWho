import type { PublicErrorCode } from "@slashwho/contracts";
import type { CharacterKey } from "@slashwho/domain";
import type { Pool, PoolClient } from "pg";
import type {
  CallerClass,
  CharacterEvidenceRun,
  CharacterMythicKillParseMetric,
  CharacterMythicKillPerformance,
  CharacterMythicKillInput,
  CompletedCharacterEvidence,
  EvidenceReservationResult,
  CreateSnapshotInput,
  DiscoveryRun,
  FingerprintAdmission,
  Repositories,
  SnapshotHistoryItem,
  SnapshotHistoryPage,
  StoredCharacterMythicKill,
  StoredCharacterMythicWipe,
  StoredSnapshot,
  StoredSnapshotCharacter
} from "./repositories";

interface RunRow {
  id: string;
  root_region: CharacterKey["region"];
  root_realm_slug: string;
  root_normalized_name: string;
  root_character_id: string | null;
  queue_job_id: string | null;
  status: DiscoveryRun["status"];
  caller_class: CallerClass;
  attempt: number;
  next_retry_at: Date | null;
  error_code: PublicErrorCode | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  snapshot_id: string | null;
}

interface SnapshotRow {
  id: string;
  discovery_run_id: string;
  root_region: CharacterKey["region"];
  root_realm_slug: string;
  root_normalized_name: string;
  state: StoredSnapshot["state"];
  limitation_code: string | null;
  refreshed_at: Date;
  character_count: number;
}

interface SnapshotCharacterRow {
  character_id: string;
  region: CharacterKey["region"];
  realm_slug: string;
  normalized_name: string;
  display_name: string;
  class_name: string;
  level: number;
  raider_io_url: string;
  discovery_source: StoredSnapshotCharacter["source"];
  display_order: number;
}

interface EvidenceRunRow {
  id: string;
  region: CharacterKey["region"];
  realm_slug: string;
  normalized_name: string;
  queue_job_id: string | null;
  status: CharacterEvidenceRun["status"];
  evidence_version: number;
  attempt: number;
  limitation_code: string | null;
  parse_limitation_code: string | null;
  error_code: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface CharacterMythicKillRow {
  id: string;
  raid_id: string;
  raid_name: string;
  boss_id: string;
  boss_name: string;
  journal_boss_id: string | null;
  boss_order: number;
  is_final_boss: boolean;
  killed_at: Date;
  report_url: string;
  fight_url: string;
  guild_name: string | null;
  guild_realm: string | null;
  historic_world_rank: number | null;
  damage_parse_state: CharacterMythicKillParseMetric["state"];
  damage_percentile: number | null;
  healing_parse_state: CharacterMythicKillParseMetric["state"];
  healing_percentile: number | null;
  boss_damage_parse_state: CharacterMythicKillParseMetric["state"];
  boss_damage_percentile: number | null;
}

interface CharacterMythicWipeRow {
  id: string;
  raid_id: string;
  raid_name: string;
  boss_id: string;
  boss_name: string;
  journal_boss_id: string | null;
  boss_order: number;
  attempted_at: Date;
  report_url: string;
  fight_url: string;
}

type Queryable = Pick<Pool | PoolClient, "query">;

const activeRunSql = "('queued', 'running', 'retrying')";

async function lockRoot(client: Queryable, key: CharacterKey): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `root:${key.region}:${key.realm}:${key.name}`
  ]);
}

async function lockCharacterEvidence(
  client: Queryable,
  key: CharacterKey
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `character-evidence:${key.region}:${key.realm}:${key.name}`
  ]);
}

async function lockFingerprintSweeps(client: Queryable): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    "fingerprint-sweeps"
  ]);
}

function assertFingerprintAdmissionInput(input: {
  requestCap: number;
  hourlyBudget: number;
  cadenceCutoff: Date;
  at: Date;
}): void {
  if (!Number.isInteger(input.requestCap) || input.requestCap < 1) {
    throw new RangeError("fingerprint_request_cap_out_of_range");
  }
  if (!Number.isInteger(input.hourlyBudget) || input.hourlyBudget < 1) {
    throw new RangeError("fingerprint_hourly_budget_out_of_range");
  }
  if (input.requestCap > input.hourlyBudget) {
    throw new RangeError("fingerprint_request_cap_exceeds_hourly_budget");
  }
  if (
    Number.isNaN(input.cadenceCutoff.valueOf()) ||
    Number.isNaN(input.at.valueOf())
  ) {
    throw new RangeError("fingerprint_admission_time_invalid");
  }
}

async function fingerprintRetryAt(client: Queryable, at: Date): Promise<Date> {
  const result = await client.query<{ retry_at: Date | null }>(
    `SELECT min(retry_at) AS retry_at FROM (
       SELECT expires_at AS retry_at
       FROM fingerprint_sweep_reservations
       WHERE expires_at > $1 AND released_at IS NULL
       UNION ALL
       SELECT requested_at + interval '1 hour' AS retry_at
       FROM fingerprint_sweep_request_events
       WHERE requested_at + interval '1 hour' > $1
     ) retained`,
    [at]
  );
  return result.rows[0]?.retry_at ?? at;
}

async function admitFingerprintWaitingRun(
  client: Queryable,
  admissionId: string,
  at: Date
): Promise<Extract<FingerprintAdmission, { kind: "admitted" | "waiting" }>> {
  const head = await client.query<{
    id: string;
    request_cap: number;
    hourly_budget: number;
    requested_at: Date;
  }>(
    `SELECT admission.id, admission.request_cap, admission.hourly_budget, admission.requested_at
     FROM fingerprint_sweep_admissions admission
     LEFT JOIN fingerprint_sweep_states state
       ON state.region = admission.region
      AND state.realm_slug = admission.realm_slug
      AND state.normalized_name = admission.normalized_name
     WHERE admission.status = 'waiting'
       AND (
         state.last_published_at IS NULL
         OR state.last_published_at <= admission.cadence_cutoff
       )
     ORDER BY admission.requested_at, admission.queue_order
     LIMIT 1
     FOR UPDATE OF admission`
  );
  const candidate = head.rows[0];
  if (!candidate || candidate.id !== admissionId) {
    const requested = await client.query<{ requested_at: Date }>(
      `SELECT requested_at FROM fingerprint_sweep_admissions WHERE id = $1`,
      [admissionId]
    );
    return {
      kind: "waiting",
      retryAt: await fingerprintRetryAt(client, at),
      blockedSince: requested.rows[0]?.requested_at
    };
  }

  const usage = await client.query<{ commitment: string }>(
    `SELECT (
       SELECT count(*) FROM fingerprint_sweep_request_events
       WHERE requested_at > $1::timestamptz - interval '1 hour'
     ) + coalesce(sum(request_cap - used_count) FILTER (
       WHERE released_at IS NULL AND expires_at > $1
     ), 0)::bigint AS commitment
     FROM fingerprint_sweep_reservations`,
    [at]
  );
  if (
    Number(usage.rows[0]!.commitment) + candidate.request_cap >
    candidate.hourly_budget
  ) {
    return {
      kind: "waiting",
      retryAt: await fingerprintRetryAt(client, at),
      blockedSince: candidate.requested_at
    };
  }

  const reservation = await client.query<{ id: string }>(
    `INSERT INTO fingerprint_sweep_reservations
     (admission_id, request_cap, admitted_at, expires_at)
     VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '1 hour')
     RETURNING id`,
    [admissionId, candidate.request_cap, at]
  );
  await client.query(
    `UPDATE fingerprint_sweep_admissions
     SET status = 'admitted', dispatched_at = NULL
     WHERE id = $1`,
    [admissionId]
  );
  return {
    kind: "admitted",
    reservationId: reservation.rows[0]!.id,
    requestCap: candidate.request_cap,
    committedRequests:
      Number(usage.rows[0]!.commitment) + candidate.request_cap,
    hourlyBudget: candidate.hourly_budget
  };
}

function mapRun(row: RunRow): DiscoveryRun {
  return {
    id: row.id,
    rootKey: {
      region: row.root_region,
      realm: row.root_realm_slug,
      name: row.root_normalized_name
    },
    rootCharacterId: row.root_character_id,
    queueJobId: row.queue_job_id,
    status: row.status,
    callerClass: row.caller_class,
    attempt: row.attempt,
    nextRetryAt: row.next_retry_at,
    errorCode: row.error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    snapshotId: row.snapshot_id
  };
}

function mapEvidenceRun(row: EvidenceRunRow): CharacterEvidenceRun {
  return {
    id: row.id,
    key: {
      region: row.region,
      realm: row.realm_slug,
      name: row.normalized_name
    },
    queueJobId: row.queue_job_id,
    status: row.status,
    attempt: row.attempt,
    limitationCode: row.limitation_code,
    parseLimitationCode: row.parse_limitation_code,
    errorCode: row.error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function mapCharacterMythicKill(
  row: CharacterMythicKillRow
): StoredCharacterMythicKill {
  return {
    id: row.id,
    raidId: row.raid_id,
    raidName: row.raid_name,
    bossId: row.boss_id,
    bossName: row.boss_name,
    journalBossId: row.journal_boss_id,
    bossOrder: row.boss_order,
    isFinalBoss: row.is_final_boss,
    killedAt: row.killed_at.toISOString(),
    reportUrl: row.report_url,
    fightUrl: row.fight_url,
    guild:
      row.guild_name === null
        ? null
        : { name: row.guild_name, realm: row.guild_realm! },
    historicWorldRank: row.historic_world_rank,
    performance: {
      damage: mapParseMetric(row.damage_parse_state, row.damage_percentile),
      healing: mapParseMetric(row.healing_parse_state, row.healing_percentile),
      bossDamage: mapParseMetric(
        row.boss_damage_parse_state,
        row.boss_damage_percentile
      )
    }
  };
}

function mapParseMetric(
  state: CharacterMythicKillParseMetric["state"],
  percentile: number | null
): CharacterMythicKillParseMetric {
  if (
    state === "available" &&
    typeof percentile === "number" &&
    Number.isFinite(percentile) &&
    percentile >= 0 &&
    percentile <= 100
  ) {
    return { state, percentile };
  }
  if (
    (state === "not_applicable" || state === "unavailable") &&
    percentile === null
  ) {
    return { state };
  }
  throw new Error("character_mythic_kill_parse_invalid");
}

function parseMetricValues(metric: unknown): {
  state: CharacterMythicKillParseMetric["state"];
  percentile: number | null;
} {
  if (typeof metric !== "object" || metric === null) {
    throw new RangeError("character_mythic_kill_parse_invalid");
  }
  const candidate = metric as { state?: unknown; percentile?: unknown };
  if (
    candidate.state === "available" &&
    typeof candidate.percentile === "number" &&
    Number.isFinite(candidate.percentile) &&
    candidate.percentile >= 0 &&
    candidate.percentile <= 100
  ) {
    return { state: candidate.state, percentile: candidate.percentile };
  }
  if (
    (candidate.state === "not_applicable" ||
      candidate.state === "unavailable") &&
    candidate.percentile === undefined
  ) {
    return { state: candidate.state, percentile: null };
  }
  throw new RangeError("character_mythic_kill_parse_invalid");
}

function parsePerformanceValues(performance: unknown): {
  damage: ReturnType<typeof parseMetricValues>;
  healing: ReturnType<typeof parseMetricValues>;
  bossDamage: ReturnType<typeof parseMetricValues>;
} {
  if (typeof performance !== "object" || performance === null) {
    throw new RangeError("character_mythic_kill_performance_invalid");
  }
  const candidate = performance as Partial<CharacterMythicKillPerformance>;
  return {
    damage: parseMetricValues(candidate.damage),
    healing: parseMetricValues(candidate.healing),
    bossDamage: parseMetricValues(candidate.bossDamage)
  };
}

function mapCharacterMythicWipe(
  row: CharacterMythicWipeRow
): StoredCharacterMythicWipe {
  return {
    id: row.id,
    raidId: row.raid_id,
    raidName: row.raid_name,
    bossId: row.boss_id,
    bossName: row.boss_name,
    journalBossId: row.journal_boss_id,
    bossOrder: row.boss_order,
    attemptedAt: row.attempted_at.toISOString(),
    reportUrl: row.report_url,
    fightUrl: row.fight_url
  };
}

async function loadCompletedEvidence(
  client: Queryable,
  key: CharacterKey
): Promise<CompletedCharacterEvidence | null> {
  const runResult = await client.query<EvidenceRunRow>(
    `SELECT id, region, realm_slug, normalized_name, queue_job_id, status,
            evidence_version, attempt, limitation_code, parse_limitation_code,
            error_code, created_at, started_at,
            completed_at
     FROM character_evidence_runs
     WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
       AND status IN ('complete', 'partial')
     ORDER BY completed_at DESC, id DESC
     LIMIT 1`,
    [key.region, key.realm, key.name]
  );
  const run = runResult.rows[0];
  if (!run) return null;

  const killsResult = await client.query<CharacterMythicKillRow>(
    `SELECT id, raid_id, raid_name, boss_id, boss_name, journal_boss_id,
            boss_order, is_final_boss, killed_at, report_url, fight_url,
            guild_name, guild_realm, historic_world_rank, damage_parse_state,
            damage_percentile, healing_parse_state, healing_percentile,
            boss_damage_parse_state, boss_damage_percentile
     FROM character_mythic_kills
     WHERE evidence_run_id = $1
     ORDER BY killed_at, source_fight_key`,
    [run.id]
  );
  const wipesResult = await client.query<CharacterMythicWipeRow>(
    `SELECT id, raid_id, raid_name, boss_id, boss_name, journal_boss_id,
            boss_order, attempted_at, report_url, fight_url
     FROM character_mythic_wipes
     WHERE evidence_run_id = $1
     ORDER BY raid_id, boss_order, attempted_at DESC, fight_url`,
    [run.id]
  );
  return {
    run: mapEvidenceRun(run),
    kills: killsResult.rows.map(mapCharacterMythicKill),
    wipes: wipesResult.rows.map(mapCharacterMythicWipe),
    wipeCapable: run.evidence_version >= 2
  };
}

async function loadPositiveEvidenceForPartial(
  client: Queryable,
  key: CharacterKey
): Promise<{
  kills: readonly StoredCharacterMythicKill[];
  wipes: readonly StoredCharacterMythicWipe[];
}> {
  const runs = await client.query<Pick<EvidenceRunRow, "id" | "status">>(
    `SELECT id, status
     FROM character_evidence_runs
     WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
       AND status IN ('complete', 'partial')
     ORDER BY completed_at DESC, id DESC`,
    [key.region, key.realm, key.name]
  );
  const baselineIndex = runs.rows.findIndex((run) => run.status === "complete");
  const relevantRuns =
    baselineIndex === -1 ? runs.rows : runs.rows.slice(0, baselineIndex + 1);
  const runIds = relevantRuns.map((run) => run.id);
  if (runIds.length === 0) return { kills: [], wipes: [] };
  const kills = await client.query<CharacterMythicKillRow>(
    `SELECT id, raid_id, raid_name, boss_id, boss_name, journal_boss_id,
            boss_order, is_final_boss, killed_at, report_url, fight_url,
            guild_name, guild_realm, historic_world_rank,
            damage_parse_state, damage_percentile, healing_parse_state,
            healing_percentile, boss_damage_parse_state, boss_damage_percentile
     FROM character_mythic_kills
     WHERE evidence_run_id = ANY($1::uuid[])
     ORDER BY killed_at, source_fight_key`,
    [runIds]
  );
  const wipes = await client.query<CharacterMythicWipeRow>(
    `SELECT id, raid_id, raid_name, boss_id, boss_name, journal_boss_id,
            boss_order, attempted_at, report_url, fight_url
     FROM character_mythic_wipes
     WHERE evidence_run_id = ANY($1::uuid[])
     ORDER BY raid_id, boss_order, attempted_at DESC, fight_url`,
    [runIds]
  );
  return {
    kills: kills.rows.map(mapCharacterMythicKill),
    wipes: wipes.rows.map(mapCharacterMythicWipe)
  };
}

function encodeCursor(item: SnapshotHistoryItem): string {
  return Buffer.from(
    JSON.stringify({ refreshedAt: item.refreshedAt.toISOString(), id: item.id })
  ).toString("base64url");
}

function decodeCursor(cursor: string): { refreshedAt: Date; id: string } {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    ) as {
      refreshedAt?: unknown;
      id?: unknown;
    };
    const refreshedAt = new Date(String(value.refreshedAt));
    if (
      typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value.id
      ) ||
      Number.isNaN(refreshedAt.valueOf())
    ) {
      throw new Error("invalid_cursor");
    }
    return { refreshedAt, id: value.id };
  } catch {
    throw new Error("invalid_cursor");
  }
}

async function loadSnapshot(
  client: Queryable,
  id: string
): Promise<StoredSnapshot | null> {
  const snapshotResult = await client.query<SnapshotRow>(
    `SELECT
      s.id,
      s.discovery_run_id,
      root.region AS root_region,
      root.realm_slug AS root_realm_slug,
      root.normalized_name AS root_normalized_name,
      s.state,
      s.limitation_code,
      s.refreshed_at,
      s.character_count
    FROM snapshots s
    JOIN characters root ON root.id = s.root_character_id
    WHERE s.id = $1
      AND NOT EXISTS (
        SELECT 1
        FROM suppressed_characters suppression
        WHERE suppression.region = root.region
          AND suppression.realm_slug = root.realm_slug
          AND suppression.normalized_name = root.normalized_name
          AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
      )`,
    [id]
  );
  const row = snapshotResult.rows[0];
  if (!row) return null;

  const characterResult = await client.query<SnapshotCharacterRow>(
    `SELECT
      membership.character_id,
      character.region,
      character.realm_slug,
      character.normalized_name,
      membership.display_name,
      membership.class_name,
      membership.level,
      membership.raider_io_url,
      membership.discovery_source,
      membership.display_order
    FROM snapshot_characters membership
    JOIN characters character ON character.id = membership.character_id
    WHERE membership.snapshot_id = $1
      AND NOT EXISTS (
        SELECT 1
        FROM suppressed_characters suppression
        WHERE suppression.region = character.region
          AND suppression.realm_slug = character.realm_slug
          AND suppression.normalized_name = character.normalized_name
          AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
      )
    ORDER BY membership.display_order`,
    [id]
  );
  const characters: StoredSnapshotCharacter[] = characterResult.rows.map(
    (character) => ({
      characterId: character.character_id,
      key: {
        region: character.region,
        realm: character.realm_slug,
        name: character.normalized_name
      },
      displayName: character.display_name,
      className: character.class_name,
      level: character.level,
      raiderIoUrl: character.raider_io_url,
      source: character.discovery_source,
      displayOrder: character.display_order
    })
  );

  return {
    id: row.id,
    runId: row.discovery_run_id,
    rootKey: {
      region: row.root_region,
      realm: row.root_realm_slug,
      name: row.root_normalized_name
    },
    state: row.state,
    limitationCode: row.limitation_code,
    refreshedAt: row.refreshed_at,
    characterCount: characters.length,
    characters
  };
}

async function createSnapshot(
  client: PoolClient,
  input: CreateSnapshotInput,
  options?: { signal?: AbortSignal }
): Promise<StoredSnapshot> {
  const runResult = await client.query(
    `SELECT 1 FROM discovery_runs
     WHERE id = $1
       AND root_region = $2
       AND root_realm_slug = $3
       AND root_normalized_name = $4
       AND status IN ${activeRunSql}
     FOR UPDATE`,
    [input.runId, input.rootKey.region, input.rootKey.realm, input.rootKey.name]
  );
  if (runResult.rowCount !== 1) {
    throw new Error("discovery_run_root_mismatch");
  }

  const characterIds = new Map<string, string>();
  const charactersByCanonicalKey = [...input.characters].sort((left, right) => {
    const leftKey = `${left.key.region}\0${left.key.realm}\0${left.key.name}`;
    const rightKey = `${right.key.region}\0${right.key.realm}\0${right.key.name}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  for (const character of charactersByCanonicalKey) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO characters
        (region, realm_slug, normalized_name, display_name, class_name,
         level, raider_io_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (region, realm_slug, normalized_name)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         class_name = EXCLUDED.class_name,
         level = EXCLUDED.level,
         raider_io_url = EXCLUDED.raider_io_url,
         updated_at = now()
       RETURNING id`,
      [
        character.key.region,
        character.key.realm,
        character.key.name,
        character.displayName,
        character.className,
        character.level,
        character.raiderIoUrl
      ]
    );
    characterIds.set(
      `${character.key.region}/${character.key.realm}/${character.key.name}`,
      result.rows[0]!.id
    );
  }

  const rootId = characterIds.get(
    `${input.rootKey.region}/${input.rootKey.realm}/${input.rootKey.name}`
  );
  if (!rootId) throw new Error("snapshot_root_missing");

  const snapshotResult = await client.query<{ id: string }>(
    `INSERT INTO snapshots
      (root_character_id, discovery_run_id, state, limitation_code,
       refreshed_at, character_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      rootId,
      input.runId,
      input.state,
      input.limitationCode,
      input.refreshedAt,
      input.characters.length
    ]
  );
  const snapshotId = snapshotResult.rows[0]!.id;

  await client.query(
    `UPDATE discovery_runs SET root_character_id = $2 WHERE id = $1`,
    [input.runId, rootId]
  );

  for (const [displayOrder, character] of input.characters.entries()) {
    const characterId = characterIds.get(
      `${character.key.region}/${character.key.realm}/${character.key.name}`
    )!;
    await client.query(
      `INSERT INTO snapshot_characters
        (snapshot_id, character_id, display_order, discovery_source,
         display_name, class_name, level, raider_io_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        snapshotId,
        characterId,
        displayOrder,
        character.source,
        character.displayName,
        character.className,
        character.level,
        character.raiderIoUrl
      ]
    );
  }

  const publication = await client.query(
    `UPDATE discovery_runs
     SET status = 'complete', snapshot_id = $2,
         completed_at = COALESCE(completed_at, now()),
         next_retry_at = NULL, error_code = NULL
     WHERE id = $1 AND status IN ${activeRunSql}`,
    [input.runId, snapshotId]
  );
  if (publication.rowCount !== 1) {
    throw new Error("discovery_run_not_active");
  }

  const snapshot = await loadSnapshot(client, snapshotId);
  if (!snapshot) throw new Error("snapshot_not_found");
  options?.signal?.throwIfAborted();
  return snapshot;
}

async function finishFingerprintSweep(
  client: PoolClient,
  reservationId: string,
  input: { published: boolean; at: Date; limitationCode: string | null }
): Promise<void> {
  const reservation = await client.query<{
    admission_id: string;
    region: CharacterKey["region"];
    realm_slug: string;
    normalized_name: string;
  }>(
    `UPDATE fingerprint_sweep_reservations reservation
     SET released_at = $2,
         finished_at = $2,
         published = $3,
         limitation_code = $4
     FROM fingerprint_sweep_admissions admission
     WHERE reservation.id = $1
       AND reservation.admission_id = admission.id
       AND reservation.released_at IS NULL
     RETURNING reservation.admission_id, admission.region,
               admission.realm_slug, admission.normalized_name`,
    [reservationId, input.at, input.published, input.limitationCode]
  );
  const row = reservation.rows[0];
  if (!row) throw new Error("fingerprint_reservation_not_active");
  await client.query(
    `UPDATE fingerprint_sweep_admissions
     SET status = 'finished'
     WHERE id = $1`,
    [row.admission_id]
  );
  if (input.published) {
    await client.query(
      `INSERT INTO fingerprint_sweep_states
        (region, realm_slug, normalized_name, last_published_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (region, realm_slug, normalized_name)
       DO UPDATE SET last_published_at = greatest(
         fingerprint_sweep_states.last_published_at,
         EXCLUDED.last_published_at
       )`,
      [row.region, row.realm_slug, row.normalized_name, input.at]
    );
  }
}

async function requireUpdated(
  client: Pool,
  text: string,
  values: unknown[]
): Promise<void> {
  const result = await client.query(text, values);
  if (result.rowCount !== 1) throw new Error("discovery_run_not_found");
}

export function createPostgresRepositories(pool: Pool): Repositories {
  return {
    searchReservations: {
      async reserve(input) {
        if (!Number.isInteger(input.limit) || input.limit < 1) {
          throw new RangeError("rate_limit_out_of_range");
        }
        if (input.expiresAt <= input.at) {
          throw new RangeError("rate_limit_expiry_out_of_range");
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const rootLock = `root:${input.key.region}:${input.key.realm}:${input.key.name}`;
          await client.query(
            `SELECT pg_advisory_xact_lock(lock_id)
             FROM (
               SELECT DISTINCT hashtextextended(value, 0) AS lock_id
               FROM unnest($1::text[]) AS value
               ORDER BY lock_id
             ) locks`,
            [[`bucket:${input.callerBucketHash}`, rootLock]]
          );

          const suppression = await client.query(
            `SELECT 1 FROM suppressed_characters
             WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
               AND (expires_at IS NULL OR expires_at > $4)
             LIMIT 1`,
            [input.key.region, input.key.realm, input.key.name, input.at]
          );
          if (suppression.rowCount === 1) {
            await client.query("COMMIT");
            return { kind: "suppressed" };
          }

          const current = await client.query<{ id: string }>(
            `SELECT snapshot.id
             FROM snapshots snapshot
             JOIN characters root ON root.id = snapshot.root_character_id
             JOIN discovery_runs run ON run.id = snapshot.discovery_run_id
             WHERE root.region = $1 AND root.realm_slug = $2
               AND root.normalized_name = $3
               AND run.status = 'complete'
               AND snapshot.refreshed_at > $4
             ORDER BY snapshot.refreshed_at DESC, snapshot.id DESC
             LIMIT 1`,
            [
              input.key.region,
              input.key.realm,
              input.key.name,
              input.freshnessCutoff
            ]
          );
          if (current.rowCount === 1) {
            await client.query("COMMIT");
            return { kind: "fresh" };
          }

          if (current.rowCount === 0) {
            const negative = await client.query(
              `SELECT 1 FROM negative_character_cache
               WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                 AND expires_at > $4
               LIMIT 1`,
              [input.key.region, input.key.realm, input.key.name, input.at]
            );
            if (negative.rowCount === 1) {
              await client.query("COMMIT");
              return { kind: "negative" };
            }
          }

          const active = await client.query<RunRow>(
            `SELECT * FROM discovery_runs
             WHERE root_region = $1
               AND root_realm_slug = $2
               AND root_normalized_name = $3
               AND status IN ${activeRunSql}
             FOR UPDATE`,
            [input.key.region, input.key.realm, input.key.name]
          );
          if (active.rows[0]) {
            await client.query("COMMIT");
            return { kind: "active", run: mapRun(active.rows[0]) };
          }

          const usage = await client.query<{
            count: string;
            retry_at: Date | null;
          }>(
            `SELECT count(*)::text AS count, min(expires_at) AS retry_at
             FROM rate_limit_events
             WHERE caller_bucket_hash = $1 AND expires_at > $2`,
            [input.callerBucketHash, input.at]
          );
          if (Number(usage.rows[0]!.count) >= input.limit) {
            const retryAt = usage.rows[0]!.retry_at;
            if (!retryAt) throw new Error("rate_limit_retry_missing");
            await client.query("COMMIT");
            return { kind: "rate_limited", retryAt };
          }

          const runResult = await client.query<RunRow>(
            `INSERT INTO discovery_runs
              (root_region, root_realm_slug, root_normalized_name, caller_class)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [
              input.key.region,
              input.key.realm,
              input.key.name,
              input.callerClass
            ]
          );
          const run = mapRun(runResult.rows[0]!);
          await client.query(
            `INSERT INTO rate_limit_events
              (caller_bucket_hash, discovery_run_id, expires_at)
             VALUES ($1, $2, $3)`,
            [input.callerBucketHash, run.id, input.expiresAt]
          );
          await client.query("COMMIT");
          return { kind: "reserved", run };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async cancel(runId) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const failure = await client.query(
            `UPDATE discovery_runs
             SET status = 'failed', error_code = 'search_failed',
                 completed_at = now(), next_retry_at = NULL
             WHERE id = $1 AND status = 'queued'
             RETURNING id`,
            [runId]
          );
          if (failure.rowCount !== 1) {
            throw new Error("search_reservation_not_cancellable");
          }
          const charge = await client.query(
            "DELETE FROM rate_limit_events WHERE discovery_run_id = $1",
            [runId]
          );
          if (charge.rowCount !== 1) {
            throw new Error("search_reservation_charge_missing");
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async listPending(limit = 100) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
          throw new RangeError("pending_dispatch_limit_out_of_range");
        }
        const result = await pool.query<{
          id: string;
          root_region: CharacterKey["region"];
          root_realm_slug: string;
          root_normalized_name: string;
        }>(
          `SELECT id, root_region, root_realm_slug, root_normalized_name
           FROM discovery_runs
           WHERE status = 'queued' AND queue_job_id IS NULL
           ORDER BY created_at, id
           LIMIT $1`,
          [limit]
        );
        return result.rows.map((row) => ({
          runId: row.id,
          key: {
            region: row.root_region,
            realm: row.root_realm_slug,
            name: row.root_normalized_name
          }
        }));
      },

      async markEnqueued(runId, queueJobId) {
        const result = await pool.query(
          `UPDATE discovery_runs
           SET queue_job_id = $2
           WHERE id = $1
             AND (queue_job_id IS NULL OR queue_job_id = $2)`,
          [runId, queueJobId]
        );
        if (result.rowCount !== 1) {
          throw new Error("search_reservation_not_found");
        }
      }
    },

    runs: {
      async createOrReuse(key, caller) {
        const result = await pool.query<RunRow>(
          `INSERT INTO discovery_runs
            (root_region, root_realm_slug, root_normalized_name, caller_class)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (root_region, root_realm_slug, root_normalized_name)
             WHERE status IN ${activeRunSql}
           DO UPDATE SET root_normalized_name = EXCLUDED.root_normalized_name
           RETURNING *`,
          [key.region, key.realm, key.name, caller]
        );
        return mapRun(result.rows[0]!);
      },

      async claim(id, attempt) {
        const result = await pool.query<RunRow>(
          `UPDATE discovery_runs
           SET status = 'running', attempt = $2,
               started_at = COALESCE(started_at, now()),
               next_retry_at = NULL
           WHERE id = $1
             AND attempt < $2
             AND status IN ${activeRunSql}
           RETURNING *`,
          [id, attempt]
        );
        return result.rows[0] ? mapRun(result.rows[0]) : null;
      },

      async markRunning(id) {
        await requireUpdated(
          pool,
          `UPDATE discovery_runs
           SET status = 'running', started_at = COALESCE(started_at, now()),
               next_retry_at = NULL
           WHERE id = $1 AND status IN ${activeRunSql}`,
          [id]
        );
      },

      async markRetrying(id, attempt, nextRetryAt) {
        await requireUpdated(
          pool,
          `UPDATE discovery_runs
           SET status = 'retrying', attempt = $2, next_retry_at = $3
           WHERE id = $1 AND status IN ${activeRunSql}`,
          [id, attempt, nextRetryAt]
        );
      },

      async complete(id, snapshotId) {
        await requireUpdated(
          pool,
          `UPDATE discovery_runs
           SET status = 'complete', snapshot_id = $2,
               completed_at = COALESCE(completed_at, now()),
               next_retry_at = NULL, error_code = NULL
           WHERE id = $1
             AND (
               (status = 'complete' AND snapshot_id = $2)
               OR (
                 status IN ${activeRunSql}
                 AND EXISTS (
                   SELECT 1 FROM snapshots
                   WHERE snapshots.id = $2
                     AND snapshots.discovery_run_id = discovery_runs.id
                 )
               )
             )`,
          [id, snapshotId]
        );
      },

      async fail(id, code) {
        await requireUpdated(
          pool,
          `UPDATE discovery_runs
           SET status = 'failed', error_code = $2, completed_at = now(),
               next_retry_at = NULL
           WHERE id = $1 AND status IN ${activeRunSql}`,
          [id, code]
        );
      },

      async find(id) {
        const result = await pool.query<RunRow>(
          "SELECT * FROM discovery_runs WHERE id = $1",
          [id]
        );
        return result.rows[0] ? mapRun(result.rows[0]) : null;
      },

      async findActive(key) {
        const result = await pool.query<RunRow>(
          `SELECT * FROM discovery_runs
           WHERE root_region = $1
             AND root_realm_slug = $2
             AND root_normalized_name = $3
             AND status IN ${activeRunSql}`,
          [key.region, key.realm, key.name]
        );
        return result.rows[0] ? mapRun(result.rows[0]) : null;
      }
    },

    snapshots: {
      async create(input, options) {
        const client = await pool.connect();
        try {
          options?.signal?.throwIfAborted();
          await client.query("BEGIN");
          await lockRoot(client, input.rootKey);
          const runResult = await client.query(
            `SELECT 1 FROM discovery_runs
             WHERE id = $1
               AND root_region = $2
               AND root_realm_slug = $3
               AND root_normalized_name = $4
               AND status IN ${activeRunSql}
             FOR UPDATE`,
            [
              input.runId,
              input.rootKey.region,
              input.rootKey.realm,
              input.rootKey.name
            ]
          );
          if (runResult.rowCount !== 1) {
            throw new Error("discovery_run_root_mismatch");
          }

          const characterIds = new Map<string, string>();
          const charactersByCanonicalKey = [...input.characters].sort(
            (left, right) => {
              const leftKey = `${left.key.region}\0${left.key.realm}\0${left.key.name}`;
              const rightKey = `${right.key.region}\0${right.key.realm}\0${right.key.name}`;
              return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
            }
          );
          for (const character of charactersByCanonicalKey) {
            const result = await client.query<{ id: string }>(
              `INSERT INTO characters
                (region, realm_slug, normalized_name, display_name, class_name,
                 level, raider_io_url)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (region, realm_slug, normalized_name)
               DO UPDATE SET
                 display_name = EXCLUDED.display_name,
                 class_name = EXCLUDED.class_name,
                 level = EXCLUDED.level,
                 raider_io_url = EXCLUDED.raider_io_url,
                 updated_at = now()
               RETURNING id`,
              [
                character.key.region,
                character.key.realm,
                character.key.name,
                character.displayName,
                character.className,
                character.level,
                character.raiderIoUrl
              ]
            );
            characterIds.set(
              `${character.key.region}/${character.key.realm}/${character.key.name}`,
              result.rows[0]!.id
            );
          }

          const rootId = characterIds.get(
            `${input.rootKey.region}/${input.rootKey.realm}/${input.rootKey.name}`
          );
          if (!rootId) throw new Error("snapshot_root_missing");

          const snapshotResult = await client.query<{ id: string }>(
            `INSERT INTO snapshots
              (root_character_id, discovery_run_id, state, limitation_code,
               refreshed_at, character_count)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [
              rootId,
              input.runId,
              input.state,
              input.limitationCode,
              input.refreshedAt,
              input.characters.length
            ]
          );
          const snapshotId = snapshotResult.rows[0]!.id;

          await client.query(
            `UPDATE discovery_runs SET root_character_id = $2 WHERE id = $1`,
            [input.runId, rootId]
          );

          for (const [displayOrder, character] of input.characters.entries()) {
            const characterId = characterIds.get(
              `${character.key.region}/${character.key.realm}/${character.key.name}`
            )!;
            await client.query(
              `INSERT INTO snapshot_characters
                (snapshot_id, character_id, display_order, discovery_source,
                 display_name, class_name, level, raider_io_url)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                snapshotId,
                characterId,
                displayOrder,
                character.source,
                character.displayName,
                character.className,
                character.level,
                character.raiderIoUrl
              ]
            );
          }

          const publication = await client.query(
            `UPDATE discovery_runs
             SET status = 'complete', snapshot_id = $2,
                 completed_at = COALESCE(completed_at, now()),
                 next_retry_at = NULL, error_code = NULL
             WHERE id = $1 AND status IN ${activeRunSql}`,
            [input.runId, snapshotId]
          );
          if (publication.rowCount !== 1) {
            throw new Error("discovery_run_not_active");
          }

          const snapshot = await loadSnapshot(client, snapshotId);
          if (!snapshot) throw new Error("snapshot_not_found");
          options?.signal?.throwIfAborted();
          await client.query("COMMIT");
          return snapshot;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async createAndFinishFingerprintSweep(input, fingerprint, options) {
        if (Number.isNaN(fingerprint.finishedAt.valueOf())) {
          throw new RangeError("fingerprint_finish_time_invalid");
        }
        const client = await pool.connect();
        try {
          options?.signal?.throwIfAborted();
          await client.query("BEGIN");
          await lockRoot(client, input.rootKey);
          await lockFingerprintSweeps(client);
          const snapshot = await createSnapshot(client, input, options);
          await finishFingerprintSweep(client, fingerprint.reservationId, {
            published: true,
            at: fingerprint.finishedAt,
            limitationCode: fingerprint.limitationCode
          });
          options?.signal?.throwIfAborted();
          await client.query("COMMIT");
          return snapshot;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async getCurrent(key) {
        const result = await pool.query<{ id: string }>(
          `SELECT snapshot.id
           FROM snapshots snapshot
           JOIN characters root ON root.id = snapshot.root_character_id
           JOIN discovery_runs run ON run.id = snapshot.discovery_run_id
           WHERE root.region = $1
             AND root.realm_slug = $2
             AND root.normalized_name = $3
             AND run.status = 'complete'
             AND NOT EXISTS (
               SELECT 1 FROM suppressed_characters suppression
               WHERE suppression.region = root.region
                 AND suppression.realm_slug = root.realm_slug
                 AND suppression.normalized_name = root.normalized_name
                 AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
             )
           ORDER BY snapshot.refreshed_at DESC, snapshot.id DESC
           LIMIT 1`,
          [key.region, key.realm, key.name]
        );
        return result.rows[0] ? loadSnapshot(pool, result.rows[0].id) : null;
      },

      async find(id) {
        return loadSnapshot(pool, id);
      },

      async listHistory(key, page): Promise<SnapshotHistoryPage> {
        if (
          !Number.isInteger(page.limit) ||
          page.limit < 1 ||
          page.limit > 100
        ) {
          throw new RangeError("history_limit_out_of_range");
        }
        const cursor = page.cursor ? decodeCursor(page.cursor) : null;
        const values: unknown[] = [key.region, key.realm, key.name];
        let cursorClause = "";
        if (cursor) {
          values.push(cursor.refreshedAt, cursor.id);
          cursorClause =
            "AND (snapshot.refreshed_at, snapshot.id) < ($4::timestamptz, $5::uuid)";
        }
        values.push(page.limit + 1);
        const limitParameter = `$${values.length}`;
        const result = await pool.query<{
          id: string;
          refreshed_at: Date;
          state: SnapshotHistoryItem["state"];
          character_count: string;
        }>(
          `SELECT
             snapshot.id,
             snapshot.refreshed_at,
             snapshot.state,
             (
               SELECT count(*)
               FROM snapshot_characters membership
               JOIN characters member ON member.id = membership.character_id
               WHERE membership.snapshot_id = snapshot.id
                 AND NOT EXISTS (
                   SELECT 1 FROM suppressed_characters member_suppression
                   WHERE member_suppression.region = member.region
                     AND member_suppression.realm_slug = member.realm_slug
                     AND member_suppression.normalized_name = member.normalized_name
                     AND (member_suppression.expires_at IS NULL OR member_suppression.expires_at > now())
                 )
             ) AS character_count
           FROM snapshots snapshot
           JOIN characters root ON root.id = snapshot.root_character_id
           JOIN discovery_runs run ON run.id = snapshot.discovery_run_id
           WHERE root.region = $1
             AND root.realm_slug = $2
             AND root.normalized_name = $3
             AND run.status = 'complete'
             AND NOT EXISTS (
               SELECT 1 FROM suppressed_characters root_suppression
               WHERE root_suppression.region = root.region
                 AND root_suppression.realm_slug = root.realm_slug
                 AND root_suppression.normalized_name = root.normalized_name
                 AND (root_suppression.expires_at IS NULL OR root_suppression.expires_at > now())
             )
             ${cursorClause}
           ORDER BY snapshot.refreshed_at DESC, snapshot.id DESC
           LIMIT ${limitParameter}`,
          values
        );
        const hasMore = result.rows.length > page.limit;
        const items = result.rows.slice(0, page.limit).map((row) => ({
          id: row.id,
          refreshedAt: row.refreshed_at,
          state: row.state,
          characterCount: Number(row.character_count)
        }));
        return {
          items,
          nextCursor: hasMore ? encodeCursor(items.at(-1)!) : null
        };
      }
    },

    suppressions: {
      async suppress(key, reason, expiresAt) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockRoot(client, key);
          await client.query(
            `INSERT INTO suppressed_characters
              (region, realm_slug, normalized_name, reason, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (region, realm_slug, normalized_name)
             DO UPDATE SET
               suppressed_at = now(),
               reason = EXCLUDED.reason,
               expires_at = EXCLUDED.expires_at`,
            [key.region, key.realm, key.name, reason, expiresAt]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async isActive(key, at = new Date()) {
        const result = await pool.query(
          `SELECT 1 FROM suppressed_characters
           WHERE region = $1
             AND realm_slug = $2
             AND normalized_name = $3
             AND (expires_at IS NULL OR expires_at > $4)
           LIMIT 1`,
          [key.region, key.realm, key.name, at]
        );
        return result.rowCount === 1;
      },

      async cleanupExpired(at = new Date()) {
        const result = await pool.query(
          `DELETE FROM suppressed_characters
           WHERE expires_at IS NOT NULL AND expires_at <= $1`,
          [at]
        );
        return result.rowCount ?? 0;
      }
    },

    rateLimits: {
      async reserve(callerBucketHash, limit, expiresAt, at = new Date()) {
        if (!Number.isInteger(limit) || limit < 1) {
          throw new RangeError("rate_limit_out_of_range");
        }
        if (expiresAt <= at) {
          throw new RangeError("rate_limit_expiry_out_of_range");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
            [callerBucketHash]
          );
          const usage = await client.query<{
            count: string;
            retry_at: Date | null;
          }>(
            `SELECT count(*)::text AS count, min(expires_at) AS retry_at
             FROM rate_limit_events
             WHERE caller_bucket_hash = $1 AND expires_at > $2`,
            [callerBucketHash, at]
          );
          if (Number(usage.rows[0]!.count) >= limit) {
            await client.query("COMMIT");
            return {
              allowed: false,
              retryAt: usage.rows[0]!.retry_at
            };
          }
          await client.query(
            `INSERT INTO rate_limit_events (caller_bucket_hash, expires_at)
             VALUES ($1, $2)`,
            [callerBucketHash, expiresAt]
          );
          await client.query("COMMIT");
          return { allowed: true, retryAt: null };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async record(callerBucketHash, expiresAt) {
        await pool.query(
          `INSERT INTO rate_limit_events (caller_bucket_hash, expires_at)
           VALUES ($1, $2)`,
          [callerBucketHash, expiresAt]
        );
      },

      async countActive(callerBucketHash, at = new Date()) {
        const result = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM rate_limit_events
           WHERE caller_bucket_hash = $1 AND expires_at > $2`,
          [callerBucketHash, at]
        );
        return Number(result.rows[0]!.count);
      },

      async cleanupExpired(at = new Date()) {
        const result = await pool.query(
          "DELETE FROM rate_limit_events WHERE expires_at <= $1",
          [at]
        );
        return result.rowCount ?? 0;
      }
    },

    fingerprintSweeps: {
      async requestAdmission(input): Promise<FingerprintAdmission> {
        assertFingerprintAdmissionInput(input);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockFingerprintSweeps(client);

          const existingAdmission = await client.query<{
            reservation_id: string;
            request_cap: number;
          }>(
            `SELECT reservation.id AS reservation_id, reservation.request_cap
             FROM fingerprint_sweep_admissions admission
             JOIN fingerprint_sweep_reservations reservation
               ON reservation.admission_id = admission.id
             WHERE admission.discovery_run_id = $1
               AND admission.status = 'admitted'
               AND reservation.released_at IS NULL
             ORDER BY admission.requested_at DESC
             LIMIT 1
             FOR UPDATE OF admission, reservation`,
            [input.runId]
          );
          const existing = existingAdmission.rows[0];
          if (existing) {
            await client.query("COMMIT");
            return {
              kind: "admitted",
              reservationId: existing.reservation_id,
              requestCap: existing.request_cap
            };
          }

          const state = await client.query<{ last_published_at: Date | null }>(
            `SELECT last_published_at
             FROM fingerprint_sweep_states
             WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
            [input.key.region, input.key.realm, input.key.name]
          );
          if (
            state.rows[0]?.last_published_at &&
            state.rows[0].last_published_at > input.cadenceCutoff
          ) {
            await client.query(
              `UPDATE fingerprint_sweep_admissions
               SET status = 'not_due'
               WHERE discovery_run_id = $1 AND status = 'waiting'`,
              [input.runId]
            );
            await client.query("COMMIT");
            return { kind: "not_due" };
          }

          const waiting = await client.query<{ id: string }>(
            `SELECT id
             FROM fingerprint_sweep_admissions
             WHERE discovery_run_id = $1 AND status = 'waiting'
             ORDER BY requested_at, queue_order
             LIMIT 1
             FOR UPDATE`,
            [input.runId]
          );
          let admissionId = waiting.rows[0]?.id;
          if (admissionId) {
            await client.query(
              `UPDATE fingerprint_sweep_admissions
               SET request_cap = $2, hourly_budget = $3, cadence_cutoff = $4
               WHERE id = $1`,
              [
                admissionId,
                input.requestCap,
                input.hourlyBudget,
                input.cadenceCutoff
              ]
            );
          } else {
            const admission = await client.query<{ id: string }>(
              `INSERT INTO fingerprint_sweep_admissions
                (discovery_run_id, region, realm_slug, normalized_name, request_cap,
                 hourly_budget, cadence_cutoff, requested_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               RETURNING id`,
              [
                input.runId,
                input.key.region,
                input.key.realm,
                input.key.name,
                input.requestCap,
                input.hourlyBudget,
                input.cadenceCutoff,
                input.at
              ]
            );
            admissionId = admission.rows[0]!.id;
          }

          const result = await admitFingerprintWaitingRun(
            client,
            admissionId,
            input.at
          );
          if (result.kind === "waiting") {
            const deferred = await client.query(
              `UPDATE discovery_runs
               SET status = 'queued', attempt = greatest(attempt - 1, 0),
                   next_retry_at = NULL
               WHERE id = $1 AND status IN ('running', 'queued')`,
              [input.runId]
            );
            if (deferred.rowCount !== 1) {
              throw new Error("fingerprint_waiting_run_not_running");
            }
          }
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async recordRequest(reservationId, count, at) {
        if (!Number.isInteger(count) || count < 1) {
          throw new RangeError("fingerprint_request_count_out_of_range");
        }
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_request_time_invalid");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockFingerprintSweeps(client);
          const result = await client.query(
            `UPDATE fingerprint_sweep_reservations
             SET used_count = used_count + $2
             WHERE id = $1
               AND released_at IS NULL
               AND expires_at > $3
               AND used_count + $2 <= request_cap
             RETURNING id`,
            [reservationId, count, at]
          );
          if (result.rowCount !== 1) {
            throw new Error("fingerprint_reservation_not_active");
          }
          await client.query(
            `INSERT INTO fingerprint_sweep_request_events (reservation_id, requested_at)
             SELECT $1, $3::timestamptz FROM generate_series(1, $2)`,
            [reservationId, count, at]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async finish(reservationId, input) {
        if (Number.isNaN(input.at.valueOf())) {
          throw new RangeError("fingerprint_finish_time_invalid");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockFingerprintSweeps(client);
          await finishFingerprintSweep(client, reservationId, input);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async release(reservationId, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_release_time_invalid");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockFingerprintSweeps(client);
          const result = await client.query<{ admission_id: string }>(
            `UPDATE fingerprint_sweep_reservations
             SET released_at = $2
             WHERE id = $1 AND released_at IS NULL
             RETURNING admission_id`,
            [reservationId, at]
          );
          const row = result.rows[0];
          if (!row) throw new Error("fingerprint_reservation_not_active");
          await client.query(
            `UPDATE fingerprint_sweep_admissions
             SET status = 'released'
             WHERE id = $1`,
            [row.admission_id]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async listWaiting(limit, offset = 0) {
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 1_000 ||
          !Number.isInteger(offset) ||
          offset < 0
        ) {
          throw new RangeError("fingerprint_waiting_limit_out_of_range");
        }
        const result = await pool.query<{ discovery_run_id: string }>(
          `SELECT discovery_run_id
           FROM fingerprint_sweep_admissions
           WHERE status = 'waiting'
           ORDER BY requested_at, queue_order
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
        return result.rows.map((row) => row.discovery_run_id);
      },

      async listAdmittedUndispatched(limit) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
          throw new RangeError(
            "fingerprint_admission_dispatch_limit_out_of_range"
          );
        }
        const result = await pool.query<{ discovery_run_id: string }>(
          `SELECT discovery_run_id
           FROM fingerprint_sweep_admissions
           WHERE status = 'admitted' AND dispatched_at IS NULL
           ORDER BY requested_at, queue_order
           LIMIT $1`,
          [limit]
        );
        return result.rows.map((row) => row.discovery_run_id);
      },

      async markDispatched(runId, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_admission_time_invalid");
        }
        await pool.query(
          `UPDATE fingerprint_sweep_admissions
           SET dispatched_at = $2
           WHERE discovery_run_id = $1
             AND status = 'admitted'
             AND dispatched_at IS NULL`,
          [runId, at]
        );
      },

      async admitWaiting(runId, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_admission_time_invalid");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockFingerprintSweeps(client);
          const waiting = await client.query<{
            id: string;
            region: CharacterKey["region"];
            realm_slug: string;
            normalized_name: string;
            cadence_cutoff: Date;
          }>(
            `SELECT id, region, realm_slug, normalized_name, cadence_cutoff
             FROM fingerprint_sweep_admissions
             WHERE discovery_run_id = $1 AND status = 'waiting'
             ORDER BY requested_at, queue_order
             LIMIT 1
             FOR UPDATE`,
            [runId]
          );
          const admission = waiting.rows[0];
          if (!admission) {
            await client.query("COMMIT");
            return { kind: "settled" };
          }

          const state = await client.query<{ last_published_at: Date | null }>(
            `SELECT last_published_at
             FROM fingerprint_sweep_states
             WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
            [admission.region, admission.realm_slug, admission.normalized_name]
          );
          if (
            state.rows[0]?.last_published_at &&
            state.rows[0].last_published_at > admission.cadence_cutoff
          ) {
            await client.query(
              `UPDATE fingerprint_sweep_admissions
               SET status = 'not_due'
               WHERE id = $1`,
              [admission.id]
            );
            await client.query("COMMIT");
            return { kind: "not_due" };
          }

          const result = await admitFingerprintWaitingRun(
            client,
            admission.id,
            at
          );
          await client.query("COMMIT");
          return result.kind === "admitted" ? { kind: "admitted" } : result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async cleanupExpired(at = new Date()) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_cleanup_time_invalid");
        }
        // Each physical Blizzard request leaves one row, so the table would
        // grow by the whole hourly budget every hour. A request stops counting
        // towards the rolling hour once its own timestamp leaves the window, so
        // prune on requested_at: deleting by reservation would drop events the
        // admission accounting still has to see.
        const result = await pool.query(
          `DELETE FROM fingerprint_sweep_request_events
           WHERE requested_at <= $1::timestamptz - interval '1 hour'`,
          [at]
        );
        return result.rowCount ?? 0;
      }
    },

    evidence: {
      async reserve({ key, freshnessCutoff, at }) {
        if (
          Number.isNaN(freshnessCutoff.valueOf()) ||
          Number.isNaN(at.valueOf())
        ) {
          throw new RangeError("character_evidence_reservation_time_invalid");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockCharacterEvidence(client, key);
          const completed = await loadCompletedEvidence(client, key);
          if (
            completed !== null &&
            completed.run.completedAt !== null &&
            completed.run.completedAt >= freshnessCutoff
          ) {
            await client.query("COMMIT");
            return {
              kind: "fresh",
              run: completed.run,
              completed
            } satisfies EvidenceReservationResult;
          }

          const active = await client.query<EvidenceRunRow>(
            `SELECT id, region, realm_slug, normalized_name, queue_job_id, status,
                    attempt, limitation_code, parse_limitation_code, error_code, created_at, started_at,
                    completed_at
             FROM character_evidence_runs
             WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
               AND status IN ('queued', 'running', 'retrying')
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [key.region, key.realm, key.name]
          );
          if (active.rows[0]) {
            await client.query("COMMIT");
            return {
              kind: "active",
              run: mapEvidenceRun(active.rows[0]),
              completed
            } satisfies EvidenceReservationResult;
          }

          const inserted = await client.query<EvidenceRunRow>(
            `INSERT INTO character_evidence_runs
              (region, realm_slug, normalized_name)
             VALUES ($1, $2, $3)
             RETURNING id, region, realm_slug, normalized_name, queue_job_id, status,
                       attempt, limitation_code, parse_limitation_code, error_code, created_at, started_at,
                       completed_at`,
            [key.region, key.realm, key.name]
          );
          await client.query("COMMIT");
          return {
            kind: "reserved",
            run: mapEvidenceRun(inserted.rows[0]!),
            completed
          } satisfies EvidenceReservationResult;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async find(id) {
        const result = await pool.query<EvidenceRunRow>(
          `SELECT id, region, realm_slug, normalized_name, queue_job_id, status,
                  attempt, limitation_code, parse_limitation_code, error_code, created_at, started_at,
                  completed_at
           FROM character_evidence_runs WHERE id = $1`,
          [id]
        );
        return result.rows[0] ? mapEvidenceRun(result.rows[0]) : null;
      },

      async claim(id, attempt) {
        if (!Number.isInteger(attempt) || attempt < 1) {
          throw new RangeError("character_evidence_attempt_invalid");
        }
        const result = await pool.query<EvidenceRunRow>(
          `UPDATE character_evidence_runs
           SET status = 'running', attempt = $2,
               started_at = COALESCE(started_at, now()), error_code = NULL
           WHERE id = $1
             AND attempt < $2
             AND status IN ('queued', 'running', 'retrying')
           RETURNING id, region, realm_slug, normalized_name, queue_job_id, status,
                     attempt, limitation_code, parse_limitation_code, error_code, created_at, started_at,
                     completed_at`,
          [id, attempt]
        );
        return result.rows[0] ? mapEvidenceRun(result.rows[0]) : null;
      },

      async markEnqueued(id, queueJobId) {
        const result = await pool.query(
          `UPDATE character_evidence_runs
           SET queue_job_id = $2
           WHERE id = $1
             AND status = 'queued'
             AND (queue_job_id IS NULL OR queue_job_id = $2)`,
          [id, queueJobId]
        );
        if (result.rowCount !== 1) {
          throw new Error("character_evidence_run_not_enqueuable");
        }
      },

      async publish(runId, input) {
        if (
          Number.isNaN(input.completedAt.valueOf()) ||
          (input.state === "complete" && input.limitationCode !== null) ||
          (input.state === "partial" && input.limitationCode === null)
        ) {
          throw new RangeError("character_evidence_publication_invalid");
        }
        const incomingKills: Array<{
          kill: CharacterMythicKillInput;
          performance: ReturnType<typeof parsePerformanceValues>;
        }> = input.kills.map((kill) => {
          if (
            kill.guild !== null &&
            (kill.guild.name.length === 0 || kill.guild.realm.length === 0)
          ) {
            throw new RangeError("character_evidence_guild_invalid");
          }
          return {
            kill,
            performance: parsePerformanceValues(kill.performance)
          };
        });
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const active = await client.query<{
            id: string;
            region: CharacterKey["region"];
            realm_slug: string;
            normalized_name: string;
          }>(
            `SELECT id, region, realm_slug, normalized_name
             FROM character_evidence_runs
             WHERE id = $1 AND status IN ('queued', 'running', 'retrying')
             FOR UPDATE`,
            [runId]
          );
          if (active.rowCount !== 1) {
            throw new Error("character_evidence_run_not_active");
          }
          const activeRun = active.rows[0]!;
          const previous =
            input.state === "partial"
              ? await loadPositiveEvidenceForPartial(client, {
                  region: activeRun.region,
                  realm: activeRun.realm_slug,
                  name: activeRun.normalized_name
                })
              : null;
          const kills = new Map<string, (typeof incomingKills)[number]>(
            previous?.kills.map((kill) => [
              kill.fightUrl,
              { kill, performance: parsePerformanceValues(kill.performance) }
            ]) ?? []
          );
          for (const kill of incomingKills) {
            kills.set(kill.kill.fightUrl, kill);
          }
          const wipes = new Map<string, (typeof input.wipes)[number]>();
          for (const wipe of [...(previous?.wipes ?? []), ...input.wipes]) {
            wipes.set(wipe.fightUrl, wipe);
          }
          for (const { kill, performance } of kills.values()) {
            await client.query(
              `INSERT INTO character_mythic_kills
                (evidence_run_id, source_fight_key, raid_id, raid_name, boss_id,
                 boss_name, journal_boss_id, boss_order, is_final_boss, killed_at,
                 report_url, fight_url, guild_name, guild_realm, historic_world_rank,
                 damage_parse_state, damage_percentile, healing_parse_state,
                 healing_percentile, boss_damage_parse_state, boss_damage_percentile)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
              [
                runId,
                kill.fightUrl,
                kill.raidId,
                kill.raidName,
                kill.bossId,
                kill.bossName,
                kill.journalBossId,
                kill.bossOrder,
                kill.isFinalBoss,
                kill.killedAt,
                kill.reportUrl,
                kill.fightUrl,
                kill.guild?.name ?? null,
                kill.guild?.realm ?? null,
                kill.historicWorldRank ?? null,
                performance.damage.state,
                performance.damage.percentile,
                performance.healing.state,
                performance.healing.percentile,
                performance.bossDamage.state,
                performance.bossDamage.percentile
              ]
            );
          }
          for (const wipe of wipes.values()) {
            await client.query(
              `INSERT INTO character_mythic_wipes
                (evidence_run_id, raid_id, raid_name, boss_id, boss_name,
                 journal_boss_id, boss_order, attempted_at, report_url, fight_url)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                runId,
                wipe.raidId,
                wipe.raidName,
                wipe.bossId,
                wipe.bossName,
                wipe.journalBossId,
                wipe.bossOrder,
                wipe.attemptedAt,
                wipe.reportUrl,
                wipe.fightUrl
              ]
            );
          }
          const publication = await client.query(
            `UPDATE character_evidence_runs
             SET status = $2, limitation_code = $3, parse_limitation_code = $4,
                 error_code = NULL, completed_at = $5, evidence_version = 2
             WHERE id = $1 AND status IN ('queued', 'running', 'retrying')`,
            [
              runId,
              input.state,
              input.limitationCode,
              input.parseLimitationCode,
              input.completedAt
            ]
          );
          if (publication.rowCount !== 1) {
            throw new Error("character_evidence_run_not_active");
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async fail(id, code) {
        if (code.length === 0)
          throw new RangeError("character_evidence_error_invalid");
        const result = await pool.query(
          `UPDATE character_evidence_runs
           SET status = 'failed', error_code = $2, completed_at = now()
           WHERE id = $1 AND status IN ('queued', 'running', 'retrying')`,
          [id, code]
        );
        if (result.rowCount !== 1) {
          throw new Error("character_evidence_run_not_active");
        }
      },

      async getCompleted(key) {
        return loadCompletedEvidence(pool, key);
      },

      async listStatus(keys) {
        if (keys.length === 0) return [];
        const result = await pool.query<EvidenceRunRow>(
          `SELECT DISTINCT ON (run.region, run.realm_slug, run.normalized_name)
             run.id, run.region, run.realm_slug, run.normalized_name,
             run.queue_job_id, run.status, run.attempt, run.limitation_code,
             run.parse_limitation_code,
             run.error_code, run.created_at, run.started_at, run.completed_at
           FROM character_evidence_runs run
           JOIN unnest($1::text[], $2::text[], $3::text[])
             AS requested(region, realm_slug, normalized_name)
             ON requested.region = run.region
            AND requested.realm_slug = run.realm_slug
            AND requested.normalized_name = run.normalized_name
           ORDER BY run.region, run.realm_slug, run.normalized_name,
             (run.status IN ('queued', 'running', 'retrying')) DESC,
             run.created_at DESC, run.id DESC`,
          [
            keys.map((key) => key.region),
            keys.map((key) => key.realm),
            keys.map((key) => key.name)
          ]
        );
        return result.rows.map(mapEvidenceRun);
      }
    },

    negativeCache: {
      async put(key, expiresAt) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockRoot(client, key);
          await client.query(
            `INSERT INTO negative_character_cache
              (region, realm_slug, normalized_name, expires_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (region, realm_slug, normalized_name)
             DO UPDATE SET expires_at = EXCLUDED.expires_at, created_at = now()`,
            [key.region, key.realm, key.name, expiresAt]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async putAndFailRun(key, expiresAt, runId, options) {
        const client = await pool.connect();
        try {
          options?.signal?.throwIfAborted();
          await client.query("BEGIN");
          await lockRoot(client, key);
          const cacheResult = await client.query(
            `INSERT INTO negative_character_cache
              (region, realm_slug, normalized_name, expires_at)
             SELECT $1, $2, $3, $4
             WHERE EXISTS (
               SELECT 1 FROM discovery_runs
               WHERE id = $5 AND status IN ${activeRunSql}
             )
             ON CONFLICT (region, realm_slug, normalized_name)
             DO UPDATE SET expires_at = EXCLUDED.expires_at, created_at = now()
             RETURNING normalized_name`,
            [key.region, key.realm, key.name, expiresAt, runId]
          );
          if (cacheResult.rowCount !== 1) {
            throw new Error("discovery_run_not_active");
          }
          options?.signal?.throwIfAborted();
          const failure = await client.query(
            `UPDATE discovery_runs
             SET status = 'failed', error_code = 'character_not_found',
                 completed_at = now(), next_retry_at = NULL
             WHERE id = $1 AND status IN ${activeRunSql}`,
            [runId]
          );
          if (failure.rowCount !== 1) {
            throw new Error("discovery_run_not_active");
          }
          options?.signal?.throwIfAborted();
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async find(key, at = new Date()) {
        const result = await pool.query<{ expires_at: Date }>(
          `SELECT expires_at FROM negative_character_cache
           WHERE region = $1
             AND realm_slug = $2
             AND normalized_name = $3
             AND expires_at > $4`,
          [key.region, key.realm, key.name, at]
        );
        return result.rows[0]
          ? { key, expiresAt: result.rows[0].expires_at }
          : null;
      },

      async cleanupExpired(at = new Date()) {
        const result = await pool.query(
          "DELETE FROM negative_character_cache WHERE expires_at <= $1",
          [at]
        );
        return result.rowCount ?? 0;
      }
    }
  };
}
