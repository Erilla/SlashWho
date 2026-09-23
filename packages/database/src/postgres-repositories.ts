import type { PublicErrorCode } from "@slashwho/contracts";
import {
  isNonRaidZone,
  toRaiderIoUrl,
  type CharacterGuild,
  type CharacterKey
} from "@slashwho/domain";
import type { Pool, PoolClient } from "pg";
import { withAccountMailClient } from "./account-mail-query";
import type {
  CallerClass,
  CharacterEvidenceRun,
  EvidenceRunMode,
  StoredEvidenceGuild,
  StoredRankedBackfillCursor,
  HistoricAliasScanProgress,
  CharacterMythicKillParseMetric,
  CharacterMythicKillPerformance,
  CharacterMythicKillInput,
  CharacterTierBestParseInput,
  CompletedCharacterEvidence,
  EvidenceReservationResult,
  CreateSnapshotInput,
  DiscoveryRun,
  EvidenceCollectionDomain,
  EvidenceRunPhase,
  FingerprintAdmission,
  FingerprintContinuationAdmission,
  Account,
  AccountSummary,
  Operator,
  OperatorCredential,
  OperatorSession,
  Repositories,
  SnapshotHistoryItem,
  SnapshotHistoryPage,
  StagedEvidenceCollection,
  StoredCharacterMythicKill,
  StoredCharacterMythicWipe,
  StoredCharacterTierBestParse,
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

interface OperatorRow {
  id: string;
  canonical_login: string;
  display_login: string;
  active: boolean;
  credential_version: number;
  created_at: Date;
  updated_at: Date;
}

interface AccountRow {
  id: string;
  canonical_email: string;
  email: string;
  role: Account["role"];
  active: boolean;
  verified_at: Date | null;
  password_change_required: boolean;
  credential_version: number;
  created_at: Date;
  updated_at: Date;
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    canonicalEmail: row.canonical_email,
    email: row.email,
    role: row.role,
    active: row.active,
    verifiedAt: row.verified_at,
    passwordChangeRequired: row.password_change_required,
    credentialVersion: row.credential_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAccountSummary(row: AccountRow): AccountSummary {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    active: row.active,
    verifiedAt: row.verified_at,
    createdAt: row.created_at
  };
}

interface OperatorCredentialRow extends OperatorRow {
  password_hash: string;
  password_salt: string;
  scrypt_version: number;
  scrypt_cost: number;
}

interface OperatorSessionRow {
  id: string;
  operator_id: string;
  credential_version: number;
  issued_at: Date;
  last_used_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}

interface UsedOperatorSessionRow extends OperatorRow {
  session_id: string;
  session_operator_id: string;
  session_credential_version: number;
  issued_at: Date;
  last_used_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
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
  guild_name: string | null;
  guild_region: CharacterKey["region"] | null;
  guild_realm_slug: string | null;
  discovery_source: StoredSnapshotCharacter["source"];
  display_order: number;
}

function mapSnapshotCharacter(
  character: SnapshotCharacterRow
): StoredSnapshotCharacter {
  return {
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
    // Every part must be present to name a guild; a snapshot written before
    // the columns existed has none of them.
    guild:
      character.guild_name &&
      character.guild_region &&
      character.guild_realm_slug
        ? {
            name: character.guild_name,
            region: character.guild_region,
            realm: character.guild_realm_slug
          }
        : null,
    source: character.discovery_source,
    displayOrder: character.display_order
  };
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
  retry_after_at: Date | null;
  error_code: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  wcl_client_id_encrypted: string | null;
  wcl_client_secret_encrypted: string | null;
  class_name: string | null;
  mode?: EvidenceRunMode;
  tier_search_raid_id?: string | null;
}

interface CharacterMythicKillRow {
  id: string;
  raid_id: string;
  raid_name: string;
  boss_id: string;
  boss_name: string;
  journal_boss_id: string | null;
  boss_order: number;
  killed_at: Date;
  report_url: string;
  fight_url: string;
  guild_name: string | null;
  guild_region: CharacterKey["region"] | null;
  guild_realm: string | null;
  uploader: string | null;
  historic_world_rank: number | null;
  historic_rank_checked_at: Date | null;
  spec_name: string | null;
  spec_icon_url: string | null;
  damage_parse_state: CharacterMythicKillParseMetric["state"];
  damage_percentile: number | null;
  healing_parse_state: CharacterMythicKillParseMetric["state"];
  healing_percentile: number | null;
  boss_damage_parse_state: CharacterMythicKillParseMetric["state"];
  boss_damage_percentile: number | null;
  parses_read_at: Date | null;
}

interface CharacterTierBestParseRow {
  id: string;
  raid_id: string;
  raid_name: string;
  boss_id: string;
  boss_name: string;
  rankings_url: string;
  spec_name: string | null;
  spec_icon_url: string | null;
  damage_parse_state: CharacterMythicKillParseMetric["state"];
  damage_percentile: number | null;
  healing_parse_state: CharacterMythicKillParseMetric["state"];
  healing_percentile: number | null;
  boss_damage_parse_state: CharacterMythicKillParseMetric["state"];
  boss_damage_percentile: number | null;
  collected_at: Date;
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
  guild_name: string | null;
  guild_realm: string | null;
  uploader: string | null;
}

type Queryable = Pick<Pool | PoolClient, "query">;

// Bump when the evidence collector changes in a way that must refresh
// previously completed parse evidence.
// Bump when the evidence shape or provider request strategy changes so old
// snapshots are re-collected instead of being treated as fresh forever.
const CURRENT_EVIDENCE_VERSION = 15;

/**
 * Per-domain collection versions, for evidence stored indefinitely.
 *
 * Bump one when a collection fix changes what that domain stores: terminal
 * tiers below the new version drop out of `terminalTiers`, re-collect once and
 * settle again, while the other domains stay terminal. `CURRENT_EVIDENCE_VERSION`
 * cannot serve this -- it invalidates everything, which is affordable while
 * nothing is terminal and ruinous when the whole point is to stop re-querying.
 *
 * Whoever writes the next collection fix has to bump the right one. If that
 * habit does not stick, this degrades to the blunt global bump it replaced.
 */
const CURRENT_COLLECTION_VERSIONS: Readonly<
  Record<EvidenceCollectionDomain, number>
> = {
  kills: 2,
  parses: 2,
  tier_bests: 1
};

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
  at: Date,
  // A continuation already skipped the cadence gate in requestAdmission; this
  // keeps that exemption scoped to only its own admission row when the
  // (global, cross-run) head-of-queue candidate is picked here.
  bypassCadenceFor?: string
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
         OR admission.id = $1
       )
     ORDER BY admission.requested_at, admission.queue_order
     LIMIT 1
     FOR UPDATE OF admission`,
    [bypassCadenceFor ?? null]
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

function mapOperator(row: OperatorRow): Operator {
  return {
    id: row.id,
    canonicalLogin: row.canonical_login,
    displayLogin: row.display_login,
    active: row.active,
    credentialVersion: row.credential_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapOperatorCredential(row: OperatorCredentialRow): OperatorCredential {
  return {
    ...mapOperator(row),
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    scryptVersion: row.scrypt_version,
    scryptCost: row.scrypt_cost
  };
}

function mapOperatorSession(row: OperatorSessionRow): OperatorSession {
  return {
    id: row.id,
    operatorId: row.operator_id,
    credentialVersion: row.credential_version,
    issuedAt: row.issued_at,
    lastUsedAt: row.last_used_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at
  };
}

function mapUsedOperatorSession(row: UsedOperatorSessionRow): {
  operator: Operator;
  session: OperatorSession;
} {
  return {
    operator: mapOperator(row),
    session: mapOperatorSession({
      id: row.session_id,
      operator_id: row.session_operator_id,
      credential_version: row.session_credential_version,
      issued_at: row.issued_at,
      last_used_at: row.last_used_at,
      idle_expires_at: row.idle_expires_at,
      absolute_expires_at: row.absolute_expires_at,
      revoked_at: row.revoked_at
    })
  };
}

// The character's class lives on `characters`, keyed identically to an evidence
// run. Evidence collection needs it to settle the four specialisation names that
// two classes share, so every run projection carries it.
function evidenceRunClassNameSql(alias = "character_evidence_runs"): string {
  return `(SELECT c.class_name FROM characters c
             WHERE c.region = ${alias}.region
               AND c.realm_slug = ${alias}.realm_slug
               AND c.normalized_name = ${alias}.normalized_name) AS class_name`;
}

// What a run was reserved to do. Selected everywhere a run is mapped, so a
// re-claimed tier search is still a tier search.
function evidenceRunModeSql(alias = "character_evidence_runs"): string {
  return `${alias}.mode, ${alias}.tier_search_raid_id`;
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
    retryAfterAt: row.retry_after_at,
    errorCode: row.error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    wclClientIdEncrypted: row.wcl_client_id_encrypted,
    wclClientSecretEncrypted: row.wcl_client_secret_encrypted,
    className: row.class_name,
    mode: row.mode ?? "full",
    tierSearchRaidId: row.tier_search_raid_id ?? null
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
    killedAt: row.killed_at.toISOString(),
    reportUrl: row.report_url,
    fightUrl: row.fight_url,
    guild:
      row.guild_name === null
        ? null
        : {
            name: row.guild_name,
            realm: row.guild_realm!,
            ...(row.guild_region === null ? {} : { region: row.guild_region })
          },
    ...(row.uploader === null ? {} : { uploader: row.uploader }),
    historicWorldRank: row.historic_world_rank,
    historicRankCheckedAt: row.historic_rank_checked_at?.toISOString() ?? null,
    performance: {
      spec:
        row.spec_name === null || row.spec_icon_url === null
          ? null
          : { name: row.spec_name, iconUrl: row.spec_icon_url },
      damage: mapParseMetric(row.damage_parse_state, row.damage_percentile),
      healing: mapParseMetric(row.healing_parse_state, row.healing_percentile),
      bossDamage: mapParseMetric(
        row.boss_damage_parse_state,
        row.boss_damage_percentile
      )
    },
    parsesReadAt: row.parses_read_at?.toISOString() ?? null
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
  spec: CharacterMythicKillPerformance["spec"];
  damage: ReturnType<typeof parseMetricValues>;
  healing: ReturnType<typeof parseMetricValues>;
  bossDamage: ReturnType<typeof parseMetricValues>;
} {
  if (typeof performance !== "object" || performance === null) {
    throw new RangeError("character_mythic_kill_performance_invalid");
  }
  const candidate = performance as Partial<CharacterMythicKillPerformance>;
  return {
    spec:
      candidate.spec &&
      typeof candidate.spec.name === "string" &&
      typeof candidate.spec.iconUrl === "string"
        ? candidate.spec
        : null,
    damage: parseMetricValues(candidate.damage),
    healing: parseMetricValues(candidate.healing),
    bossDamage: parseMetricValues(candidate.bossDamage)
  };
}

function mapCharacterTierBestParse(
  row: CharacterTierBestParseRow
): StoredCharacterTierBestParse {
  return {
    id: row.id,
    raidId: row.raid_id,
    raidName: row.raid_name,
    bossId: row.boss_id,
    bossName: row.boss_name,
    rankingsUrl: row.rankings_url,
    performance: {
      spec:
        row.spec_name === null || row.spec_icon_url === null
          ? null
          : { name: row.spec_name, iconUrl: row.spec_icon_url },
      damage: mapParseMetric(row.damage_parse_state, row.damage_percentile),
      healing: mapParseMetric(row.healing_parse_state, row.healing_percentile),
      bossDamage: mapParseMetric(
        row.boss_damage_parse_state,
        row.boss_damage_percentile
      )
    }
  };
}

const tierBestParseColumns = `id, raid_id, raid_name, boss_id, boss_name,
            rankings_url, spec_name, spec_icon_url,
            damage_parse_state, damage_percentile,
            healing_parse_state, healing_percentile,
            boss_damage_parse_state, boss_damage_percentile`;

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
    fightUrl: row.fight_url,
    guild:
      row.guild_name === null
        ? null
        : { name: row.guild_name, realm: row.guild_realm! },
    ...(row.uploader === null ? {} : { uploader: row.uploader })
  };
}

function historicalGuildsFromDatabase(
  value: unknown
): readonly CharacterGuild[] {
  if (!Array.isArray(value)) return [];
  const guilds = new Map<string, CharacterGuild>();
  for (const guild of value) {
    if (
      typeof guild !== "object" ||
      guild === null ||
      !("name" in guild) ||
      !("region" in guild) ||
      !("realm" in guild) ||
      typeof guild.name !== "string" ||
      typeof guild.realm !== "string" ||
      !["us", "eu", "kr", "tw"].includes(String(guild.region))
    ) {
      continue;
    }
    const normalized = {
      name: guild.name,
      region: guild.region as CharacterKey["region"],
      realm: guild.realm
    };
    guilds.set(
      `${normalized.region}/${normalized.realm}/${normalized.name}`,
      normalized
    );
  }
  return [...guilds.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, guild]) => guild);
}

/**
 * The distinct guilds a character's stored kills were in. A guild is in the
 * character's own region; rows from before #427 carry no region of their own.
 */
function storedEvidenceGuilds(
  kills: readonly StoredCharacterMythicKill[],
  region: CharacterKey["region"]
): readonly StoredEvidenceGuild[] {
  const guilds = new Map<string, StoredEvidenceGuild>();
  for (const kill of kills) {
    const guild = kill.guild;
    if (!guild || guild.name.length === 0 || guild.realm.length === 0) continue;
    const item = { name: guild.name, realm: guild.realm, region };
    guilds.set(`${item.realm}\u0000${item.name}`, item);
  }
  return [...guilds.values()];
}

async function loadCompletedEvidence(
  client: Queryable,
  key: CharacterKey
): Promise<CompletedCharacterEvidence | null> {
  const runResult = await client.query<EvidenceRunRow>(
    `SELECT id, region, realm_slug, normalized_name, queue_job_id, status,
            evidence_version, attempt, limitation_code, parse_limitation_code,
            retry_after_at, error_code, created_at, started_at,
            completed_at, wcl_client_id_encrypted, wcl_client_secret_encrypted,
            ${evidenceRunClassNameSql()}, ${evidenceRunModeSql()}
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
            boss_order, killed_at, report_url, fight_url,
            guild_name, guild_region, guild_realm, uploader, historic_world_rank, historic_rank_checked_at, spec_name, spec_icon_url,
            damage_parse_state,
            damage_percentile, healing_parse_state, healing_percentile,
            boss_damage_parse_state, boss_damage_percentile, parses_read_at
     FROM character_mythic_kills
     WHERE evidence_run_id = $1
     ORDER BY killed_at, source_fight_key`,
    [run.id]
  );
  const wipesResult = await client.query<CharacterMythicWipeRow>(
    `SELECT id, raid_id, raid_name, boss_id, boss_name, journal_boss_id,
            boss_order, attempted_at, report_url, fight_url, guild_name, guild_realm, uploader
     FROM character_mythic_wipes
     WHERE evidence_run_id = $1
     ORDER BY raid_id, boss_order, attempted_at DESC, fight_url`,
    [run.id]
  );
  const tierBestsResult = await client.query<CharacterTierBestParseRow>(
    `SELECT ${tierBestParseColumns}
     FROM character_tier_best_parses
     WHERE evidence_run_id = $1
     ORDER BY raid_id, boss_id`,
    [run.id]
  );
  const cuttingEdgesResult = await client.query<{
    achievement_id: string;
    completed_at: Date;
  }>(
    `SELECT achievement_id, completed_at
       FROM character_evidence_cutting_edges
      WHERE evidence_run_id = $1
      ORDER BY achievement_id`,
    [run.id]
  );
  const blizzardPhase = await client.query<{ state: string }>(
    `SELECT state FROM character_evidence_run_phases
      WHERE run_id = $1 AND phase_id = 'blizzard_achievements'`,
    [run.id]
  );
  return {
    run: mapEvidenceRun(run),
    evidenceVersion: run.evidence_version,
    kills: killsResult.rows.map(mapCharacterMythicKill),
    wipes: wipesResult.rows.map(mapCharacterMythicWipe),
    tierBests: tierBestsResult.rows.map(mapCharacterTierBestParse),
    cuttingEdges: cuttingEdgesResult.rows.map((row) => ({
      achievementId: row.achievement_id,
      completedAt: row.completed_at.toISOString()
    })),
    cuttingEdgesCollected: blizzardPhase.rows[0]?.state === "completed",
    wipeCapable: run.evidence_version >= 2
  };
}

export function isEvidenceFresh(
  completedAt: Date,
  retryAfterAt: Date | null,
  freshnessCutoff: Date,
  at = new Date()
): boolean {
  return (
    completedAt >= freshnessCutoff &&
    (retryAfterAt === null || retryAfterAt > at)
  );
}

// Parse enrichment is best-effort: a re-collection that is rate limited or
// capped re-finds the same fight with nothing attached. A fight is immutable,
// so a value already observed for it is never worsened by a later blank.
function mergeParseMetric(
  previous: ReturnType<typeof parsePerformanceValues>["damage"],
  incoming: ReturnType<typeof parsePerformanceValues>["damage"]
): ReturnType<typeof parsePerformanceValues>["damage"] {
  return incoming.state === "available" || previous.state !== "available"
    ? incoming
    : previous;
}

function mergePerformanceValues(
  previous: ReturnType<typeof parsePerformanceValues>,
  incoming: ReturnType<typeof parsePerformanceValues>
): ReturnType<typeof parsePerformanceValues> {
  return {
    spec: incoming.spec ?? previous.spec,
    damage: mergeParseMetric(previous.damage, incoming.damage),
    healing: mergeParseMetric(previous.healing, incoming.healing),
    bossDamage: mergeParseMetric(previous.bossDamage, incoming.bossDamage)
  };
}

/**
 * Parses already stored for a character, keyed by fight.
 *
 * Collection deliberately does not re-fetch a fight it has already hydrated, so
 * every publish — not only a partial one — has to carry those values forward.
 * Without this a complete run writes the skipped fights back blank.
 *
 * `id DESC` is not decoration. `loadCompletedEvidence` picks the run a dossier
 * shows with `completed_at DESC, id DESC`, so this has to break a tie the same
 * way or a publish can carry forward a copy of a fight the dossier does not
 * show. A tie in an ORDER BY leaving the winner to PostgreSQL's discretion is
 * exactly the shape of #331, which cost a day of oscillating coverage before
 * anyone could attribute it.
 */
async function loadStoredPerformanceByFightUrl(
  client: Queryable,
  key: CharacterKey
): Promise<Map<string, ReturnType<typeof parsePerformanceValues>>> {
  const result = await client.query<
    Pick<
      CharacterMythicKillRow,
      | "fight_url"
      | "spec_name"
      | "spec_icon_url"
      | "damage_parse_state"
      | "damage_percentile"
      | "healing_parse_state"
      | "healing_percentile"
      | "boss_damage_parse_state"
      | "boss_damage_percentile"
    >
  >(
    `SELECT DISTINCT ON (k.fight_url)
            k.fight_url, k.spec_name, k.spec_icon_url,
            k.damage_parse_state, k.damage_percentile,
            k.healing_parse_state, k.healing_percentile,
            k.boss_damage_parse_state, k.boss_damage_percentile
     FROM character_mythic_kills k
     JOIN character_evidence_runs r ON r.id = k.evidence_run_id
     WHERE r.region = $1 AND r.realm_slug = $2 AND r.normalized_name = $3
       AND r.status IN ('complete', 'partial')
     ORDER BY k.fight_url, r.completed_at DESC NULLS LAST, r.id DESC`,
    [key.region, key.realm, key.name]
  );
  return new Map(
    result.rows.map((row) => [
      row.fight_url,
      parsePerformanceValues({
        spec:
          row.spec_name === null || row.spec_icon_url === null
            ? null
            : { name: row.spec_name, iconUrl: row.spec_icon_url },
        damage: mapParseMetric(row.damage_parse_state, row.damage_percentile),
        healing: mapParseMetric(
          row.healing_parse_state,
          row.healing_percentile
        ),
        bossDamage: mapParseMetric(
          row.boss_damage_parse_state,
          row.boss_damage_percentile
        )
      })
    ])
  );
}

/**
 * Tier bests already stored for a character, keyed by zone and encounter.
 *
 * One run reads only the newest few zones, so every publish — complete or
 * partial — has to carry the rest forward. Without this a run that reached
 * only the current tier would blank every earlier tier's best parse.
 */
async function loadStoredTierBestParses(
  client: Queryable,
  key: CharacterKey
): Promise<
  Map<
    string,
    {
      tierBest: CharacterTierBestParseInput;
      performance: ReturnType<typeof parsePerformanceValues>;
      /** When this zone was actually read, preserved across carry-forward. */
      collectedAt: Date;
    }
  >
> {
  const result = await client.query<CharacterTierBestParseRow>(
    `SELECT DISTINCT ON (t.raid_id, t.boss_id)
            t.id, t.raid_id, t.raid_name, t.boss_id, t.boss_name,
            t.rankings_url, t.spec_name, t.spec_icon_url,
            t.damage_parse_state, t.damage_percentile,
            t.healing_parse_state, t.healing_percentile,
            t.boss_damage_parse_state, t.boss_damage_percentile,
            t.collected_at
     FROM character_tier_best_parses t
     JOIN character_evidence_runs r ON r.id = t.evidence_run_id
     WHERE r.region = $1 AND r.realm_slug = $2 AND r.normalized_name = $3
       AND r.status IN ('complete', 'partial')
     ORDER BY t.raid_id, t.boss_id, r.completed_at DESC NULLS LAST, r.id DESC`,
    [key.region, key.realm, key.name]
  );
  return new Map(
    result.rows.map((row) => {
      const { id, ...tierBest } = mapCharacterTierBestParse(row);
      void id;
      return [
        `${tierBest.raidId}\0${tierBest.bossId}`,
        {
          tierBest,
          performance: parsePerformanceValues(tierBest.performance),
          collectedAt: row.collected_at
        }
      ];
    })
  );
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
  // Every run in the window holds its own copy of each fight, and those copies
  // are identical on `(killed_at, source_fight_key)` -- so ordering by that
  // alone leaves which copy of a fight the caller sees up to the sort, which
  // PostgreSQL does not keep stable once the set outgrows a handful of rows.
  // The newest run's copy is the only correct one: it is the one every earlier
  // publish already merged into. Pick it explicitly (#326).
  const kills = await client.query<CharacterMythicKillRow>(
    `SELECT id, raid_id, raid_name, boss_id, boss_name, journal_boss_id,
            boss_order, killed_at, report_url, fight_url,
            guild_name, guild_region, guild_realm, uploader, historic_world_rank, historic_rank_checked_at, spec_name, spec_icon_url,
            damage_parse_state, damage_percentile, healing_parse_state,
            healing_percentile, boss_damage_parse_state, boss_damage_percentile,
            parses_read_at
     FROM (
       SELECT DISTINCT ON (k.fight_url)
              k.id, k.raid_id, k.raid_name, k.boss_id, k.boss_name,
              k.journal_boss_id, k.boss_order, k.killed_at,
              k.report_url, k.fight_url, k.source_fight_key, k.guild_name,
              k.guild_region, k.guild_realm, k.uploader, k.historic_world_rank, k.historic_rank_checked_at, k.spec_name, k.spec_icon_url,
              k.damage_parse_state, k.damage_percentile,
              k.healing_parse_state, k.healing_percentile,
              k.boss_damage_parse_state, k.boss_damage_percentile,
              k.parses_read_at
         FROM character_mythic_kills k
         JOIN character_evidence_runs r ON r.id = k.evidence_run_id
        WHERE k.evidence_run_id = ANY($1::uuid[])
        ORDER BY k.fight_url, r.completed_at DESC NULLS LAST, r.id DESC
     ) k
     ORDER BY killed_at, source_fight_key`,
    [runIds]
  );
  const wipes = await client.query<CharacterMythicWipeRow>(
    `SELECT id, raid_id, raid_name, boss_id, boss_name, journal_boss_id,
            boss_order, attempted_at, report_url, fight_url, guild_name, guild_realm, uploader
     FROM (
       SELECT DISTINCT ON (w.fight_url)
              w.id, w.raid_id, w.raid_name, w.boss_id, w.boss_name,
              w.journal_boss_id, w.boss_order, w.attempted_at, w.report_url,
              w.fight_url, w.guild_name, w.guild_realm, w.uploader
         FROM character_mythic_wipes w
         JOIN character_evidence_runs r ON r.id = w.evidence_run_id
        WHERE w.evidence_run_id = ANY($1::uuid[])
        ORDER BY w.fight_url, r.completed_at DESC NULLS LAST, r.id DESC
     ) w
     ORDER BY raid_id, boss_order, attempted_at DESC, fight_url`,
    [runIds]
  );
  // Rows in a zone positively identified as not a raid stop being carried.
  // They were stored because a Mythic dungeon boss shares a difficulty with a
  // Mythic raid boss, and collection no longer produces them -- but a
  // character whose every publish is partial carries all its stored evidence
  // forward, so without this they would never drain and the counts they
  // inflate would stay wrong (#346). Keyed on identifying the zone as a
  // dungeon, never on failing to identify it as a raid: a new tier the
  // catalogue has not caught up with also fails to resolve, and dropping that
  // would delete real kills.
  return {
    kills: kills.rows
      .map(mapCharacterMythicKill)
      .filter((kill) => !isNonRaidZone(kill.raidName)),
    wipes: wipes.rows
      .map(mapCharacterMythicWipe)
      .filter((wipe) => !isNonRaidZone(wipe.raidName))
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
      membership.guild_name,
      membership.guild_region,
      membership.guild_realm_slug,
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
  const characters = characterResult.rows.map(mapSnapshotCharacter);

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
         display_name, class_name, level, raider_io_url,
         guild_name, guild_region, guild_realm_slug)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        snapshotId,
        characterId,
        displayOrder,
        character.source,
        character.displayName,
        character.className,
        character.level,
        character.raiderIoUrl,
        character.guild?.name ?? null,
        character.guild?.region ?? null,
        character.guild?.realm ?? null
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
  input: {
    published: boolean;
    at: Date;
    limitationCode: string | null;
    continuationAdmission?: FingerprintContinuationAdmission;
    /**
     * Omitted by a caller that has no claim on the sweep cursor. The resume
     * columns are then left exactly as they are, so finishing one reservation
     * cannot wipe a cursor belonging to a chain it knows nothing about.
     */
    cursor?: {
      resumeAfter: string | null;
      resumeLimitationCode: string | null;
      historicalGuilds?: readonly CharacterGuild[];
      resumeSnapshotId: string | null;
      advanced: boolean;
    };
  }
): Promise<void> {
  const reservation = await client.query<{
    admission_id: string;
    discovery_run_id: string;
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
     RETURNING reservation.admission_id, admission.discovery_run_id,
               admission.region,
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
  if (!input.published) return;
  const cursor = input.cursor;
  if (!cursor) {
    await client.query(
      `INSERT INTO fingerprint_sweep_states
        (region, realm_slug, normalized_name, last_published_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (region, realm_slug, normalized_name)
       DO UPDATE SET
         last_published_at = greatest(
           fingerprint_sweep_states.last_published_at,
           EXCLUDED.last_published_at
         )`,
      [row.region, row.realm_slug, row.normalized_name, input.at]
    );
    return;
  }
  await client.query(
    `INSERT INTO fingerprint_sweep_states
      (region, realm_slug, normalized_name, last_published_at,
       resume_after, resume_limitation_code, resume_historical_guilds,
       resume_snapshot_id,
       continuation_failures)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 0)
     ON CONFLICT (region, realm_slug, normalized_name)
     DO UPDATE SET
       last_published_at = greatest(
         fingerprint_sweep_states.last_published_at,
         EXCLUDED.last_published_at
       ),
       resume_after = EXCLUDED.resume_after,
       resume_limitation_code = EXCLUDED.resume_limitation_code,
       resume_historical_guilds = EXCLUDED.resume_historical_guilds,
       resume_snapshot_id = EXCLUDED.resume_snapshot_id,
       continuation_failures = CASE
         WHEN $9 THEN 0
         ELSE fingerprint_sweep_states.continuation_failures
       END`,
    [
      row.region,
      row.realm_slug,
      row.normalized_name,
      input.at,
      cursor.resumeAfter,
      cursor.resumeLimitationCode,
      cursor.resumeAfter === null
        ? null
        : JSON.stringify(cursor.historicalGuilds ?? []),
      cursor.resumeSnapshotId,
      cursor.advanced
    ]
  );
  if (cursor.resumeAfter !== null && input.continuationAdmission) {
    const continuation = input.continuationAdmission;
    await client.query(
      `INSERT INTO fingerprint_sweep_admissions
        (discovery_run_id, region, realm_slug, normalized_name, request_cap,
         hourly_budget, cadence_cutoff, requested_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
       WHERE NOT EXISTS (
         SELECT 1 FROM fingerprint_sweep_admissions
         WHERE discovery_run_id = $1 AND status IN ('waiting', 'admitted')
       )`,
      [
        row.discovery_run_id,
        row.region,
        row.realm_slug,
        row.normalized_name,
        continuation.requestCap,
        continuation.hourlyBudget,
        continuation.cadenceCutoff,
        input.at
      ]
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

/** A changed alias makes every old kill-tier conclusion and scan cursor stale. */
async function invalidateHistoricAliasKillScan(
  client: PoolClient,
  key: CharacterKey
): Promise<void> {
  const values = [key.region, key.realm, key.name];
  await client.query(
    `DELETE FROM character_terminal_tiers
      WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
        AND domain = 'kills'`,
    values
  );
  await client.query(
    `UPDATE character_evidence_runs
        SET kill_scan_completed_at = NULL,
            kill_scan_resume_page = NULL,
            kill_scan_resume_boundary_report_code = NULL,
            historic_alias_progress = NULL
      WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
        AND status IN ('complete', 'partial')`,
    values
  );
  await client.query(
    `DELETE FROM character_attendance_searches
      WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
    values
  );
}

async function requestHistoricAliasRecollection(
  client: PoolClient,
  key: CharacterKey
): Promise<void> {
  await client.query(
    `INSERT INTO character_alias_recollections
       (region, realm_slug, normalized_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (region, realm_slug, normalized_name)
     DO UPDATE SET requested_at = now()`,
    [key.region, key.realm, key.name]
  );
}

type AdminMutation =
  | { kind: "role"; role: Account["role"] }
  | { kind: "active"; active: boolean }
  | { kind: "password_change" };

async function mutateAccountAdmin(
  pool: Pool,
  input: { actorId: string; targetId: string; at: Date },
  mutation: AdminMutation
): Promise<"updated" | "last_admin" | "forbidden" | "missing"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize admin changes even when separate requests target different rows.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('account-admin', 1))"
    );
    const actor = await client.query<{
      role: Account["role"];
      active: boolean;
      verified_at: Date | null;
      password_change_required: boolean;
    }>(
      `SELECT role, active, verified_at, password_change_required
       FROM accounts WHERE id = $1 FOR UPDATE`,
      [input.actorId]
    );
    if (
      actor.rows[0]?.role !== "admin" ||
      !actor.rows[0].active ||
      !actor.rows[0].verified_at ||
      actor.rows[0].password_change_required
    ) {
      await client.query("COMMIT");
      return "forbidden";
    }
    const target = await client.query<{
      role: Account["role"];
      active: boolean;
      verified_at: Date | null;
    }>(
      "SELECT role, active, verified_at FROM accounts WHERE id = $1 FOR UPDATE",
      [input.targetId]
    );
    if (!target.rows[0]) {
      await client.query("COMMIT");
      return "missing";
    }
    if (
      !target.rows[0].verified_at &&
      ((mutation.kind === "role" && mutation.role === "admin") ||
        (mutation.kind === "active" &&
          mutation.active &&
          target.rows[0].role === "admin"))
    ) {
      await client.query("COMMIT");
      return "forbidden";
    }
    const removesAdmin =
      target.rows[0].role === "admin" &&
      target.rows[0].active &&
      target.rows[0].verified_at !== null &&
      ((mutation.kind === "role" && mutation.role !== "admin") ||
        (mutation.kind === "active" && !mutation.active));
    if (removesAdmin) {
      const count = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM accounts WHERE role = 'admin' AND active AND verified_at IS NOT NULL"
      );
      if (count.rows[0]!.count <= 1) {
        await client.query("COMMIT");
        return "last_admin";
      }
    }
    if (mutation.kind === "role") {
      await client.query(
        `UPDATE accounts SET role = $2, credential_version = credential_version + 1,
         updated_at = $3 WHERE id = $1`,
        [input.targetId, mutation.role, input.at]
      );
    } else if (mutation.kind === "active") {
      await client.query(
        `UPDATE accounts SET active = $2, credential_version = credential_version + 1,
         updated_at = $3 WHERE id = $1`,
        [input.targetId, mutation.active, input.at]
      );
    } else {
      await client.query(
        `UPDATE accounts SET password_change_required = true,
         credential_version = credential_version + 1, updated_at = $2 WHERE id = $1`,
        [input.targetId, input.at]
      );
    }
    await client.query(
      `UPDATE account_sessions SET revoked_at = $2
       WHERE account_id = $1 AND revoked_at IS NULL`,
      [input.targetId, input.at]
    );
    await client.query(
      `INSERT INTO account_auth_events (account_id, action, outcome, occurred_at)
       VALUES ($1, $2, 'success', $3)`,
      [input.targetId, mutation.kind, input.at]
    );
    await client.query("COMMIT");
    return "updated";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresRepositories(pool: Pool): Repositories {
  return {
    accountMail: {
      async issue(input) {
        if (input.expiresAt <= input.at)
          throw new Error("account_mail_expired");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const token = await client.query<{ id: string }>(
            `INSERT INTO account_mail_tokens
             (account_id, purpose, token_digest, expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [
              input.accountId,
              input.purpose,
              input.tokenDigest,
              input.expiresAt,
              input.at
            ]
          );
          await client.query(
            `INSERT INTO account_mail_outbox
             (token_id, encrypted_message, idempotency_key, expires_at, next_attempt_at, created_at)
             VALUES ($1, $2, gen_random_uuid()::text, $3, $4, $4)`,
            [
              token.rows[0]!.id,
              input.encryptedMessage,
              input.expiresAt,
              input.at
            ]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      async claimDue(at, signal) {
        return withAccountMailClient(pool, signal, async (client, signal) => {
          // Also purge sent metadata after expiry; token records contain digests only.
          await client.query(
            "DELETE FROM account_mail_outbox WHERE expires_at <= $1",
            [at]
          );
          signal.throwIfAborted();
          const result = await client.query<{
            id: string;
            encrypted_message: string;
            idempotency_key: string;
            expires_at: Date;
            attempt: number;
          }>(
            `WITH due AS (
             SELECT id FROM account_mail_outbox
             WHERE sent_at IS NULL AND expires_at > $1 AND next_attempt_at <= $1
             ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE account_mail_outbox AS mail
           SET attempt = attempt + 1,
               next_attempt_at = $1 + make_interval(secs =>
                 LEAST(3600, 60 * power(2, LEAST(mail.attempt, 6)))::int)
           FROM due WHERE mail.id = due.id
           RETURNING mail.id, encrypted_message, idempotency_key, expires_at, attempt`,
            [at]
          );
          const row = result.rows[0];
          return row
            ? {
                id: row.id,
                encryptedMessage: row.encrypted_message,
                idempotencyKey: row.idempotency_key,
                expiresAt: row.expires_at,
                attempt: row.attempt
              }
            : null;
        });
      },
      async markSent(id, at, signal) {
        await withAccountMailClient(pool, signal, async (client) => {
          await client.query(
            `UPDATE account_mail_outbox SET sent_at = $2, encrypted_message = '' WHERE id = $1`,
            [id, at]
          );
        });
      }
    },
    accountAuth: {
      async provisionAdmin(input) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await client.query<AccountRow>(
            `INSERT INTO accounts
               (canonical_email, email, role, verified_at, password_change_required,
                password_hash, password_salt, scrypt_version, scrypt_cost,
                created_at, updated_at)
             VALUES ($1, $2, 'admin', $7, true, $3, $4, $5, $6, $7, $7)
             RETURNING id, canonical_email, email, role, active, verified_at,
                       password_change_required, credential_version, created_at, updated_at`,
            [
              input.canonicalEmail,
              input.email,
              input.passwordHash,
              input.passwordSalt,
              input.scryptVersion,
              input.scryptCost,
              input.at
            ]
          );
          const account = mapAccount(result.rows[0]!);
          await client.query(
            `INSERT INTO account_auth_events (account_id, action, outcome, occurred_at)
             VALUES ($1, 'provision_admin', 'success', $2)`,
            [account.id, input.at]
          );
          await client.query("COMMIT");
          return account;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      setRole(input) {
        return mutateAccountAdmin(pool, input, {
          kind: "role",
          role: input.role
        });
      },

      setActive(input) {
        return mutateAccountAdmin(pool, input, {
          kind: "active",
          active: input.active
        });
      },

      async requirePasswordChange(input) {
        return (
          (await mutateAccountAdmin(pool, input, {
            kind: "password_change"
          })) === "updated"
        );
      },

      async listAccounts(actorId) {
        const result = await pool.query<AccountRow>(
          `SELECT id, canonical_email, email, role, active, verified_at,
                  password_change_required, credential_version, created_at, updated_at
           FROM accounts
           WHERE EXISTS (
             SELECT 1 FROM accounts AS actor
             WHERE actor.id = $1 AND actor.role = 'admin' AND actor.active
               AND actor.verified_at IS NOT NULL
               AND NOT actor.password_change_required
           )
           ORDER BY canonical_email`,
          [actorId]
        );
        return result.rows.map(mapAccountSummary);
      },

      async registerPending(input) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // A limited batch makes progress on old pending registrations without
          // turning a signup into an unbounded table sweep. Remove the target
          // first so a backlog cannot keep an expired address unavailable.
          const targetCleanup = await client.query(
            `DELETE FROM accounts
             WHERE canonical_email = $2 AND verified_at IS NULL
               AND created_at <= $1::timestamptz - interval '7 days'`,
            [input.at, input.canonicalEmail]
          );
          await client.query(
            `WITH expired AS (
               SELECT id FROM accounts
               WHERE verified_at IS NULL AND created_at <= $1::timestamptz - interval '7 days'
               ORDER BY created_at, id LIMIT $2
               FOR UPDATE SKIP LOCKED
             )
             DELETE FROM accounts WHERE id IN (SELECT id FROM expired)`,
            [input.at, 100 - (targetCleanup.rowCount ?? 0)]
          );
          const result = await client.query<{ id: string }>(
            `INSERT INTO accounts
               (canonical_email, email, password_hash, password_salt,
                scrypt_version, scrypt_cost, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
             ON CONFLICT (canonical_email) DO NOTHING
             RETURNING id`,
            [
              input.canonicalEmail,
              input.email,
              input.passwordHash,
              input.passwordSalt,
              input.scryptVersion,
              input.scryptCost,
              input.at
            ]
          );
          await client.query("COMMIT");
          return result.rows[0]
            ? { kind: "created" as const, accountId: result.rows[0].id }
            : { kind: "existing" as const };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async admitRegistration(input) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // The global lock serializes all admission buckets, including the
          // missing-IP fallback, so concurrent requests cannot over-admit.
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('account-registration', 1))"
          );
          const buckets = [
            {
              purpose: "registration_global",
              subject: "global",
              limit: 100,
              duration: 3_600_000
            },
            input.ipSubjectHash
              ? {
                  purpose: "registration_ip",
                  subject: input.ipSubjectHash,
                  limit: 5,
                  duration: 3_600_000
                }
              : {
                  purpose: "registration_missing_ip",
                  subject: "fallback",
                  limit: 10,
                  duration: 3_600_000
                },
            {
              purpose: "registration_email",
              subject: input.emailSubjectHash,
              limit: 3,
              duration: 86_400_000
            }
          ];
          for (const bucket of buckets) {
            const usage = await client.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM account_request_attempts
               WHERE purpose = $1 AND subject_hash = $2 AND expires_at > $3`,
              [bucket.purpose, bucket.subject, input.at]
            );
            if (Number(usage.rows[0]!.count) >= bucket.limit) {
              await client.query("COMMIT");
              return "throttled";
            }
          }
          for (const bucket of buckets) {
            await client.query(
              `INSERT INTO account_request_attempts (purpose, subject_hash, expires_at)
               VALUES ($1, $2, $3)`,
              [
                bucket.purpose,
                bucket.subject,
                new Date(input.at.getTime() + bucket.duration)
              ]
            );
          }
          await client.query("COMMIT");
          return "admitted";
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }
    },
    operatorAuth: {
      async findCredential(canonicalLogin) {
        const result = await pool.query<OperatorCredentialRow>(
          `SELECT id, canonical_login, display_login, password_hash,
                  password_salt, scrypt_version, scrypt_cost, active,
                  credential_version, created_at, updated_at
           FROM operators
           WHERE canonical_login = $1`,
          [canonicalLogin]
        );
        return result.rows[0] ? mapOperatorCredential(result.rows[0]) : null;
      },

      async provision(input) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await client.query<OperatorRow>(
            `INSERT INTO operators
              (canonical_login, display_login, password_hash, password_salt,
               scrypt_version, scrypt_cost, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
             RETURNING id, canonical_login, display_login, active,
                       credential_version, created_at, updated_at`,
            [
              input.canonicalLogin,
              input.displayLogin,
              input.passwordHash,
              input.passwordSalt,
              input.scryptVersion,
              input.scryptCost,
              input.at
            ]
          );
          const operator = mapOperator(result.rows[0]!);
          await client.query(
            `INSERT INTO operator_auth_events
              (operator_id, action, outcome, occurred_at)
             VALUES ($1, 'provision', 'success', $2)`,
            [operator.id, input.at]
          );
          await client.query("COMMIT");
          return operator;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async rotateCredential(input) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await client.query<OperatorRow>(
            `UPDATE operators
             SET password_hash = $2,
                 password_salt = $3,
                 scrypt_version = $4,
                 scrypt_cost = $5,
                 credential_version = credential_version + 1,
                 updated_at = $6
             WHERE id = $1
             RETURNING id, canonical_login, display_login, active,
                       credential_version, created_at, updated_at`,
            [
              input.operatorId,
              input.passwordHash,
              input.passwordSalt,
              input.scryptVersion,
              input.scryptCost,
              input.at
            ]
          );
          if (!result.rows[0]) {
            await client.query("COMMIT");
            return null;
          }
          const operator = mapOperator(result.rows[0]);
          await client.query(
            `UPDATE operator_sessions
             SET revoked_at = $2
             WHERE operator_id = $1 AND revoked_at IS NULL`,
            [operator.id, input.at]
          );
          await client.query(
            `INSERT INTO operator_auth_events
              (operator_id, action, outcome, occurred_at)
             VALUES ($1, 'rotate', 'success', $2)`,
            [operator.id, input.at]
          );
          await client.query("COMMIT");
          return operator;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async disable(operatorId, at) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await client.query<OperatorRow>(
            `UPDATE operators
             SET active = false, updated_at = $2
             WHERE id = $1
             RETURNING id, canonical_login, display_login, active,
                       credential_version, created_at, updated_at`,
            [operatorId, at]
          );
          if (!result.rows[0]) {
            await client.query("COMMIT");
            return null;
          }
          const operator = mapOperator(result.rows[0]);
          await client.query(
            `UPDATE operator_sessions
             SET revoked_at = $2
             WHERE operator_id = $1 AND revoked_at IS NULL`,
            [operator.id, at]
          );
          await client.query(
            `INSERT INTO operator_auth_events
              (operator_id, action, outcome, occurred_at)
             VALUES ($1, 'disable', 'success', $2)`,
            [operator.id, at]
          );
          await client.query("COMMIT");
          return operator;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async list() {
        const result = await pool.query<OperatorRow>(
          `SELECT id, canonical_login, display_login, active,
                  credential_version, created_at, updated_at
           FROM operators
           ORDER BY canonical_login`
        );
        return result.rows.map(mapOperator);
      },

      async admitLoginAttempt(input) {
        if (!Number.isInteger(input.limit) || input.limit < 1) {
          throw new RangeError("operator_login_limit_out_of_range");
        }
        if (input.expiresAt <= input.at) {
          throw new RangeError("operator_login_expiry_out_of_range");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
            [input.subjectHash]
          );
          const usage = await client.query<{
            count: string;
            retry_at: Date | null;
          }>(
            `SELECT count(*)::text AS count, min(expires_at) AS retry_at
             FROM operator_login_attempts
             WHERE subject_hash = $1 AND expires_at > $2`,
            [input.subjectHash, input.at]
          );
          if (Number(usage.rows[0]!.count) >= input.limit) {
            const retryAt = usage.rows[0]!.retry_at;
            if (!retryAt) throw new Error("operator_login_retry_missing");
            await client.query("COMMIT");
            return { kind: "throttled" as const, retryAt };
          }
          await client.query(
            `INSERT INTO operator_login_attempts (subject_hash, expires_at)
             VALUES ($1, $2)`,
            [input.subjectHash, input.expiresAt]
          );
          await client.query("COMMIT");
          return { kind: "admitted" as const };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async appendEvent(input) {
        await pool.query(
          `INSERT INTO operator_auth_events
            (operator_id, action, outcome, occurred_at)
           VALUES ($1, $2, $3, $4)`,
          [input.operatorId, input.action, input.outcome, input.at]
        );
      },

      async issueSession(input) {
        const result = await pool.query<OperatorSessionRow>(
          `INSERT INTO operator_sessions
            (id, secret_digest, operator_id, credential_version, issued_at,
             last_used_at, idle_expires_at, absolute_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, operator_id, credential_version, issued_at,
                     last_used_at, idle_expires_at, absolute_expires_at,
                     revoked_at`,
          [
            input.sessionId,
            input.secretDigest,
            input.operatorId,
            input.credentialVersion,
            input.issuedAt,
            input.lastUsedAt,
            input.idleExpiresAt,
            input.absoluteExpiresAt
          ]
        );
        return mapOperatorSession(result.rows[0]!);
      },

      async useSession(input) {
        const result = await pool.query<UsedOperatorSessionRow>(
          `UPDATE operator_sessions AS session
           SET last_used_at = $3,
               idle_expires_at = LEAST($4::timestamptz, session.absolute_expires_at)
           FROM operators AS operator
           WHERE session.id = $1
             AND session.secret_digest = $2
             AND session.operator_id = operator.id
             AND operator.active = true
             AND session.credential_version = operator.credential_version
             AND session.revoked_at IS NULL
             AND session.idle_expires_at > $3
             AND session.absolute_expires_at > $3
           RETURNING session.id AS session_id,
                     session.operator_id AS session_operator_id,
                     session.credential_version AS session_credential_version,
                     session.issued_at, session.last_used_at,
                     session.idle_expires_at, session.absolute_expires_at,
                     session.revoked_at,
                     operator.id, operator.canonical_login, operator.display_login,
                     operator.active, operator.credential_version,
                     operator.created_at, operator.updated_at`,
          [input.sessionId, input.secretDigest, input.at, input.idleExpiresAt]
        );
        return result.rows[0] ? mapUsedOperatorSession(result.rows[0]) : null;
      },

      async revokeSession(sessionId, at) {
        await pool.query(
          `UPDATE operator_sessions
           SET revoked_at = $2
           WHERE id = $1 AND revoked_at IS NULL`,
          [sessionId, at]
        );
      },

      async cleanupExpired(at) {
        const sessions = await pool.query(
          `DELETE FROM operator_sessions
           WHERE revoked_at IS NOT NULL
              OR idle_expires_at <= $1
              OR absolute_expires_at <= $1`,
          [at]
        );
        const loginAttempts = await pool.query(
          "DELETE FROM operator_login_attempts WHERE expires_at <= $1",
          [at]
        );
        return {
          sessions: sessions.rowCount ?? 0,
          loginAttempts: loginAttempts.rowCount ?? 0
        };
      }
    },

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
                 display_name, class_name, level, raider_io_url,
                 guild_name, guild_region, guild_realm_slug)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                snapshotId,
                characterId,
                displayOrder,
                character.source,
                character.displayName,
                character.className,
                character.level,
                character.raiderIoUrl,
                character.guild?.name ?? null,
                character.guild?.region ?? null,
                character.guild?.realm ?? null
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

      async createAndFinishFingerprintSweep(
        input,
        fingerprint,
        cursor,
        options
      ) {
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
            limitationCode: fingerprint.limitationCode,
            continuationAdmission: fingerprint.continuationAdmission,
            cursor: {
              resumeAfter: cursor.resumeAfter,
              resumeLimitationCode:
                cursor.resumeAfter === null ? null : cursor.limitationCode,
              historicalGuilds: cursor.historicalGuilds,
              resumeSnapshotId:
                cursor.resumeAfter === null ? null : snapshot.id,
              advanced: cursor.advanced
            }
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

      async amendAndFinishFingerprintSweep(
        snapshotId,
        characters,
        fingerprint,
        cursor,
        options
      ) {
        if (Number.isNaN(fingerprint.finishedAt.valueOf())) {
          throw new RangeError("fingerprint_finish_time_invalid");
        }
        const client = await pool.connect();
        try {
          options?.signal?.throwIfAborted();
          await client.query("BEGIN");

          const rootResult = await client.query<{
            region: CharacterKey["region"];
            realm_slug: string;
            normalized_name: string;
          }>(
            `SELECT root.region, root.realm_slug, root.normalized_name
             FROM snapshots snapshot
             JOIN characters root ON root.id = snapshot.root_character_id
             WHERE snapshot.id = $1`,
            [snapshotId]
          );
          const rootRow = rootResult.rows[0];
          if (!rootRow) throw new Error("snapshot_not_found");
          await lockRoot(client, {
            region: rootRow.region,
            realm: rootRow.realm_slug,
            name: rootRow.normalized_name
          });
          await lockFingerprintSweeps(client);

          // Ownership, re-read under the root lock and before any write: a
          // fresh refresh for this root publishes its own snapshot and resets
          // the cursor, which makes this continuation's snapshot dead. Amending
          // it anyway would extend an orphan and, worse, overwrite the live
          // chain's cursor with this one's. Abort instead, touching neither the
          // snapshot nor the state row.
          const ownership = await client.query<{
            resume_snapshot_id: string | null;
            discovery_run_id: string | null;
          }>(
            `SELECT state.resume_snapshot_id, snapshot.discovery_run_id
             FROM fingerprint_sweep_states state
             LEFT JOIN snapshots snapshot
               ON snapshot.id = state.resume_snapshot_id
             WHERE state.region = $1
               AND state.realm_slug = $2
               AND state.normalized_name = $3`,
            [rootRow.region, rootRow.realm_slug, rootRow.normalized_name]
          );
          const owner = ownership.rows[0];
          if (
            !owner ||
            owner.resume_snapshot_id !== snapshotId ||
            owner.discovery_run_id !== fingerprint.runId
          ) {
            await client.query("ROLLBACK");
            return null;
          }

          const orderResult = await client.query<{ next_order: number }>(
            // Read under the lock: a concurrent amend that committed between
            // the snapshot lookup and the lock would otherwise hand this one a
            // stale `display_order` to reuse.
            `SELECT COALESCE(MAX(display_order) + 1, 0) AS next_order
             FROM snapshot_characters
             WHERE snapshot_id = $1`,
            [snapshotId]
          );

          const existing = await client.query<{
            region: string;
            realm_slug: string;
            normalized_name: string;
          }>(
            `SELECT character.region, character.realm_slug,
                    character.normalized_name
             FROM snapshot_characters membership
             JOIN characters character ON character.id = membership.character_id
             WHERE membership.snapshot_id = $1`,
            [snapshotId]
          );
          const present = new Set(
            existing.rows.map(
              (row) => `${row.region}/${row.realm_slug}/${row.normalized_name}`
            )
          );

          let displayOrder = Number(orderResult.rows[0]!.next_order);
          let appended = 0;
          for (const character of characters) {
            const id = `${character.key.region}/${character.key.realm}/${character.key.name}`;
            if (present.has(id)) continue;
            present.add(id);

            const upserted = await client.query<{ id: string }>(
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
            await client.query(
              `INSERT INTO snapshot_characters
                (snapshot_id, character_id, display_order, discovery_source,
                 display_name, class_name, level, raider_io_url,
                 guild_name, guild_region, guild_realm_slug)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                snapshotId,
                upserted.rows[0]!.id,
                displayOrder,
                character.source,
                character.displayName,
                character.className,
                character.level,
                character.raiderIoUrl,
                character.guild?.name ?? null,
                character.guild?.region ?? null,
                character.guild?.realm ?? null
              ]
            );
            displayOrder += 1;
            appended += 1;
          }

          await client.query(
            `UPDATE snapshots
             SET character_count = character_count + $2,
                 state = $3,
                 limitation_code = $4
             WHERE id = $1`,
            [
              snapshotId,
              appended,
              fingerprint.limitationCode === null ? "complete" : "partial",
              fingerprint.limitationCode
            ]
          );

          await finishFingerprintSweep(client, fingerprint.reservationId, {
            published: true,
            at: fingerprint.finishedAt,
            limitationCode: fingerprint.limitationCode,
            continuationAdmission: fingerprint.continuationAdmission,
            cursor: {
              resumeAfter: cursor.resumeAfter,
              resumeLimitationCode:
                cursor.resumeAfter === null ? null : cursor.limitationCode,
              historicalGuilds: cursor.historicalGuilds,
              resumeSnapshotId: cursor.resumeAfter === null ? null : snapshotId,
              advanced: cursor.advanced
            }
          });

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

      async getCurrentContainingCharacter(key) {
        const result = await pool.query<{ id: string }>(
          `SELECT snapshot.id
           FROM snapshots snapshot
           JOIN snapshot_characters membership
             ON membership.snapshot_id = snapshot.id
           JOIN characters character ON character.id = membership.character_id
           JOIN characters root ON root.id = snapshot.root_character_id
           JOIN discovery_runs run ON run.id = snapshot.discovery_run_id
           WHERE character.region = $1
             AND character.realm_slug = $2
             AND character.normalized_name = $3
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

      async listReverseDeclaredCharacters(key) {
        const result = await pool.query<SnapshotCharacterRow>(
          `WITH latest_snapshots AS (
             SELECT DISTINCT ON (snapshot.root_character_id)
               snapshot.id, snapshot.root_character_id
             FROM snapshots snapshot
             JOIN discovery_runs run ON run.id = snapshot.discovery_run_id
             WHERE run.status = 'complete'
             ORDER BY snapshot.root_character_id,
                      snapshot.refreshed_at DESC,
                      snapshot.id DESC
           )
           SELECT
             root_membership.character_id,
             root.region,
             root.realm_slug,
             root.normalized_name,
             root_membership.display_name,
             root_membership.class_name,
             root_membership.level,
             root_membership.raider_io_url,
             root_membership.guild_name,
             root_membership.guild_region,
             root_membership.guild_realm_slug,
             'declared_main' AS discovery_source,
             root_membership.display_order
           FROM latest_snapshots latest
           JOIN snapshot_characters edge
             ON edge.snapshot_id = latest.id
            AND edge.discovery_source = 'declared_main'
           JOIN characters declared_main ON declared_main.id = edge.character_id
           JOIN snapshot_characters root_membership
             ON root_membership.snapshot_id = latest.id
            AND root_membership.character_id = latest.root_character_id
           JOIN characters root ON root.id = latest.root_character_id
           WHERE declared_main.region = $1
             AND declared_main.realm_slug = $2
             AND declared_main.normalized_name = $3
             AND NOT EXISTS (
               SELECT 1 FROM snapshot_characters earlier_edge
               WHERE earlier_edge.snapshot_id = edge.snapshot_id
                 AND earlier_edge.discovery_source = 'declared_main'
                 AND earlier_edge.display_order < edge.display_order
             )
             AND (root.region, root.realm_slug, root.normalized_name)
                 <> ($1, $2, $3)
             AND NOT EXISTS (
               SELECT 1 FROM suppressed_characters suppression
               WHERE suppression.region = root.region
                 AND suppression.realm_slug = root.realm_slug
                 AND suppression.normalized_name = root.normalized_name
                 AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
             )
           ORDER BY root.region, root.realm_slug, root.normalized_name`,
          [key.region, key.realm, key.name]
        );
        return result.rows.map(mapSnapshotCharacter);
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

    manualConnections: {
      async listDiscoveredExclusions(root) {
        const result = await pool.query<{
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
        }>(
          `SELECT exclusion.region, exclusion.realm_slug, exclusion.normalized_name
             FROM dossier_character_exclusions exclusion
             JOIN characters owner ON owner.id = exclusion.root_character_id
            WHERE owner.region = $1 AND owner.realm_slug = $2
              AND owner.normalized_name = $3`,
          [root.region, root.realm, root.name]
        );
        return result.rows.map((row) => ({
          region: row.region,
          realm: row.realm_slug,
          name: row.normalized_name
        }));
      },
      async setDiscoveredExcluded(root, character, excluded) {
        const values = [
          root.region,
          root.realm,
          root.name,
          character.region,
          character.realm,
          character.name
        ];
        if (excluded) {
          const result = await pool.query(
            `INSERT INTO dossier_character_exclusions
               (root_character_id, region, realm_slug, normalized_name)
             SELECT id, $4, $5, $6 FROM characters
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
             ON CONFLICT DO NOTHING`,
            values
          );
          return result.rowCount === 1 ? "updated" : "missing";
        }
        await pool.query(
          `DELETE FROM dossier_character_exclusions exclusion USING characters owner
            WHERE exclusion.root_character_id = owner.id
              AND owner.region = $1 AND owner.realm_slug = $2
              AND owner.normalized_name = $3
              AND exclusion.region = $4 AND exclusion.realm_slug = $5
              AND exclusion.normalized_name = $6`,
          values
        );
        return "updated";
      },
      async add(root, character) {
        // The connected side is a key, so this records the link whether or not
        // the character has been discovered yet. Only the root must exist.
        const result = await pool.query(
          `INSERT INTO manual_dossier_connections
             (root_character_id, connected_region, connected_realm_slug,
              connected_normalized_name)
           SELECT root.id, $4, $5, $6
           FROM characters root
           WHERE root.region = $1
             AND root.realm_slug = $2
             AND root.normalized_name = $3
           ON CONFLICT DO NOTHING
           RETURNING root_character_id`,
          [
            root.region,
            root.realm,
            root.name,
            character.region,
            character.realm,
            character.name
          ]
        );
        return result.rowCount === 1 ? "added" : "duplicate";
      },

      async list(root) {
        const result = await pool.query<{
          region: string;
          realm_slug: string;
          normalized_name: string;
          display_name: string | null;
          class_name: string | null;
          level: number | null;
          raider_io_url: string | null;
          excluded: boolean;
        }>(
          // Left join: a connection linked before discovery has no character
          // row yet, and must still be listed so the dossier can show it as
          // being researched.
          `SELECT connection.connected_region AS region,
                  connection.connected_realm_slug AS realm_slug,
                  connection.connected_normalized_name AS normalized_name,
                  connected.display_name,
                  connected.class_name,
                  connected.level,
                  connected.raider_io_url,
                  connection.excluded_at IS NOT NULL AS excluded
           FROM manual_dossier_connections connection
           JOIN characters owner ON owner.id = connection.root_character_id
           LEFT JOIN characters connected
             ON connected.region = connection.connected_region
            AND connected.realm_slug = connection.connected_realm_slug
            AND connected.normalized_name = connection.connected_normalized_name
           WHERE owner.region = $1
             AND owner.realm_slug = $2
             AND owner.normalized_name = $3
             AND NOT EXISTS (
               SELECT 1 FROM suppressed_characters suppression
               WHERE suppression.region = connection.connected_region
                 AND suppression.realm_slug = connection.connected_realm_slug
                 AND suppression.normalized_name = connection.connected_normalized_name
                 AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
             )
           ORDER BY connection.created_at,
                    connection.connected_region,
                    connection.connected_realm_slug,
                    connection.connected_normalized_name`,
          [root.region, root.realm, root.name]
        );
        return result.rows.map((row) => {
          const key = {
            region: row.region as CharacterKey["region"],
            realm: row.realm_slug,
            name: row.normalized_name
          };
          return {
            key,
            displayName: row.display_name ?? row.normalized_name,
            className: row.class_name,
            // Level orders the dossier's characters. An undiscovered character
            // has none, and sorts last rather than claiming a rank.
            level: row.level ?? 0,
            raiderIoUrl: row.raider_io_url ?? toRaiderIoUrl(key),
            pending: row.display_name === null,
            excluded: row.excluded
          };
        });
      },

      async setExcluded(root, character, excluded) {
        const result = await pool.query(
          `UPDATE manual_dossier_connections connection
           SET excluded_at = CASE WHEN $7::boolean THEN now() ELSE NULL END
           FROM characters owner
           WHERE owner.id = connection.root_character_id
             AND owner.region = $1
             AND owner.realm_slug = $2
             AND owner.normalized_name = $3
             AND connection.connected_region = $4
             AND connection.connected_realm_slug = $5
             AND connection.connected_normalized_name = $6`,
          [
            root.region,
            root.realm,
            root.name,
            character.region,
            character.realm,
            character.name,
            excluded
          ]
        );
        return result.rowCount === 1 ? "updated" : "missing";
      },

      async remove(root, character) {
        // Only the link is deleted. The character row and every snapshot that
        // found it are shared with other dossiers and stay untouched.
        const result = await pool.query(
          `DELETE FROM manual_dossier_connections connection
           USING characters owner
           WHERE owner.id = connection.root_character_id
             AND owner.region = $1
             AND owner.realm_slug = $2
             AND owner.normalized_name = $3
             AND connection.connected_region = $4
             AND connection.connected_realm_slug = $5
             AND connection.connected_normalized_name = $6`,
          [
            root.region,
            root.realm,
            root.name,
            character.region,
            character.realm,
            character.name
          ]
        );
        return result.rowCount === 1 ? "removed" : "missing";
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
      async isDueForVisit(key, cadenceCutoff) {
        const result = await pool.query<{
          last_published_at: Date | null;
          resume_after: string | null;
        }>(
          `SELECT last_published_at, resume_after
           FROM fingerprint_sweep_states
           WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
          [key.region, key.realm, key.name]
        );
        const state = result.rows[0];
        return (
          (state?.resume_after ?? null) === null &&
          (state?.last_published_at === null ||
            state.last_published_at <= cadenceCutoff)
        );
      },

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
            !input.continuation &&
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
            input.at,
            input.continuation ? admissionId : undefined
          );
          // A continuation's run was completed by cycle 1 and must stay
          // complete: it has already published its snapshot, and reverting it
          // to `queued` both fails (no row matches) and would lie about a
          // finished dossier. Deferral for a continuation is carried entirely
          // by the re-enqueued admission job, not by the run's status.
          if (result.kind === "waiting" && !input.continuation) {
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
          // No cursor argument: this caller finishes a reservation without any
          // knowledge of the sweep chain, so it must not clear a cursor it does
          // not own. Only the create/amend paths, which computed the cursor
          // themselves, may write those columns.
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

      async getResumeState(key) {
        const result = await pool.query<{
          resume_after: string | null;
          resume_limitation_code: string | null;
          resume_historical_guilds: unknown;
          resume_snapshot_id: string | null;
          discovery_run_id: string | null;
        }>(
          `SELECT state.resume_after, state.resume_limitation_code,
                  state.resume_historical_guilds,
                  state.resume_snapshot_id, snapshot.discovery_run_id
           FROM fingerprint_sweep_states state
           LEFT JOIN snapshots snapshot
             ON snapshot.id = state.resume_snapshot_id
           WHERE state.region = $1
             AND state.realm_slug = $2
             AND state.normalized_name = $3`,
          [key.region, key.realm, key.name]
        );
        const row = result.rows[0];
        // `discovery_run_id` names the only run allowed to continue this chain.
        // Without it the cursor points at nothing amendable, so it reads as no
        // cursor at all rather than as a continuation nobody owns.
        if (!row?.resume_after || !row.resume_snapshot_id) return null;
        if (!row.discovery_run_id) return null;
        return {
          resumeAfter: row.resume_after,
          snapshotId: row.resume_snapshot_id,
          runId: row.discovery_run_id,
          limitationCode: row.resume_limitation_code,
          historicalGuilds: historicalGuildsFromDatabase(
            row.resume_historical_guilds
          )
        };
      },

      async recordContinuationFailure(key) {
        const result = await pool.query<{ continuation_failures: number }>(
          `UPDATE fingerprint_sweep_states
           SET continuation_failures = continuation_failures + 1
           WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
           RETURNING continuation_failures`,
          [key.region, key.realm, key.name]
        );
        // No state row means no cursor to be stuck on, so nothing to bound.
        return Number(result.rows[0]?.continuation_failures ?? 0);
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

          const state = await client.query<{
            last_published_at: Date | null;
            resume_after: string | null;
            discovery_run_id: string | null;
          }>(
            `SELECT state.last_published_at, state.resume_after,
                    snapshot.discovery_run_id
             FROM fingerprint_sweep_states state
             LEFT JOIN snapshots snapshot ON snapshot.id = state.resume_snapshot_id
             WHERE state.region = $1 AND state.realm_slug = $2
               AND state.normalized_name = $3`,
            [admission.region, admission.realm_slug, admission.normalized_name]
          );
          const liveContinuation =
            state.rows[0]?.resume_after !== null &&
            state.rows[0]?.discovery_run_id === runId;
          if (
            !liveContinuation &&
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
            at,
            liveContinuation ? admission.id : undefined
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
      async historicAliases(key) {
        const result = await pool.query<{
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
        }>(
          `SELECT alias.region, alias.realm_slug, alias.normalized_name
             FROM character_historic_aliases alias
             JOIN characters character ON character.id = alias.character_id
            WHERE character.region = $1 AND character.realm_slug = $2
              AND character.normalized_name = $3
            ORDER BY alias.created_at, alias.region, alias.realm_slug, alias.normalized_name`,
          [key.region, key.realm, key.name]
        );
        return result.rows.map((row) => ({
          region: row.region,
          realm: row.realm_slug,
          name: row.normalized_name
        }));
      },
      async addHistoricAlias(key, alias) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockCharacterEvidence(client, key);
          const result = await client.query(
            `INSERT INTO character_historic_aliases
               (character_id, region, realm_slug, normalized_name)
             SELECT id, $4, $5, $6 FROM characters
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
             ON CONFLICT DO NOTHING RETURNING character_id`,
            [
              key.region,
              key.realm,
              key.name,
              alias.region,
              alias.realm,
              alias.name
            ]
          );
          if (result.rowCount === 1) {
            await invalidateHistoricAliasKillScan(client, key);
            await requestHistoricAliasRecollection(client, key);
          }
          const exists =
            result.rowCount === 1
              ? true
              : (
                  await client.query(
                    `SELECT 1 FROM characters WHERE region = $1
                  AND realm_slug = $2 AND normalized_name = $3`,
                    [key.region, key.realm, key.name]
                  )
                ).rowCount === 1;
          await client.query("COMMIT");
          return result.rowCount === 1
            ? "added"
            : exists
              ? "duplicate"
              : "missing";
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      async removeHistoricAlias(key, alias) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockCharacterEvidence(client, key);
          const result = await client.query(
            `DELETE FROM character_historic_aliases alias USING characters character
              WHERE alias.character_id = character.id
                AND character.region = $1 AND character.realm_slug = $2
                AND character.normalized_name = $3
                AND alias.region = $4 AND alias.realm_slug = $5
                AND alias.normalized_name = $6`,
            [
              key.region,
              key.realm,
              key.name,
              alias.region,
              alias.realm,
              alias.name
            ]
          );
          if (result.rowCount === 1) {
            await invalidateHistoricAliasKillScan(client, key);
            await requestHistoricAliasRecollection(client, key);
          }
          await client.query("COMMIT");
          return result.rowCount === 1 ? "removed" : "missing";
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      async reserve({ key, freshnessCutoff, at, credentials, phasePlan }) {
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
          const aliasRecollection = await client.query(
            `SELECT 1 FROM character_alias_recollections
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
            [key.region, key.realm, key.name]
          );
          const aliasRecollectionPending = aliasRecollection.rowCount === 1;
          const completed = await loadCompletedEvidence(client, key);
          // Asked before the freshness check, not after it. A refresh forces a
          // run past the freshness window, so a caller reading fresh evidence
          // can be looking at a character that is being re-collected right now
          // -- and it has no other way to find that out.
          const active = await client.query<EvidenceRunRow>(
            `SELECT id, region, realm_slug, normalized_name, queue_job_id, status,
                    attempt, limitation_code, parse_limitation_code, retry_after_at, error_code, created_at, started_at,
                    completed_at, wcl_client_id_encrypted, wcl_client_secret_encrypted,
                    ${evidenceRunClassNameSql()}, ${evidenceRunModeSql()}
             FROM character_evidence_runs
             WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
               AND status IN ('queued', 'running', 'retrying')
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [key.region, key.realm, key.name]
          );
          const activeRun = active.rows[0]
            ? mapEvidenceRun(active.rows[0])
            : null;
          if (
            completed !== null &&
            completed.evidenceVersion !== undefined &&
            completed.evidenceVersion >= CURRENT_EVIDENCE_VERSION &&
            completed.run.completedAt !== null &&
            !aliasRecollectionPending &&
            isEvidenceFresh(
              completed.run.completedAt,
              completed.run.retryAfterAt,
              freshnessCutoff,
              at
            )
          ) {
            await client.query("COMMIT");
            return {
              kind: "fresh",
              run: completed.run,
              completed,
              active: activeRun
            } satisfies EvidenceReservationResult;
          }

          if (activeRun) {
            await client.query("COMMIT");
            return {
              kind: "active",
              run: activeRun,
              completed,
              active: activeRun
            } satisfies EvidenceReservationResult;
          }

          if (aliasRecollectionPending) {
            // An older active run may have re-marked stale tiers after the edit.
            // Clear them again at the reservation that will actually re-read
            // the aliases, then consume the request in the same transaction.
            await invalidateHistoricAliasKillScan(client, key);
            await client.query(
              `DELETE FROM character_alias_recollections
                WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
              [key.region, key.realm, key.name]
            );
          }

          const inserted = await client.query<EvidenceRunRow>(
            `INSERT INTO character_evidence_runs
              (region, realm_slug, normalized_name, wcl_client_id_encrypted, wcl_client_secret_encrypted)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, region, realm_slug, normalized_name, queue_job_id, status,
                       attempt, limitation_code, parse_limitation_code, retry_after_at, error_code, created_at, started_at,
                       completed_at, wcl_client_id_encrypted, wcl_client_secret_encrypted,
                       ${evidenceRunClassNameSql()}, ${evidenceRunModeSql()}`,
            [
              key.region,
              key.realm,
              key.name,
              credentials?.wclClientIdEncrypted ?? null,
              credentials?.wclClientSecretEncrypted ?? null
            ]
          );
          const reservedRun = mapEvidenceRun(inserted.rows[0]!);
          if (phasePlan && phasePlan.length > 0) {
            await client.query(
              `INSERT INTO character_evidence_run_phases
                 (run_id, phase_id, ordinal, state)
               SELECT $1, item.phase_id, item.ordinal, 'pending'
                 FROM unnest($2::text[]) WITH ORDINALITY
                   AS item(phase_id, ordinal)`,
              [reservedRun.id, phasePlan]
            );
          }
          await client.query("COMMIT");
          return {
            kind: "reserved",
            run: reservedRun,
            completed,
            active: reservedRun
          } satisfies EvidenceReservationResult;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async latestTierSearches(key, since) {
        if (Number.isNaN(since.valueOf())) {
          throw new RangeError("character_evidence_tier_search_time_invalid");
        }
        const result = await pool.query<{
          tier_search_raid_id: string;
          status: CharacterEvidenceRun["status"];
          created_at: Date;
        }>(
          `SELECT DISTINCT ON (tier_search_raid_id)
                  tier_search_raid_id, status, created_at
             FROM character_evidence_runs
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND mode = 'tier_search' AND created_at >= $4
            ORDER BY tier_search_raid_id, created_at DESC, id DESC`,
          [key.region, key.realm, key.name, since]
        );
        return result.rows.map((row) => ({
          raidId: row.tier_search_raid_id,
          status: row.status,
          createdAt: row.created_at
        }));
      },

      async reserveTierSearch({ key, raidId, at, searchedSince, phasePlan }) {
        if (
          Number.isNaN(at.valueOf()) ||
          Number.isNaN(searchedSince.valueOf())
        ) {
          throw new RangeError("character_evidence_reservation_time_invalid");
        }
        if (raidId.length === 0) {
          throw new RangeError("character_evidence_tier_search_raid_invalid");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockCharacterEvidence(client, key);
          const columns = `id, region, realm_slug, normalized_name, queue_job_id, status,
                    attempt, limitation_code, parse_limitation_code, retry_after_at, error_code, created_at, started_at,
                    completed_at, wcl_client_id_encrypted, wcl_client_secret_encrypted,
                    ${evidenceRunClassNameSql()}, ${evidenceRunModeSql()}`;
          // One run per character at a time, whatever its mode: the unique
          // index says so, and a search joining an ordinary run would quietly
          // search nothing.
          const active = await client.query<EvidenceRunRow>(
            `SELECT ${columns}
               FROM character_evidence_runs
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                AND status IN ('queued', 'running', 'retrying')
              ORDER BY created_at DESC, id DESC
              LIMIT 1`,
            [key.region, key.realm, key.name]
          );
          if (active.rows[0]) {
            await client.query("COMMIT");
            return { kind: "active", run: mapEvidenceRun(active.rows[0]) };
          }
          // Whatever became of it: a search that failed or found nothing was
          // still paid for, and repeating it on the next click is exactly the
          // spend the limit exists to stop.
          const recent = await client.query<EvidenceRunRow>(
            `SELECT ${columns}
               FROM character_evidence_runs
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                AND mode = 'tier_search' AND tier_search_raid_id = $4
                AND created_at >= $5
              ORDER BY created_at DESC, id DESC
              LIMIT 1`,
            [key.region, key.realm, key.name, raidId, searchedSince]
          );
          if (recent.rows[0]) {
            await client.query("COMMIT");
            return { kind: "recent", run: mapEvidenceRun(recent.rows[0]) };
          }
          // A tier search adds to evidence the character already has. With
          // none, the ordinary collection has to run first.
          const completed = await client.query(
            `SELECT 1 FROM character_evidence_runs
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                AND status IN ('complete', 'partial')
              LIMIT 1`,
            [key.region, key.realm, key.name]
          );
          if (completed.rowCount === 0) {
            await client.query("COMMIT");
            return { kind: "no_evidence" };
          }
          const inserted = await client.query<EvidenceRunRow>(
            `INSERT INTO character_evidence_runs
               (region, realm_slug, normalized_name, mode, tier_search_raid_id, created_at)
             VALUES ($1, $2, $3, 'tier_search', $4, $5)
             RETURNING ${columns}`,
            [key.region, key.realm, key.name, raidId, at]
          );
          const run = mapEvidenceRun(inserted.rows[0]!);
          if (phasePlan && phasePlan.length > 0) {
            await client.query(
              `INSERT INTO character_evidence_run_phases
                 (run_id, phase_id, ordinal, state)
               SELECT $1, item.phase_id, item.ordinal, 'pending'
                 FROM unnest($2::text[]) WITH ORDINALITY
                   AS item(phase_id, ordinal)`,
              [run.id, phasePlan]
            );
          }
          await client.query("COMMIT");
          return { kind: "reserved", run };
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
                  attempt, limitation_code, parse_limitation_code, retry_after_at, error_code, created_at, started_at,
                  completed_at, wcl_client_id_encrypted, wcl_client_secret_encrypted,
                  ${evidenceRunClassNameSql()}, ${evidenceRunModeSql()}
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
               started_at = COALESCE(started_at, now()), error_code = NULL,
               limitation_code = NULL
           WHERE id = $1
             AND attempt < $2
             AND status IN ('queued', 'running', 'retrying')
           RETURNING id, region, realm_slug, normalized_name, queue_job_id, status,
                     attempt, limitation_code, parse_limitation_code, retry_after_at, error_code, created_at, started_at,
                     completed_at, wcl_client_id_encrypted, wcl_client_secret_encrypted,
                     ${evidenceRunClassNameSql()}, ${evidenceRunModeSql()}`,
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

      async seedPhases(runId, phases) {
        if (phases.length === 0) return;
        const result = await pool.query(
          `INSERT INTO character_evidence_run_phases
             (run_id, phase_id, ordinal, state)
           SELECT $1, item.phase_id, item.ordinal, 'pending'
             FROM unnest($2::text[], $3::integer[]) AS item(phase_id, ordinal)
           ON CONFLICT (run_id, phase_id) DO NOTHING`,
          [
            runId,
            phases.map((phase) => phase.id),
            phases.map((phase) => phase.ordinal)
          ]
        );
        if ((result.rowCount ?? 0) !== phases.length) {
          const count = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM character_evidence_run_phases WHERE run_id = $1`,
            [runId]
          );
          if (Number(count.rows[0]?.count) !== phases.length) {
            throw new Error("character_evidence_phase_plan_conflict");
          }
        }
      },

      async recordPhaseTransitions(runId, phases) {
        for (const phase of phases) {
          const result = await pool.query(
            `UPDATE character_evidence_run_phases
                SET state = $3, started_at = $4, completed_at = $5,
                    limitation_code = $6
              WHERE run_id = $1 AND phase_id = $2
                AND EXISTS (
                  SELECT 1 FROM character_evidence_runs run
                   WHERE run.id = $1
                     AND run.status IN ('queued', 'running', 'retrying')
                )
                AND (
                  state = $3 OR
                  (state = 'pending' AND $3 IN ('active', 'skipped')) OR
                  (state = 'limited' AND $3 = 'active') OR
                  (state = 'active' AND $3 IN ('completed', 'limited', 'failed', 'cancelled'))
                )`,
            [
              runId,
              phase.id,
              phase.state,
              phase.startedAt,
              phase.completedAt,
              phase.limitationCode
            ]
          );
          if (result.rowCount !== 1)
            throw new Error("character_evidence_phase_not_found");
        }
      },

      async listPhases(runId) {
        const result = await pool.query<
          EvidenceRunPhase & { phase_id: string }
        >(
          `SELECT phase_id AS id, ordinal, state, started_at AS "startedAt",
                  completed_at AS "completedAt", limitation_code AS "limitationCode"
             FROM character_evidence_run_phases
            WHERE run_id = $1 ORDER BY ordinal`,
          [runId]
        );
        return result.rows;
      },

      async publish(runId, input) {
        // A partial run must name what it fell short of. There are three
        // answers, not one, and each was added by a run this guard had already
        // rejected: a history-scan limitation, a parse limitation, or a run
        // that deliberately did not scan at all.
        //
        // Requiring the history code alone rejected every parse-capped run
        // (#290). Requiring either code rejected every parse-only run whose
        // work fit inside its budget (#367) -- which is precisely the run a
        // nearly-finished character makes, so a character failed more reliably
        // the closer it came to being done.
        //
        // Add the reason here when a fourth way to be partial appears; a
        // partial that can name nothing really is a bug.
        const partialNamesNoReason =
          input.state === "partial" &&
          input.limitationCode === null &&
          input.parseLimitationCode === null &&
          input.scanSkipped !== true;
        if (
          Number.isNaN(input.completedAt.valueOf()) ||
          (input.state === "complete" && input.limitationCode !== null) ||
          partialNamesNoReason
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
          const activeKey = {
            region: activeRun.region,
            realm: activeRun.realm_slug,
            name: activeRun.normalized_name
          };
          // Raids this character is finished with. Collection no longer pages
          // into them, so for these raids "the run did not find it" no longer
          // means "it is gone" -- it means we deliberately did not look.
          const terminalKillRaidIds = new Set(
            (
              await client.query<{ raid_id: string }>(
                `SELECT raid_id
                   FROM character_terminal_tiers
                  WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                    AND domain = 'kills'
                    AND collection_version >= $4::integer`,
                [
                  activeKey.region,
                  activeKey.realm,
                  activeKey.name,
                  CURRENT_COLLECTION_VERSIONS.kills
                ]
              )
            ).rows.map((row) => row.raid_id)
          );
          const stored = await loadPositiveEvidenceForPartial(
            client,
            activeKey
          );
          // A partial publish carries everything forward, as it always has. A
          // complete one carries forward the terminal raids only: every other
          // raid keeps the existing contract, where a kill a complete run
          // stopped finding stops being claimed.
          const previous =
            input.state === "partial"
              ? stored
              : {
                  kills: stored.kills.filter((kill) =>
                    terminalKillRaidIds.has(kill.raidId)
                  ),
                  wipes: stored.wipes.filter((wipe) =>
                    terminalKillRaidIds.has(wipe.raidId)
                  )
                };
          // A complete publish must not resurrect kills the run no longer
          // found, but it must still carry forward parses for kills it did,
          // because collection skips fights it has already hydrated.
          const storedPerformance = await loadStoredPerformanceByFightUrl(
            client,
            activeKey
          );
          // When each fight's parses were actually read, so a fight this run
          // skipped keeps the time it was observed rather than being restamped
          // with this run's completion. A restamp would say every untouched
          // percentile was just re-checked, and make drift unmeasurable.
          const storedCollectedAt = new Map(
            (
              await client.query<{ fight_url: string; collected_at: Date }>(
                `SELECT k.fight_url, max(k.collected_at) AS collected_at
                   FROM character_mythic_kills k
                   JOIN character_evidence_runs r ON r.id = k.evidence_run_id
                  WHERE r.region = $1 AND r.realm_slug = $2
                    AND r.normalized_name = $3
                    AND r.status IN ('complete', 'partial')
                  GROUP BY k.fight_url`,
                [activeKey.region, activeKey.realm, activeKey.name]
              )
            ).rows.map((row) => [row.fight_url, row.collected_at] as const)
          );
          const storedHistoricRankLookups = new Map(
            (
              await client.query<{
                fight_url: string;
                historic_world_rank: number | null;
                historic_rank_checked_at: Date | null;
              }>(
                `SELECT DISTINCT ON (k.fight_url)
                        k.fight_url, k.historic_world_rank, k.historic_rank_checked_at
                   FROM character_mythic_kills k
                   JOIN character_evidence_runs r ON r.id = k.evidence_run_id
                  WHERE r.region = $1 AND r.realm_slug = $2
                    AND r.normalized_name = $3
                    AND r.status IN ('complete', 'partial')
                  ORDER BY k.fight_url, r.completed_at DESC NULLS LAST, r.id DESC`,
                [activeKey.region, activeKey.realm, activeKey.name]
              )
            ).rows.map((row) => [row.fight_url, row] as const)
          );
          const incomingFightUrls = new Set(
            input.kills.map((kill) => kill.fightUrl)
          );
          // When each fight's rankings were last asked about and answered.
          // Carried forward exactly like `collected_at`, and for the same
          // reason: a fight this run skipped was skipped *because* it had
          // already been answered, so restamping it with this run's
          // completion would be a claim it was re-read.
          const storedParsesReadAt = new Map(
            (
              await client.query<{ fight_url: string; parses_read_at: Date }>(
                `SELECT k.fight_url, max(k.parses_read_at) AS parses_read_at
                   FROM character_mythic_kills k
                   JOIN character_evidence_runs r ON r.id = k.evidence_run_id
                  WHERE r.region = $1 AND r.realm_slug = $2
                    AND r.normalized_name = $3
                    AND r.status IN ('complete', 'partial')
                    AND k.parses_read_at IS NOT NULL
                  GROUP BY k.fight_url`,
                [activeKey.region, activeKey.realm, activeKey.name]
              )
            ).rows.map((row) => [row.fight_url, row.parses_read_at] as const)
          );
          // Fights this run got a ranking answer about, whatever the answer
          // was. A fight answered with nothing is what makes the difference:
          // recorded, it stops being re-requested every run (#297).
          const parsedFightUrls = new Set(input.parsedFightUrls ?? []);
          const kills = new Map<string, (typeof incomingKills)[number]>(
            previous.kills.map((kill) => [
              kill.fightUrl,
              { kill, performance: parsePerformanceValues(kill.performance) }
            ])
          );
          for (const kill of incomingKills) {
            const stored =
              kills.get(kill.kill.fightUrl) ??
              (storedPerformance.has(kill.kill.fightUrl)
                ? {
                    kill: kill.kill,
                    performance: storedPerformance.get(kill.kill.fightUrl)!
                  }
                : undefined);
            kills.set(
              kill.kill.fightUrl,
              stored === undefined
                ? kill
                : {
                    kill: kill.kill,
                    performance: mergePerformanceValues(
                      stored.performance,
                      kill.performance
                    )
                  }
            );
          }
          const wipes = new Map<string, (typeof input.wipes)[number]>();
          for (const wipe of [...previous.wipes, ...input.wipes]) {
            wipes.set(wipe.fightUrl, wipe);
          }
          const tierBests = await loadStoredTierBestParses(client, {
            region: activeRun.region,
            realm: activeRun.realm_slug,
            name: activeRun.normalized_name
          });
          for (const tierBest of input.tierBests) {
            const key = `${tierBest.raidId}\0${tierBest.bossId}`;
            const stored = tierBests.get(key);
            const performance = parsePerformanceValues(tierBest.performance);
            tierBests.set(key, {
              tierBest,
              performance:
                stored === undefined
                  ? performance
                  : mergePerformanceValues(stored.performance, performance),
              // This run read the zone, so it is collected now. Rows this run
              // did not supply keep the time they were read: stamping the
              // run's own completion on a carried row would make a zone the
              // budget never reached look current, and it would never be read
              // again.
              collectedAt: input.completedAt
            });
          }
          for (const { kill, performance } of kills.values()) {
            await client.query(
              `INSERT INTO character_mythic_kills
                (evidence_run_id, source_fight_key, raid_id, raid_name, boss_id,
                 boss_name, journal_boss_id, boss_order, killed_at,
                 report_url, fight_url, guild_name, guild_region, guild_realm, uploader,
                 historic_world_rank, historic_rank_checked_at,
                 spec_name, spec_icon_url, damage_parse_state, damage_percentile, healing_parse_state,
                 healing_percentile, boss_damage_parse_state, boss_damage_percentile,
                 collected_at, parses_read_at)
               VALUES (${Array.from({ length: 27 }, (_, index) => `$${index + 1}`).join(", ")})`,
              [
                runId,
                kill.fightUrl,
                kill.raidId,
                kill.raidName,
                kill.bossId,
                kill.bossName,
                kill.journalBossId,
                kill.bossOrder,
                kill.killedAt,
                kill.reportUrl,
                kill.fightUrl,
                kill.guild?.name ?? null,
                kill.guild?.region ?? null,
                kill.guild?.realm ?? null,
                kill.uploader ?? null,
                kill.historicWorldRank ??
                  storedHistoricRankLookups.get(kill.fightUrl)
                    ?.historic_world_rank ??
                  null,
                kill.historicRankCheckedAt ??
                  storedHistoricRankLookups.get(kill.fightUrl)
                    ?.historic_rank_checked_at ??
                  null,
                performance.spec?.name ?? null,
                performance.spec?.iconUrl ?? null,
                performance.damage.state,
                performance.damage.percentile,
                performance.healing.state,
                performance.healing.percentile,
                performance.bossDamage.state,
                performance.bossDamage.percentile,
                // This run observed the fight only if it came back with it. A
                // fight carried forward keeps the time it was actually read,
                // so a percentile's age stays honest.
                incomingFightUrls.has(kill.fightUrl)
                  ? input.completedAt
                  : (storedCollectedAt.get(kill.fightUrl) ?? input.completedAt),
                // Only a fight this run actually asked about is restamped.
                // Everything else keeps the answer time it already had, and a
                // fight never asked about stays null.
                parsedFightUrls.has(kill.fightUrl)
                  ? input.completedAt
                  : (storedParsesReadAt.get(kill.fightUrl) ?? null)
              ]
            );
          }
          for (const {
            tierBest,
            performance,
            collectedAt
          } of tierBests.values()) {
            await client.query(
              `INSERT INTO character_tier_best_parses
                (evidence_run_id, raid_id, raid_name, boss_id, boss_name,
                 rankings_url, spec_name, spec_icon_url,
                 damage_parse_state, damage_percentile,
                 healing_parse_state, healing_percentile,
                 boss_damage_parse_state, boss_damage_percentile, collected_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
              [
                runId,
                tierBest.raidId,
                tierBest.raidName,
                tierBest.bossId,
                tierBest.bossName,
                tierBest.rankingsUrl,
                performance.spec?.name ?? null,
                performance.spec?.iconUrl ?? null,
                performance.damage.state,
                performance.damage.percentile,
                performance.healing.state,
                performance.healing.percentile,
                performance.bossDamage.state,
                performance.bossDamage.percentile,
                collectedAt
              ]
            );
          }
          for (const wipe of wipes.values()) {
            await client.query(
              `INSERT INTO character_mythic_wipes
                (evidence_run_id, raid_id, raid_name, boss_id, boss_name,
                 journal_boss_id, boss_order, attempted_at, report_url, fight_url,
                 guild_name, guild_realm, uploader)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
                wipe.fightUrl,
                wipe.guild?.name ?? null,
                wipe.guild?.realm ?? null,
                wipe.uploader ?? null
              ]
            );
          }
          for (const cuttingEdge of input.cuttingEdges ?? []) {
            await client.query(
              `INSERT INTO character_evidence_cutting_edges
                (evidence_run_id, achievement_id, completed_at)
               VALUES ($1, $2, $3)`,
              [runId, cuttingEdge.achievementId, cuttingEdge.completedAt]
            );
          }
          // The terminal publication marker belongs to this transaction, not
          // to the worker's finally block: evidence a reader can see must not
          // ever say its final phase is still pending after a crash.
          await client.query(
            `UPDATE character_evidence_run_phases
                SET state = CASE WHEN $3 = 'collection_failed' THEN 'failed' ELSE 'completed' END,
                    started_at = COALESCE(started_at, $2),
                    completed_at = $2,
                    limitation_code = CASE WHEN $3 = 'collection_failed' THEN $3 ELSE NULL END
              WHERE run_id = $1 AND phase_id = 'publication'`,
            [runId, input.completedAt, input.limitationCode]
          );
          const publication = await client.query(
            `UPDATE character_evidence_runs
             SET status = $2, limitation_code = $3, parse_limitation_code = $4,
                 parse_limitation_codes_seen = $8,
                 retry_after_at = $5, error_code = NULL, completed_at = $6, evidence_version = $7,
                 kill_scan_skipped = $9,
                 kill_scan_completed_at = CASE
                   WHEN $9 OR $3::text IS NOT NULL THEN kill_scan_completed_at
                   ELSE $6
                 END,
                 kill_scan_resume_page = CASE
                   WHEN $10 THEN $11::integer
                   ELSE kill_scan_resume_page
                 END,
                 kill_scan_resume_boundary_report_code = CASE
                   WHEN $10 THEN $12::text
                   ELSE kill_scan_resume_boundary_report_code
                 END,
                 ranked_backfill_cursor = CASE
                   WHEN $13 THEN $14::jsonb
                   ELSE ranked_backfill_cursor
                 END,
                 ranked_backfill_attempted = $13,
                 historic_alias_progress = CASE
                   WHEN $15 THEN $16::jsonb
                   ELSE historic_alias_progress
                 END,
                 wcl_client_id_encrypted = NULL, wcl_client_secret_encrypted = NULL
             WHERE id = $1 AND status IN ('queued', 'running', 'retrying')`,
            [
              runId,
              input.state,
              input.limitationCode,
              input.parseLimitationCode,
              input.retryAfterAt ?? null,
              input.completedAt,
              CURRENT_EVIDENCE_VERSION,
              // Empty, never null: a run that raised nothing is a different
              // fact from a run written before the column existed. A caller
              // that named only the code it was judged by recorded exactly
              // that, so it stands in for the list.
              input.parseLimitationCodesSeen ??
                (input.parseLimitationCode ? [input.parseLimitationCode] : []),
              input.scanSkipped ?? false,
              Object.hasOwn(input, "historyScanResumePage"),
              input.historyScanResumePage ?? null,
              input.historyScanResumeBoundaryReportCode ?? null,
              Object.hasOwn(input, "rankedBackfillCursor"),
              input.rankedBackfillCursor === undefined
                ? null
                : JSON.stringify(input.rankedBackfillCursor),
              Object.hasOwn(input, "historicAliasProgress"),
              JSON.stringify(input.historicAliasProgress ?? null)
            ]
          );
          if (publication.rowCount !== 1) {
            throw new Error("character_evidence_run_not_active");
          }
          // In the publication's own transaction: a stage that outlived the
          // publication it fed would be republished by a later attempt over
          // evidence already stored.
          await client.query(
            `DELETE FROM character_evidence_collections WHERE run_id = $1`,
            [runId]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async stageCollection(runId, payload) {
        const result = await pool.query(
          `INSERT INTO character_evidence_collections (run_id, payload)
           SELECT $1, $2::jsonb
           FROM character_evidence_runs
           WHERE id = $1 AND status IN ('queued', 'running', 'retrying')
           ON CONFLICT (run_id)
           DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
          [runId, JSON.stringify(payload)]
        );
        // Selecting from the run rather than inserting blind keeps a stage
        // from outliving the run it belongs to: a run this worker no longer
        // owns has nothing to republish.
        if (result.rowCount !== 1) {
          throw new Error("character_evidence_run_not_active");
        }
      },

      async stagedCollection(runId) {
        const result = await pool.query<{ payload: StagedEvidenceCollection }>(
          `SELECT payload FROM character_evidence_collections WHERE run_id = $1`,
          [runId]
        );
        return result.rows[0]?.payload ?? null;
      },

      async clearSettledCollectionStages() {
        const result = await pool.query(
          `DELETE FROM character_evidence_collections AS stage
           USING character_evidence_runs AS run
           WHERE run.id = stage.run_id
             AND run.status NOT IN ('queued', 'running', 'retrying')`
        );
        return result.rowCount ?? 0;
      },

      async fail(id, code) {
        if (code.length === 0)
          throw new RangeError("character_evidence_error_invalid");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await client.query<{ completed_at: Date }>(
            `UPDATE character_evidence_runs
             SET status = 'failed', error_code = $2, completed_at = now(),
                 wcl_client_id_encrypted = NULL, wcl_client_secret_encrypted = NULL
             WHERE id = $1 AND status IN ('queued', 'running', 'retrying')
             RETURNING completed_at`,
            [id, code]
          );
          if (result.rowCount !== 1)
            throw new Error("character_evidence_run_not_active");
          await client.query(
            `UPDATE character_evidence_run_phases
                SET state = 'failed',
                    started_at = COALESCE(started_at, $2),
                    completed_at = $2,
                    limitation_code = $3
              WHERE run_id = $1 AND phase_id = 'publication'`,
            [id, result.rows[0]!.completed_at, code]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async getCompleted(key) {
        return loadCompletedEvidence(pool, key);
      },

      async recordHistoricRankLookup(killId, rank, checkedAt) {
        await pool.query(
          `UPDATE character_mythic_kills AS kill
              SET historic_world_rank = COALESCE(kill.historic_world_rank, $2),
                  historic_rank_checked_at = COALESCE(kill.historic_rank_checked_at, $3)
             FROM character_evidence_runs AS run
            WHERE kill.id = $1
              AND kill.evidence_run_id = run.id
              AND run.status IN ('complete', 'partial')
              AND kill.historic_rank_checked_at IS NULL`,
          [killId, rank, checkedAt]
        );
      },

      async hydratedFightUrls(key, settledBefore) {
        const settledBeforeIso = settledBefore.toISOString();
        // Read through the same loader a dossier does, rather than restating
        // its scope in SQL. An earlier restatement matched every run ever, so
        // a parse surviving only on a superseded run suppressed collection of
        // a fight the dossier shows blank — and nothing then refilled it.
        const completed = await loadCompletedEvidence(pool, key);
        const hydrated = new Set(
          (completed?.kills ?? [])
            .filter(
              (kill) =>
                // A kill whose rankings have not settled is re-read rather
                // than left frozen at whatever it showed on the night. Its
                // percentile is still moving, so skipping it would freeze a
                // value we have reason to believe is wrong.
                kill.killedAt < settledBeforeIso &&
                (kill.performance.damage.state === "available" ||
                kill.performance.healing.state === "available" ||
                kill.performance.bossDamage.state === "available"
                  ? // Metrics collected before specialization support are not
                    // hydrated: the parse-tier version bump must let Warcraft
                    // Logs replace them with its now-available spec data.
                    kill.performance.spec !== null
                  : // Asked and answered with nothing is finished too. Without
                    // this half the parse budget goes on re-reading reports
                    // that have already said no -- and the hydration order
                    // sorts those failed groups to the front, so they are what
                    // it spends the budget on first (#297).
                    kill.parsesReadAt !== null)
            )
            .map((kill) => kill.fightUrl)
        );
        return [...hydrated].sort();
      },

      async collectedTierZones(key) {
        // Scoped exactly like `loadStoredTierBestParses`, which is the set
        // `publish` carries forward: a zone counts as collected only while its
        // rows survive into the next run's evidence. `completed_at` is the
        // run's, so a kill newer than it reopens the zone for collection.
        const result = await pool.query<{
          raid_id: string;
          collected_at: Date;
        }>(
          `SELECT t.raid_id, max(t.collected_at) AS collected_at
             FROM character_tier_best_parses t
             JOIN character_evidence_runs r ON r.id = t.evidence_run_id
            WHERE r.region = $1 AND r.realm_slug = $2 AND r.normalized_name = $3
              AND r.status IN ('complete', 'partial')
            GROUP BY t.raid_id`,
          [key.region, key.realm, key.name]
        );
        return result.rows
          .map((row) => [row.raid_id, row.collected_at.toISOString()] as const)
          .sort((a, b) => a[0].localeCompare(b[0]));
      },

      async storedEvidenceTiers(key, tierSearchRaidId) {
        // Read through the same loader a dossier does, so the scan can never
        // stop above evidence the dossier still shows.
        const completed = await loadCompletedEvidence(pool, key);
        const scan = await pool.query<{ completed_at: Date }>(
          `SELECT completed_at
             FROM character_evidence_runs
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND kill_scan_skipped = false
              AND kill_scan_completed_at IS NOT NULL
            ORDER BY kill_scan_completed_at DESC
            LIMIT 1`,
          [key.region, key.realm, key.name]
        );
        const resume = await pool.query<{
          kill_scan_resume_page: number | null;
          kill_scan_resume_boundary_report_code: string | null;
        }>(
          `SELECT kill_scan_resume_page, kill_scan_resume_boundary_report_code
             FROM character_evidence_runs
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND status IN ('complete', 'partial')
              AND kill_scan_skipped = false
            ORDER BY completed_at DESC, id DESC
            LIMIT 1`,
          [key.region, key.realm, key.name]
        );
        const ranked = tierSearchRaidId
          ? await pool.query<{
              ranked_backfill_cursor: StoredRankedBackfillCursor | null;
            }>(
              `SELECT ranked_backfill_cursor
                 FROM character_evidence_runs
                WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                  AND tier_search_raid_id = $4
                  AND status IN ('complete', 'partial')
                  AND ranked_backfill_attempted = true
                ORDER BY completed_at DESC, id DESC
                LIMIT 1`,
              [key.region, key.realm, key.name, tierSearchRaidId]
            )
          : null;
        const aliasProgress = await pool.query<{
          historic_alias_progress: HistoricAliasScanProgress[];
        }>(
          `SELECT historic_alias_progress
             FROM character_evidence_runs
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND status IN ('complete', 'partial')
              AND historic_alias_progress IS NOT NULL
            ORDER BY completed_at DESC, id DESC
            LIMIT 1`,
          [key.region, key.realm, key.name]
        );
        const scanTurn = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM character_evidence_runs
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND status IN ('complete', 'partial')
              AND kill_scan_skipped = false`,
          [key.region, key.realm, key.name]
        );
        return {
          kills: (completed?.kills ?? []).map((kill) => ({
            raidId: kill.raidId,
            raidName: kill.raidName,
            killedAt: kill.killedAt,
            reportUrl: kill.reportUrl
          })),
          wipes: (completed?.wipes ?? []).map((wipe) => ({
            raidId: wipe.raidId,
            raidName: wipe.raidName,
            attemptedAt: wipe.attemptedAt,
            reportUrl: wipe.reportUrl
          })),
          guilds: storedEvidenceGuilds(completed?.kills ?? [], key.region),
          ...(completed?.kills ? { parseOnlyKills: completed.kills } : {}),
          // Freshness answers whether a scan result can still be reused; the
          // newest publication answers whether there is parse work to resume.
          // Neither fact substitutes for the other. In particular, a clean
          // complete run must not turn a later manual refresh into a no-scan
          // attempt merely because its scan is recent.
          parseWorkOutstanding:
            completed?.run.limitationCode === null &&
            completed.run.parseLimitationCode !== null,
          ...(scan.rows[0]?.completed_at
            ? { lastCleanKillScanAt: scan.rows[0].completed_at.toISOString() }
            : {}),
          ...(resume.rows[0]?.kill_scan_resume_page
            ? { historyScanResumePage: resume.rows[0].kill_scan_resume_page }
            : {}),
          ...(resume.rows[0]?.kill_scan_resume_boundary_report_code
            ? {
                historyScanResumeBoundaryReportCode:
                  resume.rows[0].kill_scan_resume_boundary_report_code
              }
            : {}),
          historicAliasProgress:
            aliasProgress.rows[0]?.historic_alias_progress ?? [],
          identityScanTurn: Number(scanTurn.rows[0]?.count ?? 0),
          ...(ranked?.rows[0]?.ranked_backfill_cursor
            ? { rankedBackfillCursor: ranked.rows[0].ranked_backfill_cursor }
            : {})
        };
      },

      async terminalTiers(key) {
        const result = await pool.query<{
          raid_id: string;
          domain: EvidenceCollectionDomain;
        }>(
          `SELECT raid_id, domain
             FROM character_terminal_tiers
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND collection_version >= CASE domain
                    WHEN 'kills' THEN $4::integer
                    WHEN 'parses' THEN $5::integer
                    ELSE $6::integer
                  END
            ORDER BY raid_id, domain`,
          [
            key.region,
            key.realm,
            key.name,
            CURRENT_COLLECTION_VERSIONS.kills,
            CURRENT_COLLECTION_VERSIONS.parses,
            CURRENT_COLLECTION_VERSIONS.tier_bests
          ]
        );
        return result.rows.map((row) => ({
          raidId: row.raid_id,
          domain: row.domain
        }));
      },

      async recordWarcraftLogsCharacterId(key, characterId, at) {
        if (!Number.isSafeInteger(characterId) || characterId <= 0) {
          throw new RangeError("warcraft_logs_character_id_invalid");
        }
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("warcraft_logs_character_id_time_invalid");
        }
        await pool.query(
          `INSERT INTO warcraft_logs_character_ids
             (region, realm_slug, normalized_name, character_id, resolved_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (region, realm_slug, normalized_name)
           DO UPDATE SET character_id = EXCLUDED.character_id,
                         resolved_at = EXCLUDED.resolved_at`,
          [key.region, key.realm, key.name, characterId, at]
        );
      },

      async warcraftLogsCharacterId(key) {
        const result = await pool.query<{ character_id: number }>(
          `SELECT character_id
             FROM warcraft_logs_character_ids
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
          [key.region, key.realm, key.name]
        );
        return result.rows[0]?.character_id ?? null;
      },

      async markTerminalTiers(key, tiers, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("character_terminal_tier_time_invalid");
        }
        if (tiers.length === 0) return;
        await pool.query(
          `INSERT INTO character_terminal_tiers
             (region, realm_slug, normalized_name, raid_id, domain,
              collection_version, marked_at)
           SELECT $1, $2, $3, entry.raid_id,
                  entry.domain::evidence_collection_domain,
                  CASE entry.domain
                    WHEN 'kills' THEN $6::integer
                    WHEN 'parses' THEN $7::integer
                    ELSE $8::integer
                  END,
                  $9
             FROM unnest($4::text[], $5::text[]) AS entry(raid_id, domain)
           ON CONFLICT (region, realm_slug, normalized_name, raid_id, domain)
           DO UPDATE SET collection_version = EXCLUDED.collection_version,
                         marked_at = EXCLUDED.marked_at`,
          [
            key.region,
            key.realm,
            key.name,
            tiers.map((tier) => tier.raidId),
            tiers.map((tier) => tier.domain),
            CURRENT_COLLECTION_VERSIONS.kills,
            CURRENT_COLLECTION_VERSIONS.parses,
            CURRENT_COLLECTION_VERSIONS.tier_bests,
            at
          ]
        );
      },

      async clearTerminalTiers(key) {
        // Marks only. The stored kills, wipes and tier bests stay exactly where
        // they are: a rebuild must not leave a dossier empty while it waits for
        // the replacement evidence to arrive.
        const result = await pool.query(
          `DELETE FROM character_terminal_tiers
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
          [key.region, key.realm, key.name]
        );
        return result.rowCount ?? 0;
      },
      async emptyAttendanceSearches(key, searchedSince) {
        if (Number.isNaN(searchedSince.valueOf())) {
          throw new RangeError("character_attendance_search_time_invalid");
        }
        const result = await pool.query<{
          guild_region: string;
          guild_realm: string;
          guild_name: string;
          verified_at: Date;
        }>(
          `SELECT guild_region, guild_realm, guild_name, verified_at
             FROM character_attendance_searches
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND searched_at >= $4
              AND collection_version >= $5`,
          [
            key.region,
            key.realm,
            key.name,
            searchedSince,
            CURRENT_COLLECTION_VERSIONS.kills
          ]
        );
        return result.rows.map((row) => ({
          at: row.verified_at.toISOString(),
          guild: {
            name: row.guild_name,
            realm: row.guild_realm,
            region: row.guild_region
          }
        }));
      },

      async recordEmptyAttendanceSearches(key, searches, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("character_attendance_search_time_invalid");
        }
        if (searches.length === 0) return;
        await pool.query(
          `INSERT INTO character_attendance_searches
             (region, realm_slug, normalized_name, guild_region, guild_realm,
              guild_name, verified_at, collection_version, searched_at)
           SELECT $1, $2, $3, entry.guild_region, entry.guild_realm,
                  entry.guild_name, entry.verified_at, $8, $9
             FROM unnest($4::text[], $5::text[], $6::text[],
                         $7::timestamptz[])
                  AS entry(guild_region, guild_realm, guild_name, verified_at)
           ON CONFLICT (region, realm_slug, normalized_name, guild_region,
                        guild_realm, guild_name, verified_at)
           DO UPDATE SET collection_version = EXCLUDED.collection_version,
                         searched_at = EXCLUDED.searched_at`,
          [
            key.region,
            key.realm,
            key.name,
            searches.map((search) => search.guild.region),
            searches.map((search) => search.guild.realm),
            searches.map((search) => search.guild.name),
            searches.map((search) => new Date(search.at)),
            CURRENT_COLLECTION_VERSIONS.kills,
            at
          ]
        );
      },

      async listResumable(limit, at) {
        if (limit <= 0) return [];
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("character_evidence_resume_time_invalid");
        }
        // `latest` is each character's most recent completed run, picked the
        // same way `loadCompletedEvidence` picks it, so this and the dossier
        // read never disagree about which run speaks for a character.
        //
        // The `NOT EXISTS` is the whole of the in-flight guard: `reserve`
        // would return `active` for such a character and the sweep would do
        // nothing, so excluding it here saves the round trip rather than
        // changing the outcome.
        const result = await pool.query<{
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
        }>(
          `WITH latest AS (
             SELECT DISTINCT ON (region, realm_slug, normalized_name)
               region, realm_slug, normalized_name, retry_after_at AS due_at
             FROM character_evidence_runs
             WHERE status IN ('complete', 'partial')
             ORDER BY region, realm_slug, normalized_name,
               completed_at DESC, id DESC
           ), due AS (
             SELECT latest.region, latest.realm_slug, latest.normalized_name,
                    latest.due_at
               FROM latest
              WHERE latest.due_at IS NOT NULL AND latest.due_at <= $1
             UNION ALL
             SELECT region, realm_slug, normalized_name, requested_at AS due_at
               FROM character_alias_recollections
              WHERE requested_at <= $1
           )
           SELECT due.region, due.realm_slug, due.normalized_name
             FROM due
            WHERE NOT EXISTS (
               SELECT 1 FROM character_evidence_runs active
               WHERE active.region = due.region
                 AND active.realm_slug = due.realm_slug
                 AND active.normalized_name = due.normalized_name
                 AND active.status IN ('queued', 'running', 'retrying')
             )
            GROUP BY due.region, due.realm_slug, due.normalized_name
            ORDER BY min(due.due_at)
            LIMIT $2`,
          [at, limit]
        );
        return result.rows.map((row) => ({
          region: row.region,
          realm: row.realm_slug,
          name: row.normalized_name
        }));
      },

      async listStatus(keys) {
        if (keys.length === 0) return [];
        const result = await pool.query<EvidenceRunRow>(
          `SELECT DISTINCT ON (run.region, run.realm_slug, run.normalized_name)
             run.id, run.region, run.realm_slug, run.normalized_name,
             run.queue_job_id, run.status, run.attempt, run.limitation_code,
             run.parse_limitation_code,
             run.error_code, run.created_at, run.started_at, run.completed_at,
             run.wcl_client_id_encrypted, run.wcl_client_secret_encrypted,
             ${evidenceRunClassNameSql("run")}, ${evidenceRunModeSql("run")}
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
      },

      async recordLimitation(runId, code) {
        if (code.length === 0) {
          throw new RangeError("character_evidence_limitation_invalid");
        }
        await pool.query(
          `UPDATE character_evidence_runs
           SET limitation_code = $2
           WHERE id = $1 AND status IN ('queued', 'running', 'retrying')`,
          [runId, code]
        );
      },

      async clearStaleCredentials(cutoffs) {
        if (
          Number.isNaN(cutoffs.settled.valueOf()) ||
          Number.isNaN(cutoffs.active.valueOf())
        ) {
          throw new RangeError("character_evidence_credential_cutoff_invalid");
        }
        // A run still in the active set keeps its credentials for the longer
        // window: it may simply be waiting out a points-budget deferral, and a
        // run stripped mid-flight does not fail -- it quietly spends the
        // worker's shared allowance instead of the visitor's.
        const result = await pool.query(
          `UPDATE character_evidence_runs
           SET wcl_client_id_encrypted = NULL, wcl_client_secret_encrypted = NULL
           WHERE created_at < CASE
                   WHEN status IN ('queued', 'running', 'retrying')
                     THEN $2::timestamptz
                   ELSE $1::timestamptz
                 END
             AND (wcl_client_id_encrypted IS NOT NULL OR wcl_client_secret_encrypted IS NOT NULL)`,
          [cutoffs.settled, cutoffs.active]
        );
        return result.rowCount ?? 0;
      },

      async listForMonitor() {
        const result = await pool.query<{
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
          status: CharacterEvidenceRun["status"];
          evidence_version: number;
          attempt: number;
          limitation_code: string | null;
          parse_limitation_code: string | null;
          retry_after_at: Date | null;
          error_code: string | null;
          started_at: Date | null;
          completed_at: Date | null;
        }>(
          `SELECT region, realm_slug, normalized_name, status,
                  evidence_version, attempt, limitation_code,
                  parse_limitation_code, retry_after_at, error_code,
                  started_at, completed_at
             FROM character_evidence_runs
            ORDER BY CASE
                       WHEN status IN ('queued', 'running', 'retrying') THEN 0
                       WHEN status IN ('complete', 'partial') THEN 1
                       ELSE 2
                     END,
                     CASE WHEN status IN ('queued', 'running', 'retrying')
                       THEN COALESCE(started_at, created_at)
                     END ASC NULLS LAST,
                     completed_at DESC NULLS LAST,
                     id DESC`
        );
        return result.rows.map((row) => ({
          key: {
            region: row.region,
            realm: row.realm_slug,
            name: row.normalized_name
          },
          status: row.status,
          evidenceVersion: row.evidence_version,
          attempt: row.attempt,
          limitationCode: row.limitation_code,
          parseLimitationCode: row.parse_limitation_code,
          retryAfterAt: row.retry_after_at,
          errorCode: row.error_code,
          startedAt: row.started_at,
          completedAt: row.completed_at
        }));
      },

      async listActive(limit) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
          throw new RangeError("character_evidence_active_limit_out_of_range");
        }
        const result = await pool.query<{
          id: string;
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
          queue_job_id: string | null;
          started_at: Date | null;
          created_at: Date;
        }>(
          `SELECT id, region, realm_slug, normalized_name,
                  queue_job_id, started_at, created_at
           FROM character_evidence_runs
           WHERE status IN ('queued', 'running', 'retrying')
           ORDER BY created_at, id
           LIMIT $1`,
          [limit]
        );
        return result.rows.map((row) => ({
          runId: row.id,
          key: {
            region: row.region,
            realm: row.realm_slug,
            name: row.normalized_name
          },
          queueJobId: row.queue_job_id,
          startedAt: row.started_at,
          createdAt: row.created_at
        }));
      },

      async recordRunCost(cost) {
        if (!Number.isInteger(cost.attempt) || cost.attempt < 1) {
          throw new RangeError("character_evidence_run_cost_attempt_invalid");
        }
        // Upserted rather than inserted: an attempt re-entered after a crash
        // writes the cost of the work it actually did, and a primary-key
        // violation here would surface as a lost run rather than a lost row.
        await pool.query(
          `INSERT INTO character_evidence_run_costs (
             run_id, attempt, outcome, credentials,
             limitation_code, parse_limitation_code,
             points_spent, points_limit_per_hour,
             points_remaining_before, points_remaining_after,
             request_cap_used, parse_request_cap_used,
             history_scan_requests, zone_rankings_requests,
             fight_parses_requests, ranking_identities_requests,
             guild_attendance_requests, report_hydration_requests,
             raiderio_historic_outcome, raiderio_historic_ms,
             verified_kills_searched, attendance_recovered_kills,
             verified_kills_skipped_empty,
             mode, character_guilds_requests, tier_search_raid_id,
             tier_search_outcome, tier_search_requests, tier_search_guilds,
             tier_search_reports_hydrated, tier_search_recovered_kills,
             tier_search_recovered_wipes
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
                   $23, $24, $25, $26, $27, $28, $29, $30, $31, $32)
           ON CONFLICT (run_id, attempt) DO UPDATE SET
             recorded_at = now(),
             outcome = EXCLUDED.outcome,
             credentials = EXCLUDED.credentials,
             limitation_code = EXCLUDED.limitation_code,
             parse_limitation_code = EXCLUDED.parse_limitation_code,
             points_spent = EXCLUDED.points_spent,
             points_limit_per_hour = EXCLUDED.points_limit_per_hour,
             points_remaining_before = EXCLUDED.points_remaining_before,
             points_remaining_after = EXCLUDED.points_remaining_after,
             request_cap_used = EXCLUDED.request_cap_used,
             parse_request_cap_used = EXCLUDED.parse_request_cap_used,
             history_scan_requests = EXCLUDED.history_scan_requests,
             zone_rankings_requests = EXCLUDED.zone_rankings_requests,
             fight_parses_requests = EXCLUDED.fight_parses_requests,
             ranking_identities_requests = EXCLUDED.ranking_identities_requests,
             guild_attendance_requests = EXCLUDED.guild_attendance_requests,
             report_hydration_requests = EXCLUDED.report_hydration_requests,
             raiderio_historic_outcome = EXCLUDED.raiderio_historic_outcome,
             raiderio_historic_ms = EXCLUDED.raiderio_historic_ms,
             verified_kills_searched = EXCLUDED.verified_kills_searched,
             attendance_recovered_kills = EXCLUDED.attendance_recovered_kills,
             verified_kills_skipped_empty = EXCLUDED.verified_kills_skipped_empty,
             mode = EXCLUDED.mode,
             character_guilds_requests = EXCLUDED.character_guilds_requests,
             tier_search_raid_id = EXCLUDED.tier_search_raid_id,
             tier_search_outcome = EXCLUDED.tier_search_outcome,
             tier_search_requests = EXCLUDED.tier_search_requests,
             tier_search_guilds = EXCLUDED.tier_search_guilds,
             tier_search_reports_hydrated = EXCLUDED.tier_search_reports_hydrated,
             tier_search_recovered_kills = EXCLUDED.tier_search_recovered_kills,
             tier_search_recovered_wipes = EXCLUDED.tier_search_recovered_wipes`,
          [
            cost.runId,
            cost.attempt,
            cost.outcome,
            cost.credentials,
            cost.limitationCode,
            cost.parseLimitationCode,
            cost.pointsSpent,
            cost.pointsLimitPerHour,
            cost.pointsRemainingBefore,
            cost.pointsRemainingAfter,
            cost.requestCapUsed,
            cost.parseRequestCapUsed,
            cost.requests.historyScan,
            cost.requests.zoneRankings,
            cost.requests.fightParses,
            cost.requests.rankingIdentities,
            cost.requests.guildAttendance,
            cost.requests.reportHydration,
            cost.recovery.raiderIoOutcome,
            cost.recovery.raiderIoMs,
            cost.recovery.verifiedKillsSearched,
            cost.recovery.recoveredKills,
            cost.recovery.verifiedKillsSkippedEmpty,
            cost.mode ?? "full",
            cost.requests.characterGuilds ?? 0,
            cost.tierSearch?.raidId ?? null,
            cost.tierSearch?.outcome ?? null,
            cost.tierSearch?.requests ?? null,
            cost.tierSearch?.guilds ?? null,
            cost.tierSearch?.reportsHydrated ?? null,
            cost.tierSearch?.recoveredKills ?? null,
            cost.tierSearch?.recoveredWipes ?? null
          ]
        );
      },

      async clearExpiredRunCosts(cutoff) {
        if (Number.isNaN(cutoff.valueOf())) {
          throw new RangeError("character_evidence_run_cost_cutoff_invalid");
        }
        const result = await pool.query(
          `DELETE FROM character_evidence_run_costs WHERE recorded_at < $1`,
          [cutoff]
        );
        return result.rowCount ?? 0;
      },

      async releaseAbandoned(runIds) {
        if (runIds.length === 0) return 0;
        // Same columns `fail` writes, for the same reason: `failed` is in
        // neither the active set nor `loadCompletedEvidence`, so the character
        // falls back to its previous evidence and the next read reserves a
        // fresh run. The status guard is what makes this lose the race to a
        // publication rather than overwrite it.
        const result = await pool.query(
          `UPDATE character_evidence_runs
           SET status = 'failed', error_code = 'abandoned', completed_at = now(),
               wcl_client_id_encrypted = NULL, wcl_client_secret_encrypted = NULL
           WHERE id = ANY($1::uuid[])
             AND status IN ('queued', 'running', 'retrying')`,
          [runIds]
        );
        return result.rowCount ?? 0;
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
