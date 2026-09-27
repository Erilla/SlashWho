import type { PublicErrorCode } from "@slashwho/contracts";
import type { CharacterKey } from "@slashwho/domain";
import type {
  Account,
  AccountSummary,
  CallerClass,
  CharacterEvidenceRun,
  CharacterMythicKillParseMetric,
  CharacterMythicKillPerformance,
  DiscoveryRun,
  EvidenceRunMode,
  Operator,
  OperatorCredential,
  OperatorSession,
  StoredCharacterMythicKill,
  StoredCharacterMythicWipe,
  StoredCharacterTierBestParse,
  StoredSnapshot,
  StoredSnapshotCharacter
} from "./repositories";

export interface RunRow {
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

export interface OperatorRow {
  id: string;
  canonical_login: string;
  display_login: string;
  active: boolean;
  credential_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface AccountRow {
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

export type AccountCredentialRow = AccountRow & {
  password_hash: string;
  password_salt: string;
  scrypt_version: number;
  scrypt_cost: number;
};

export function mapAccountCredential(row: AccountCredentialRow) {
  return {
    ...mapAccount(row),
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    scryptVersion: row.scrypt_version,
    scryptCost: row.scrypt_cost
  };
}

export function mapAccount(row: AccountRow): Account {
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

export function mapAccountSummary(row: AccountRow): AccountSummary {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    active: row.active,
    verifiedAt: row.verified_at,
    createdAt: row.created_at
  };
}

export interface OperatorCredentialRow extends OperatorRow {
  password_hash: string;
  password_salt: string;
  scrypt_version: number;
  scrypt_cost: number;
}

export interface OperatorSessionRow {
  id: string;
  operator_id: string;
  credential_version: number;
  issued_at: Date;
  last_used_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}

export interface UsedOperatorSessionRow extends OperatorRow {
  session_id: string;
  session_operator_id: string;
  session_credential_version: number;
  issued_at: Date;
  last_used_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}

export interface SnapshotRow {
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

export interface SnapshotCharacterRow {
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

export function mapSnapshotCharacter(
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

export interface EvidenceRunRow {
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
  omitted_invalid_timestamp: boolean;
  parse_limitation_codes_seen?: string[] | null;
  light_refresh?: boolean;
  retry_after_at: Date | null;
  error_code: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  wcl_client_id_encrypted: string | null;
  wcl_client_secret_encrypted: string | null;
  account_credential_owner_id?: string | null;
  account_credential_version?: number | null;
  class_name: string | null;
  mode?: EvidenceRunMode;
  tier_search_raid_id?: string | null;
  publication_scope?: "full" | "tier";
}

export interface CharacterMythicKillRow {
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

export interface CharacterTierBestParseRow {
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

export interface CharacterMythicWipeRow {
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

export function mapRun(row: RunRow): DiscoveryRun {
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

export function mapOperator(row: OperatorRow): Operator {
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

export function mapOperatorCredential(
  row: OperatorCredentialRow
): OperatorCredential {
  return {
    ...mapOperator(row),
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    scryptVersion: row.scrypt_version,
    scryptCost: row.scrypt_cost
  };
}

export function mapOperatorSession(row: OperatorSessionRow): OperatorSession {
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

export function mapUsedOperatorSession(row: UsedOperatorSessionRow): {
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
  return `${alias}.mode, ${alias}.tier_search_raid_id, ${alias}.omitted_invalid_timestamp, ${alias}.parse_limitation_codes_seen, ${alias}.light_refresh`;
}

const evidenceRunColumnNames = [
  "id",
  "region",
  "realm_slug",
  "normalized_name",
  "queue_job_id",
  "status",
  "attempt",
  "limitation_code",
  "parse_limitation_code",
  "retry_after_at",
  "error_code",
  "created_at",
  "started_at",
  "completed_at",
  "wcl_client_id_encrypted",
  "wcl_client_secret_encrypted",
  "account_credential_owner_id",
  "account_credential_version"
] as const;

// Every column `mapEvidenceRun` reads, in one place. `pool.query<Row>` is an
// unchecked assertion, so a query that hand-copied this list and dropped a
// column still compiled: listStatus once lost retry_after_at and returned a
// run whose deadline was undefined.
export function evidenceRunColumns(alias = "character_evidence_runs"): string {
  const columns = evidenceRunColumnNames
    .map((column) => `${alias}.${column}`)
    .join(", ");
  return `${columns}, ${evidenceRunClassNameSql(alias)}, ${evidenceRunModeSql(alias)}`;
}

export function mapEvidenceRun(row: EvidenceRunRow): CharacterEvidenceRun {
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
    omittedInvalidTimestamp: row.omitted_invalid_timestamp,
    ...(row.parse_limitation_codes_seen?.length
      ? { parseLimitationCodesSeen: row.parse_limitation_codes_seen }
      : {}),
    ...(row.light_refresh ? { lightRefresh: true } : {}),
    retryAfterAt: row.retry_after_at,
    errorCode: row.error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    wclClientIdEncrypted: row.wcl_client_id_encrypted,
    wclClientSecretEncrypted: row.wcl_client_secret_encrypted,
    accountCredentialOwnerId: row.account_credential_owner_id ?? null,
    accountCredentialVersion: row.account_credential_version ?? null,
    className: row.class_name,
    mode: row.mode ?? "full",
    tierSearchRaidId: row.tier_search_raid_id ?? null
  };
}

export function mapCharacterMythicKill(
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

export function mapParseMetric(
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

export function parsePerformanceValues(performance: unknown): {
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

export function mapCharacterTierBestParse(
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

export const tierBestParseColumns = `id, raid_id, raid_name, boss_id, boss_name,
            rankings_url, spec_name, spec_icon_url,
            damage_parse_state, damage_percentile,
            healing_parse_state, healing_percentile,
            boss_damage_parse_state, boss_damage_percentile`;

export function mapCharacterMythicWipe(
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
