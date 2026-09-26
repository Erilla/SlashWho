import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
};

/** Shared with the operator-login canonicalizer; canonical logins are ASCII. */
export const operatorCanonicalLoginMaxLength = 64;

export const discoveryRunStatus = pgEnum("discovery_run_status", [
  "queued",
  "running",
  "retrying",
  "complete",
  "failed"
]);

export const callerClass = pgEnum("caller_class", ["anonymous", "bot"]);

export const snapshotState = pgEnum("snapshot_state", ["complete", "partial"]);

export const discoverySource = pgEnum("discovery_source", [
  "input",
  "claimed",
  "declared_main",
  "profile_guess",
  "fingerprint"
]);

export const characterEvidenceRunStatus = pgEnum(
  "character_evidence_run_status",
  ["queued", "running", "retrying", "complete", "partial", "failed"]
);

export const characterMythicKillParseState = pgEnum(
  "character_mythic_kill_parse_state",
  ["available", "not_applicable", "unavailable"]
);

/**
 * The parts of a character's Warcraft Logs evidence that settle independently.
 * Each carries its own collection version, so a parse fix re-collects parses
 * without also re-collecting kills and tier bests.
 */
export const evidenceCollectionDomain = pgEnum("evidence_collection_domain", [
  "kills",
  "parses",
  "tier_bests"
]);

export const characters = pgTable(
  "characters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    displayName: text("display_name").notNull(),
    className: text("class_name").notNull(),
    level: integer("level").notNull(),
    raiderIoUrl: text("raider_io_url").notNull(),
    ...timestamps
  },
  (table) => [
    uniqueIndex("characters_canonical_key_idx").on(
      table.region,
      table.realmSlug,
      table.normalizedName
    )
  ]
);

export const discoveryRuns = pgTable(
  "discovery_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    rootRegion: text("root_region").notNull(),
    rootRealmSlug: text("root_realm_slug").notNull(),
    rootNormalizedName: text("root_normalized_name").notNull(),
    rootCharacterId: uuid("root_character_id").references(() => characters.id),
    queueJobId: text("queue_job_id"),
    status: discoveryRunStatus("status").default("queued").notNull(),
    callerClass: callerClass("caller_class").notNull(),
    attempt: integer("attempt").default(0).notNull(),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    snapshotId: uuid("snapshot_id").references((): AnyPgColumn => snapshots.id)
  },
  (table) => [
    uniqueIndex("discovery_runs_one_active_root_idx")
      .on(table.rootRegion, table.rootRealmSlug, table.rootNormalizedName)
      .where(sql`${table.status} in ('queued', 'running', 'retrying')`)
  ]
);

export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    rootCharacterId: uuid("root_character_id")
      .notNull()
      .references(() => characters.id),
    discoveryRunId: uuid("discovery_run_id")
      .notNull()
      .references(() => discoveryRuns.id),
    state: snapshotState("state").notNull(),
    limitationCode: text("limitation_code"),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull(),
    characterCount: integer("character_count").notNull()
  },
  (table) => [
    uniqueIndex("snapshots_discovery_run_idx").on(table.discoveryRunId),
    index("snapshots_root_refreshed_idx").on(
      table.rootCharacterId,
      table.refreshedAt
    ),
    check(
      "snapshots_state_limitation_check",
      sql`(${table.state} = 'complete' AND ${table.limitationCode} IS NULL) OR (${table.state} = 'partial' AND ${table.limitationCode} IS NOT NULL)`
    )
  ]
);

export const snapshotCharacters = pgTable(
  "snapshot_characters",
  {
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id),
    displayOrder: integer("display_order").notNull(),
    discoverySource: discoverySource("discovery_source").notNull(),
    displayName: text("display_name").notNull(),
    className: text("class_name").notNull(),
    level: integer("level").notNull(),
    // The guild as at this snapshot. Nullable because a character can be
    // guildless, and because snapshots written before this column existed
    // carry no guild at all.
    guildName: text("guild_name"),
    guildRegion: text("guild_region"),
    guildRealmSlug: text("guild_realm_slug"),
    raiderIoUrl: text("raider_io_url").notNull()
  },
  (table) => [
    uniqueIndex("snapshot_characters_membership_idx").on(
      table.snapshotId,
      table.characterId
    ),
    index("snapshot_characters_character_idx").on(table.characterId),
    uniqueIndex("snapshot_characters_display_order_idx").on(
      table.snapshotId,
      table.displayOrder
    )
  ]
);

/**
 * The connected side is stored as a character key rather than a row reference,
 * so a reviewer can link a character before it has been discovered. Reading a
 * connection left-joins `characters` on that key: the row appears as soon as
 * discovery creates it, and no placeholder character has to be invented.
 *
 * Self-connection is guarded in the dossier service; a CHECK constraint cannot
 * compare the root's id against the connected key across tables.
 */
export const manualDossierConnections = pgTable(
  "manual_dossier_connections",
  {
    rootCharacterId: uuid("root_character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    connectedRegion: text("connected_region").notNull(),
    connectedRealmSlug: text("connected_realm_slug").notNull(),
    connectedNormalizedName: text("connected_normalized_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * When a reviewer hid this character from the dossier evidence. A timestamp
     * rather than a flag, so the moment the exclusion was made is recoverable.
     */
    excludedAt: timestamp("excluded_at", { withTimezone: true })
  },
  (table) => [
    primaryKey({
      name: "manual_dossier_connections_pkey",
      columns: [
        table.rootCharacterId,
        table.connectedRegion,
        table.connectedRealmSlug,
        table.connectedNormalizedName
      ]
    })
  ]
);

/** Explicit former names owned by a connected character, never dossier rows. */
export const characterHistoricAliases = pgTable(
  "character_historic_aliases",
  {
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({
      name: "character_historic_aliases_pkey",
      columns: [
        table.characterId,
        table.region,
        table.realmSlug,
        table.normalizedName
      ]
    })
  ]
);

/** Dossier-local evidence exclusions for characters found in a snapshot. */
export const dossierCharacterExclusions = pgTable(
  "dossier_character_exclusions",
  {
    rootCharacterId: uuid("root_character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({
      name: "dossier_character_exclusions_pkey",
      columns: [
        table.rootCharacterId,
        table.region,
        table.realmSlug,
        table.normalizedName
      ]
    })
  ]
);

/** Alias edits awaiting a fresh run, including those made during an active run. */
export const characterAliasRecollections = pgTable(
  "character_alias_recollections",
  {
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({
      name: "character_alias_recollections_pkey",
      columns: [table.region, table.realmSlug, table.normalizedName]
    })
  ]
);

export const suppressedCharacters = pgTable(
  "suppressed_characters",
  {
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
  },
  (table) => [
    primaryKey({
      name: "suppressed_characters_pkey",
      columns: [table.region, table.realmSlug, table.normalizedName]
    }),
    index("suppressed_characters_expiry_idx").on(table.expiresAt)
  ]
);

/**
 * One row per searched character, holding only when it was last searched. It
 * never records the searcher, so the landing page can list it publicly.
 */
export const dossierSearches = pgTable(
  "dossier_searches",
  {
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    searchedAt: timestamp("searched_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({
      name: "dossier_searches_pkey",
      columns: [table.region, table.realmSlug, table.normalizedName]
    }),
    index("dossier_searches_searched_at_idx").on(table.searchedAt)
  ]
);

export const rateLimitEvents = pgTable(
  "rate_limit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    callerBucketHash: text("caller_bucket_hash").notNull(),
    discoveryRunId: uuid("discovery_run_id").references(
      () => discoveryRuns.id,
      { onDelete: "cascade" }
    ),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("rate_limit_events_bucket_expiry_idx").on(
      table.callerBucketHash,
      table.expiresAt
    ),
    index("rate_limit_events_expiry_idx").on(table.expiresAt),
    uniqueIndex("rate_limit_events_discovery_run_idx")
      .on(table.discoveryRunId)
      .where(sql`${table.discoveryRunId} IS NOT NULL`)
  ]
);

/**
 * An accountable human operator. Credential material is salted and derived
 * before it reaches this table; no reusable password is ever persisted.
 */
export const operators = pgTable(
  "operators",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    canonicalLogin: text("canonical_login").notNull(),
    displayLogin: text("display_login").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordSalt: text("password_salt").notNull(),
    scryptVersion: integer("scrypt_version").notNull(),
    scryptCost: integer("scrypt_cost").notNull(),
    active: boolean("active").default(true).notNull(),
    credentialVersion: integer("credential_version").default(1).notNull(),
    ...timestamps
  },
  (table) => [
    uniqueIndex("operators_canonical_login_idx").on(table.canonicalLogin),
    check(
      "operators_canonical_login_check",
      sql`char_length(${table.canonicalLogin}) BETWEEN 1 AND ${operatorCanonicalLoginMaxLength} AND ${table.canonicalLogin} ~ '^[a-z0-9_-]+$'`
    )
  ]
);

/**
 * A revocable browser-session handle. The browser secret is HMACed before
 * storage, so this table contains an opaque identifier and digest only.
 */
export const operatorSessions = pgTable(
  "operator_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    secretDigest: text("secret_digest").notNull(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    credentialVersion: integer("credential_version").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp("idle_expires_at", {
      withTimezone: true
    }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", {
      withTimezone: true
    }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    index("operator_sessions_live_operator_idx")
      .on(table.operatorId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("operator_sessions_absolute_expiry_idx").on(table.absoluteExpiresAt)
  ]
);

/**
 * A throttling admission record keyed only by an HMAC subject hash. It holds
 * neither a login nor an address, and expires once its window is over.
 */
export const operatorLoginAttempts = pgTable(
  "operator_login_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    subjectHash: text("subject_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("operator_login_attempts_subject_expiry_idx").on(
      table.subjectHash,
      table.expiresAt
    ),
    index("operator_login_attempts_expiry_idx").on(table.expiresAt)
  ]
);

/**
 * Append-only lifecycle evidence. Its nullable actor link deliberately keeps
 * unknown-login failures auditable without storing a guessed identity.
 */
export const operatorAuthEvents = pgTable(
  "operator_auth_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    operatorId: uuid("operator_id").references(() => operators.id),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    index("operator_auth_events_operator_occurred_idx").on(
      table.operatorId,
      table.occurredAt
    ),
    check(
      "operator_auth_events_action_check",
      sql`${table.action} IN ('provision', 'rotate', 'disable', 'sign_in', 'sign_out', 'session_revoke')`
    ),
    check(
      "operator_auth_events_outcome_check",
      sql`${table.outcome} IN ('success', 'failure')`
    )
  ]
);

/** Account sign-in names are canonical ASCII lowercase mailbox addresses. */
export const accountCanonicalEmailMaxLength = 254;

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    canonicalEmail: text("canonical_email").notNull(),
    email: text("email").notNull(),
    role: text("role").default("user").notNull(),
    active: boolean("active").default(true).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    passwordChangeRequired: boolean("password_change_required")
      .default(false)
      .notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordSalt: text("password_salt").notNull(),
    scryptVersion: integer("scrypt_version").notNull(),
    scryptCost: integer("scrypt_cost").notNull(),
    credentialVersion: integer("credential_version").default(1).notNull(),
    ...timestamps
  },
  (table) => [
    uniqueIndex("accounts_canonical_email_idx").on(table.canonicalEmail),
    index("accounts_unverified_created_idx")
      .on(table.createdAt)
      .where(sql`${table.verifiedAt} IS NULL`),
    check("accounts_role_check", sql`${table.role} IN ('user', 'admin')`),
    check(
      "accounts_canonical_email_check",
      sql`char_length(${table.canonicalEmail}) BETWEEN 3 AND ${accountCanonicalEmailMaxLength} AND ${table.canonicalEmail} ~ '^[a-z0-9!#$%&''*+/=?^_\x60{|}~-]+(?:\\.[a-z0-9!#$%&''*+/=?^_\x60{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$'`
    )
  ]
);

export const accountSessions = pgTable(
  "account_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    secretDigest: text("secret_digest").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    credentialVersion: integer("credential_version").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp("idle_expires_at", {
      withTimezone: true
    }).notNull(),
    // NULL: no absolute lifetime; the sliding idle deadline alone applies.
    absoluteExpiresAt: timestamp("absolute_expires_at", {
      withTimezone: true
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    index("account_sessions_live_account_idx")
      .on(table.accountId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("account_sessions_absolute_expiry_idx").on(table.absoluteExpiresAt)
  ]
);

export const accountRequestAttempts = pgTable(
  "account_request_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    purpose: text("purpose").notNull(),
    subjectHash: text("subject_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("account_request_attempts_subject_expiry_idx").on(
      table.purpose,
      table.subjectHash,
      table.expiresAt
    ),
    index("account_request_attempts_expiry_idx").on(table.expiresAt)
  ]
);

export const accountMailTokens = pgTable(
  "account_mail_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenDigest: text("token_digest").notNull(),
    purpose: text("purpose").notNull(),
    flowId: uuid("flow_id"),
    proposedCanonicalEmail: text("proposed_canonical_email"),
    proposedEmail: text("proposed_email"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    uniqueIndex("account_mail_tokens_digest_idx").on(table.tokenDigest),
    index("account_mail_tokens_account_purpose_idx").on(
      table.accountId,
      table.purpose,
      table.expiresAt
    ),
    index("account_mail_tokens_flow_idx").on(table.flowId),
    index("account_mail_tokens_expiry_idx").on(table.expiresAt),
    check(
      "account_mail_tokens_purpose_check",
      sql`${table.purpose} IN ('verify', 'reset', 'email_change_current', 'email_change_new')`
    )
  ]
);

export const accountMailOutbox = pgTable(
  "account_mail_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenId: uuid("token_id").references(() => accountMailTokens.id, {
      onDelete: "cascade"
    }),
    encryptedMessage: text("encrypted_message").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    attempt: integer("attempt").default(0).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    uniqueIndex("account_mail_outbox_idempotency_idx").on(table.idempotencyKey),
    index("account_mail_outbox_due_idx")
      .on(table.nextAttemptAt, table.expiresAt)
      .where(sql`${table.sentAt} IS NULL`),
    index("account_mail_outbox_expiry_idx").on(table.expiresAt)
  ]
);

export const accountApiCredentials = pgTable(
  "account_api_credentials",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    // Removal clears ciphertext but retains the row's version, so a later
    // replacement cannot match a previously queued job's key reference.
    encryptedPayload: text("encrypted_payload"),
    version: integer("version").default(1).notNull(),
    ...timestamps
  },
  (table) => [
    primaryKey({
      name: "account_api_credentials_pkey",
      columns: [table.accountId, table.provider]
    }),
    check(
      "account_api_credentials_provider_check",
      sql`${table.provider} IN ('blizzard', 'raiderio', 'warcraftlogs')`
    )
  ]
);

export const accountAuthEvents = pgTable(
  "account_auth_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null"
    }),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    index("account_auth_events_account_occurred_idx").on(
      table.accountId,
      table.occurredAt
    ),
    check(
      "account_auth_events_outcome_check",
      sql`${table.outcome} IN ('success', 'failure')`
    )
  ]
);

export const negativeCharacterCache = pgTable(
  "negative_character_cache",
  {
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({
      name: "negative_character_cache_pkey",
      columns: [table.region, table.realmSlug, table.normalizedName]
    }),
    index("negative_character_cache_expiry_idx").on(table.expiresAt)
  ]
);

export const fingerprintSweepStates = pgTable(
  "fingerprint_sweep_states",
  {
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    lastPublishedAt: timestamp("last_published_at", {
      withTimezone: true
    }),
    resumeAfter: text("resume_after"),
    resumeLimitationCode: text("resume_limitation_code"),
    resumeHistoricalGuilds: jsonb("resume_historical_guilds"),
    resumeSnapshotId: uuid("resume_snapshot_id").references(
      () => snapshots.id,
      {
        onDelete: "set null"
      }
    ),
    /**
     * Consecutive continuation cycles that re-enqueued without advancing the
     * cursor. Reset to zero whenever the cursor advances, so a chain making
     * progress is never bounded; only a stuck one is.
     */
    continuationFailures: integer("continuation_failures").notNull().default(0)
  },
  (table) => [
    primaryKey({
      name: "fingerprint_sweep_states_pkey",
      columns: [table.region, table.realmSlug, table.normalizedName]
    })
  ]
);

export const fingerprintSweepAdmissions = pgTable(
  "fingerprint_sweep_admissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    queueOrder: bigserial("queue_order", { mode: "number" }).notNull(),
    discoveryRunId: uuid("discovery_run_id")
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: "cascade" }),
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    requestCap: integer("request_cap").notNull(),
    hourlyBudget: integer("hourly_budget").notNull(),
    cadenceCutoff: timestamp("cadence_cutoff", {
      withTimezone: true
    }).notNull(),
    status: text("status").default("waiting").notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    index("fingerprint_sweep_admissions_waiting_idx").on(
      table.status,
      table.requestedAt,
      table.queueOrder
    ),
    index("fingerprint_sweep_admissions_root_idx").on(
      table.region,
      table.realmSlug,
      table.normalizedName
    ),
    index("fingerprint_sweep_admissions_dispatch_idx").on(
      table.status,
      table.dispatchedAt,
      table.requestedAt,
      table.queueOrder
    ),
    check(
      "fingerprint_sweep_admissions_request_cap_check",
      sql`${table.requestCap} > 0`
    ),
    check(
      "fingerprint_sweep_admissions_hourly_budget_check",
      sql`${table.hourlyBudget} > 0`
    )
  ]
);

export const fingerprintSweepReservations = pgTable(
  "fingerprint_sweep_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => fingerprintSweepAdmissions.id, { onDelete: "cascade" }),
    requestCap: integer("request_cap").notNull(),
    usedCount: integer("used_count").default(0).notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    published: boolean("published"),
    limitationCode: text("limitation_code")
  },
  (table) => [
    uniqueIndex("fingerprint_sweep_reservations_admission_idx").on(
      table.admissionId
    ),
    index("fingerprint_sweep_reservations_expiry_idx").on(table.expiresAt),
    check(
      "fingerprint_sweep_reservations_request_cap_check",
      sql`${table.requestCap} > 0`
    ),
    check(
      "fingerprint_sweep_reservations_used_count_check",
      sql`${table.usedCount} >= 0 AND ${table.usedCount} <= ${table.requestCap}`
    ),
    check(
      "fingerprint_sweep_reservations_expiry_check",
      sql`${table.expiresAt} > ${table.admittedAt}`
    )
  ]
);

export const fingerprintSweepRequestEvents = pgTable(
  "fingerprint_sweep_request_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => fingerprintSweepReservations.id, {
        onDelete: "cascade"
      }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("fingerprint_sweep_request_events_window_idx").on(table.requestedAt)
  ]
);

export const characterEvidenceRuns = pgTable(
  "character_evidence_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    queueJobId: text("queue_job_id"),
    status: characterEvidenceRunStatus("status").default("queued").notNull(),
    evidenceVersion: integer("evidence_version").default(1).notNull(),
    attempt: integer("attempt").default(0).notNull(),
    limitationCode: text("limitation_code"),
    parseLimitationCode: text("parse_limitation_code"),
    // Every parse limitation the run raised, not only the one it is judged
    // by. A run can hit several, `parse_limitation_code` holds one, and the
    // rest used to be discarded -- which is how an unmatched ranking identity
    // hid behind `parse_request_cap` for weeks (#349). Empty, never null, for
    // a run that raised none; a pre-#349 row is null and means "not recorded",
    // which is not the same thing.
    parseLimitationCodesSeen: text("parse_limitation_codes_seen").array(),
    // A manual refresh inside the cooldown reads one page of history and
    // leaves the bookmark where it was (#526). The queue payload carries this
    // for the worker; the run carries it so a reader can tell the run will
    // not re-read what the last full run fell short on.
    lightRefresh: boolean("light_refresh").default(false).notNull(),
    omittedInvalidTimestamp: boolean("omitted_invalid_timestamp")
      .default(false)
      .notNull(),
    // Whether this run deliberately skipped the history scan and collected
    // parses only. It is a third way to be partial, alongside the two
    // limitation codes, and the completion check below reads it as one.
    killScanSkipped: boolean("kill_scan_skipped").default(false).notNull(),
    // When this run's history scan last finished cleanly. Null on a run that
    // skipped the scan or raised a scan limitation, so the newest non-null
    // value is the only thing that may license skipping the next scan.
    killScanCompletedAt: timestamp("kill_scan_completed_at", {
      withTimezone: true
    }),
    // The next page below a capped, cleanly decoded history prefix. It is
    // scoped to the published run so an abandoned attempt cannot advance it.
    killScanResumePage: integer("kill_scan_resume_page"),
    killScanResumeBoundaryReportCode: text(
      "kill_scan_resume_boundary_report_code"
    ),
    historicAliasProgress: jsonb("historic_alias_progress"),
    rankedBackfillCursor: jsonb("ranked_backfill_cursor"),
    rankedBackfillAttempted: boolean("ranked_backfill_attempted")
      .default(false)
      .notNull(),
    wclClientIdEncrypted: text("wcl_client_id_encrypted"),
    wclClientSecretEncrypted: text("wcl_client_secret_encrypted"),
    accountCredentialOwnerId: uuid("account_credential_owner_id").references(
      () => accounts.id,
      { onDelete: "set null" }
    ),
    accountCredentialVersion: integer("account_credential_version"),
    // What the run was reserved to do. `tier_search` is a targeted collection
    // of one tier's guild attendance and ranked kills, asked for from the
    // dossier (#435, #450). It lives on the run rather than only in the queue
    // payload so a re-claimed attempt is still a tier search, and so nothing
    // that re-enqueues without a payload can turn one into a default.
    mode: text("mode").default("full").notNull(),
    /** The Journal raid id a `tier_search` run searches; null otherwise. */
    tierSearchRaidId: text("tier_search_raid_id"),
    // What the published snapshot vouches for. `full` is an ordinary
    // collection, whose completion, limitations, retry deadline and cutting
    // edges speak for the character. `tier` is a targeted search that added
    // to the previous snapshot without re-reading anything else (#450), so a
    // reader takes those facts from the newest `full` run instead.
    publicationScope: text("publication_scope").default("full").notNull(),
    retryAfterAt: timestamp("retry_after_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("character_evidence_runs_one_active_key_idx")
      .on(table.region, table.realmSlug, table.normalizedName)
      .where(sql`${table.status} in ('queued', 'running', 'retrying')`),
    index("character_evidence_runs_completed_key_idx").on(
      table.region,
      table.realmSlug,
      table.normalizedName,
      table.completedAt
    ),
    // How recently a character's tier was searched, which is what rate
    // limits the search per tier and per character.
    index("character_evidence_runs_tier_search_idx")
      .on(
        table.region,
        table.realmSlug,
        table.normalizedName,
        table.tierSearchRaidId,
        table.createdAt
      )
      .where(sql`${table.mode} = 'tier_search'`),
    check(
      "character_evidence_runs_mode_check",
      sql`(${table.mode} = 'full' AND ${table.tierSearchRaidId} IS NULL) OR (${table.mode} = 'tier_search' AND ${table.tierSearchRaidId} IS NOT NULL)`
    ),
    check(
      "character_evidence_runs_publication_scope_check",
      sql`${table.publicationScope} = 'full' OR (${table.publicationScope} = 'tier' AND ${table.mode} = 'tier_search')`
    ),
    // A partial run must name a shortfall, in one of three channels: the
    // history scan's, the parse budget's, or a scan the run deliberately did
    // not perform. Requiring `limitation_code` alone was the pre-#280 shape,
    // when a parse cap could not stand on its own; requiring either code was
    // the pre-#367 shape, which rejected a parse-only resume whose work fitted
    // inside its budget.
    check(
      "character_evidence_runs_completion_limitations_check",
      sql`(${table.status} = 'complete' AND ${table.limitationCode} IS NULL) OR (${table.status} = 'partial' AND (${table.limitationCode} IS NOT NULL OR ${table.parseLimitationCode} IS NOT NULL OR ${table.killScanSkipped})) OR ${table.status} NOT IN ('complete', 'partial')`
    )
  ]
);

export const characterEvidenceRunPhases = pgTable(
  "character_evidence_run_phases",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => characterEvidenceRuns.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    state: text("state").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    limitationCode: text("limitation_code")
  },
  (table) => [
    primaryKey({
      name: "character_evidence_run_phases_pk",
      columns: [table.runId, table.phaseId]
    }),
    check(
      "character_evidence_run_phases_state_check",
      sql`${table.state} in ('pending', 'active', 'completed', 'skipped', 'limited', 'failed', 'cancelled')`
    ),
    uniqueIndex("character_evidence_run_phases_order_idx").on(
      table.runId,
      table.ordinal
    )
  ]
);

/** Normalized Blizzard achievements collected as part of one evidence run. */
export const characterEvidenceCuttingEdges = pgTable(
  "character_evidence_cutting_edges",
  {
    evidenceRunId: uuid("evidence_run_id")
      .notNull()
      .references(() => characterEvidenceRuns.id, { onDelete: "cascade" }),
    achievementId: text("achievement_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "character_evidence_cutting_edges_pk",
      columns: [table.evidenceRunId, table.achievementId]
    })
  ]
);

/**
 * One run's collected evidence, staged between a finished Warcraft Logs scan
 * and a successful publication.
 *
 * A retry that already holds a stage republishes it instead of re-collecting,
 * which is what stops a transient publication failure from costing a second
 * full collection (#292). It is deleted in the same transaction as the
 * publication it feeds, so a row here always means work that has been paid for
 * upstream and not yet stored.
 */
export const characterEvidenceCollections = pgTable(
  "character_evidence_collections",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => characterEvidenceRuns.id, { onDelete: "cascade" }),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  }
);

/**
 * What one attempt of an evidence run spent, and the configuration it spent it
 * under.
 *
 * This exists because the only record of a run's cost was a line in the
 * worker's deployment logs, which `railway logs` serves for the current
 * deployment alone (#342). `EVIDENCE_POINTS_RESERVE`, `EVIDENCE_REQUEST_CAP`
 * and `EVIDENCE_PARSE_REQUEST_CAP` all carve up the same hourly allowance and
 * all depend on measured run cost, so a measurement nobody can query is a
 * measurement nobody redoes.
 *
 * One row per *attempt*, not per run: a retry pays for its own collection, and
 * collapsing the two would hide exactly the spend the retry ceiling is set
 * from.
 *
 * Reachable from the run only by id -- no region, realm or name -- so it adds
 * no identifying surface the run record does not already hold.
 */
export const characterEvidenceRunCosts = pgTable(
  "character_evidence_run_costs",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => characterEvidenceRuns.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** How the attempt ended, as the `evidence_job` record names it. */
    outcome: text("outcome").notNull(),
    /**
     * Whose allowance was spent, as a class rather than an identity: the scan
     * share `evidenceRunBudget` grants branches on exactly this, and anything
     * narrower would put a visitor identifier in this table.
     */
    credentials: text("credentials").notNull(),
    /**
     * Why the run fell short, in either channel. `outcome` says a run was
     * limited; these say which limitation, which is what separates the cost of
     * a run that hit drift from the cost of a clean one without correlating
     * against the logs by hand.
     */
    limitationCode: text("limitation_code"),
    parseLimitationCode: text("parse_limitation_code"),
    /**
     * The three spend readings. Null is `unavailable` -- the allowance could
     * not be read -- and never zero, which is a legitimate reading of a run
     * that spent nothing.
     *
     * Storing all three looks redundant, and is not: `points_spent` is a
     * delta between two readings of the same counter, so two independent
     * checks fall out of keeping the endpoints. See
     * `docs/operations/evidence-run-cost.md` before dropping a column.
     */
    pointsSpent: doublePrecision("points_spent"),
    pointsLimitPerHour: integer("points_limit_per_hour"),
    pointsRemainingBefore: doublePrecision("points_remaining_before"),
    pointsRemainingAfter: doublePrecision("points_remaining_after"),
    /**
     * The caps the run was actually given, not the ones configured: #320 made
     * the effective scan cap a function of the reported allowance, and a
     * record naming the configured value describes a budget the run may never
     * have been allowed to reach.
     */
    requestCapUsed: integer("request_cap_used").notNull(),
    parseRequestCapUsed: integer("parse_request_cap_used").notNull(),
    /** The per-class upstream request counts already on the log line. */
    historyScanRequests: integer("history_scan_requests").default(0).notNull(),
    zoneRankingsRequests: integer("zone_rankings_requests")
      .default(0)
      .notNull(),
    fightParsesRequests: integer("fight_parses_requests").default(0).notNull(),
    rankingIdentitiesRequests: integer("ranking_identities_requests")
      .default(0)
      .notNull(),
    /**
     * Attendance recovery, counted apart from `history_scan_requests`, which
     * before this column counted it too: the three share one scan cap, and a
     * row from before the split reads zero here with its recovery inside the
     * history count.
     */
    guildAttendanceRequests: integer("guild_attendance_requests")
      .default(0)
      .notNull(),
    reportHydrationRequests: integer("report_hydration_requests")
      .default(0)
      .notNull(),
    /**
     * What recovery was asked to do and what it yielded. Null means the step
     * did not run -- Raider.IO not asked, or no attendance searched -- and is
     * never a zero, which is a step that ran and found nothing.
     */
    raiderIoHistoricOutcome: text("raiderio_historic_outcome"),
    raiderIoHistoricMs: integer("raiderio_historic_ms"),
    verifiedKillsSearched: integer("verified_kills_searched"),
    /**
     * Kills Raider.IO verified that were not searched for because an earlier
     * run searched their night to the end and found nothing (#434). Null when
     * Raider.IO was not asked.
     */
    verifiedKillsSkippedEmpty: integer("verified_kills_skipped_empty"),
    attendanceRecoveredKills: integer("attendance_recovered_kills"),
    /** The run's mode, so a tier search's cost can be read apart (#435). */
    mode: text("mode").default("full").notNull(),
    /**
     * Physical requests to the other two upstreams: Raider.IO `raid-progress`
     * (one per tier), Raider.IO boss rankings (two per guild query) and the
     * Blizzard achievements profile. Counted so what retaining them would save
     * can be measured before it is built (#298).
     *
     * Null on a row recorded before they were counted, which is not a zero:
     * those runs did ask both providers, and nothing counted what it cost.
     */
    raiderIoHistoricRequests: integer("raiderio_historic_requests"),
    raiderIoRankingsRequests: integer("raiderio_rankings_requests"),
    blizzardAchievementsRequests: integer("blizzard_achievements_requests"),
    /** `CharacterGuilds`, which only a tier search reads. */
    characterGuildsRequests: integer("character_guilds_requests")
      .default(0)
      .notNull(),
    /**
     * What a tier search was asked for and what it yielded. Null on a run that
     * searched no tier, and never a zero for one: a search not made is not a
     * search that found nothing. Its requests are also counted in the
     * per-class columns above.
     */
    tierSearchRaidId: text("tier_search_raid_id"),
    tierSearchOutcome: text("tier_search_outcome"),
    tierSearchRequests: integer("tier_search_requests"),
    tierSearchGuilds: integer("tier_search_guilds"),
    tierSearchReportsHydrated: integer("tier_search_reports_hydrated"),
    tierSearchRecoveredKills: integer("tier_search_recovered_kills"),
    tierSearchRecoveredWipes: integer("tier_search_recovered_wipes"),
    /**
     * Where the attempt's time went, as the `evidence_job` line reports it
     * (#502). Each is null when it was not measured, which is not a zero:
     * `queue_wait_ms` on a job enqueued without a timestamp, a Warcraft Logs
     * bucket on an attempt that never called it, every column on a row
     * recorded before these existed.
     */
    durationMs: integer("duration_ms"),
    queueWaitMs: integer("queue_wait_ms"),
    warcraftLogsMs: integer("warcraft_logs_ms"),
    warcraftLogsHistoricAliasMs: integer("warcraft_logs_historic_alias_ms"),
    dbMs: integer("db_ms"),
    /** The repository call that took longest, a static label from source. */
    dbMaxCallName: text("db_max_call_name")
  },
  (table) => [
    primaryKey({
      name: "character_evidence_run_costs_pk",
      columns: [table.runId, table.attempt]
    }),
    // Both the retention sweep's cutoff and the window every question of this
    // table opens with.
    index("character_evidence_run_costs_recorded_idx").on(table.recordedAt),
    check(
      "character_evidence_run_costs_credentials_check",
      sql`${table.credentials} in ('own', 'visitor')`
    )
  ]
);

export const characterMythicKills = pgTable(
  "character_mythic_kills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    evidenceRunId: uuid("evidence_run_id")
      .notNull()
      .references(() => characterEvidenceRuns.id, { onDelete: "cascade" }),
    sourceFightKey: text("source_fight_key").notNull(),
    raidId: text("raid_id").notNull(),
    raidName: text("raid_name").notNull(),
    bossId: text("boss_id").notNull(),
    bossName: text("boss_name").notNull(),
    journalBossId: text("journal_boss_id"),
    bossOrder: integer("boss_order").notNull(),
    killedAt: timestamp("killed_at", { withTimezone: true }).notNull(),
    reportUrl: text("report_url").notNull(),
    fightUrl: text("fight_url").notNull(),
    guildName: text("guild_name"),
    guildRegion: text("guild_region"),
    guildRealm: text("guild_realm"),
    uploader: text("uploader"),
    historicWorldRank: integer("historic_world_rank"),
    historicRankCheckedAt: timestamp("historic_rank_checked_at", {
      withTimezone: true
    }),
    specName: text("spec_name"),
    specIconUrl: text("spec_icon_url"),
    damageParseState:
      characterMythicKillParseState("damage_parse_state").notNull(),
    damagePercentile: doublePrecision("damage_percentile"),
    healingParseState: characterMythicKillParseState(
      "healing_parse_state"
    ).notNull(),
    healingPercentile: doublePrecision("healing_percentile"),
    bossDamageParseState: characterMythicKillParseState(
      "boss_damage_parse_state"
    ).notNull(),
    bossDamagePercentile: doublePrecision("boss_damage_percentile"),
    /**
     * When this fight's parses were actually read. A percentile is a value
     * against a ranking pool with no record of when it was observed, so drift
     * is unmeasurable from what we store. This column makes it measurable from
     * our own data at no upstream cost, and is what should eventually replace
     * the guessed `EVIDENCE_KILL_SETTLE_DAYS`. Carried forward unchanged when
     * a later run skips a fight it has already hydrated.
     */
    collectedAt: timestamp("collected_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * When this fight's rankings were last asked about and answered, whatever
     * the answer was. NULL means never asked.
     *
     * Deliberately not implied by the parse states. Roughly half of hydrated
     * fights come back with no ranking at all, and stored as three
     * `unavailable` metrics they are indistinguishable from a fight nothing
     * has ever requested -- so collection re-requested them every run, and
     * since #350 raised a retryable limitation each time, never settled
     * (#297). Carried forward unchanged when a later run skips the fight.
     */
    parsesReadAt: timestamp("parses_read_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("character_mythic_kills_source_fight_idx").on(
      table.evidenceRunId,
      table.sourceFightKey
    ),
    index("character_mythic_kills_run_idx").on(table.evidenceRunId),
    check(
      "character_mythic_kills_guild_identity_check",
      sql`(${table.guildName} IS NULL AND ${table.guildRealm} IS NULL) OR (${table.guildName} IS NOT NULL AND ${table.guildRealm} IS NOT NULL)`
    ),
    check(
      "character_mythic_kills_historic_world_rank_check",
      sql`${table.historicWorldRank} IS NULL OR ${table.historicWorldRank} > 0`
    ),
    check(
      "character_mythic_kills_damage_parse_check",
      sql`(${table.damageParseState} = 'available' AND ${table.damagePercentile} IS NOT NULL AND ${table.damagePercentile} >= 0 AND ${table.damagePercentile} <= 100) OR (${table.damageParseState} IN ('not_applicable', 'unavailable') AND ${table.damagePercentile} IS NULL)`
    ),
    check(
      "character_mythic_kills_healing_parse_check",
      sql`(${table.healingParseState} = 'available' AND ${table.healingPercentile} IS NOT NULL AND ${table.healingPercentile} >= 0 AND ${table.healingPercentile} <= 100) OR (${table.healingParseState} IN ('not_applicable', 'unavailable') AND ${table.healingPercentile} IS NULL)`
    ),
    check(
      "character_mythic_kills_boss_damage_parse_check",
      sql`(${table.bossDamageParseState} = 'available' AND ${table.bossDamagePercentile} IS NOT NULL AND ${table.bossDamagePercentile} >= 0 AND ${table.bossDamagePercentile} <= 100) OR (${table.bossDamageParseState} IN ('not_applicable', 'unavailable') AND ${table.bossDamagePercentile} IS NULL)`
    )
  ]
);

/**
 * One encounter's best Mythic parse for a character, read from a whole zone in
 * a single upstream request. It is deliberately not tied to a fight: it is the
 * character's best anywhere, which is what the dossier's best-parse row claims,
 * and never a statement about any particular kill.
 */
export const characterTierBestParses = pgTable(
  "character_tier_best_parses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    evidenceRunId: uuid("evidence_run_id")
      .notNull()
      .references(() => characterEvidenceRuns.id, { onDelete: "cascade" }),
    raidId: text("raid_id").notNull(),
    raidName: text("raid_name").notNull(),
    bossId: text("boss_id").notNull(),
    bossName: text("boss_name").notNull(),
    rankingsUrl: text("rankings_url").notNull(),
    specName: text("spec_name"),
    specIconUrl: text("spec_icon_url"),
    damageParseState:
      characterMythicKillParseState("damage_parse_state").notNull(),
    damagePercentile: doublePrecision("damage_percentile"),
    healingParseState: characterMythicKillParseState(
      "healing_parse_state"
    ).notNull(),
    healingPercentile: doublePrecision("healing_percentile"),
    bossDamageParseState: characterMythicKillParseState(
      "boss_damage_parse_state"
    ).notNull(),
    bossDamagePercentile: doublePrecision("boss_damage_percentile"),
    /**
     * When this zone's rankings were actually read, which `publish` preserves
     * as it carries a row onto a later run. The run's own `completed_at` would
     * say every carried zone was just collected, so a zone a run never reached
     * would look current and never be read again.
     */
    collectedAt: timestamp("collected_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    uniqueIndex("character_tier_best_parses_encounter_idx").on(
      table.evidenceRunId,
      table.raidId,
      table.bossId
    ),
    index("character_tier_best_parses_run_idx").on(table.evidenceRunId),
    check(
      "character_tier_best_parses_damage_parse_check",
      sql`(${table.damageParseState} = 'available' AND ${table.damagePercentile} IS NOT NULL AND ${table.damagePercentile} >= 0 AND ${table.damagePercentile} <= 100) OR (${table.damageParseState} IN ('not_applicable', 'unavailable') AND ${table.damagePercentile} IS NULL)`
    ),
    check(
      "character_tier_best_parses_healing_parse_check",
      sql`(${table.healingParseState} = 'available' AND ${table.healingPercentile} IS NOT NULL AND ${table.healingPercentile} >= 0 AND ${table.healingPercentile} <= 100) OR (${table.healingParseState} IN ('not_applicable', 'unavailable') AND ${table.healingPercentile} IS NULL)`
    ),
    check(
      "character_tier_best_parses_boss_damage_parse_check",
      sql`(${table.bossDamageParseState} = 'available' AND ${table.bossDamagePercentile} IS NOT NULL AND ${table.bossDamagePercentile} >= 0 AND ${table.bossDamagePercentile} <= 100) OR (${table.bossDamageParseState} IN ('not_applicable', 'unavailable') AND ${table.bossDamagePercentile} IS NULL)`
    )
  ]
);

export const characterMythicWipes = pgTable(
  "character_mythic_wipes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    evidenceRunId: uuid("evidence_run_id")
      .notNull()
      .references(() => characterEvidenceRuns.id, { onDelete: "cascade" }),
    raidId: text("raid_id").notNull(),
    raidName: text("raid_name").notNull(),
    bossId: text("boss_id").notNull(),
    bossName: text("boss_name").notNull(),
    journalBossId: text("journal_boss_id"),
    bossOrder: integer("boss_order").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    reportUrl: text("report_url").notNull(),
    fightUrl: text("fight_url").notNull(),
    guildName: text("guild_name"),
    guildRealm: text("guild_realm"),
    uploader: text("uploader")
  },
  (table) => [
    uniqueIndex("character_mythic_wipes_run_fight_idx").on(
      table.evidenceRunId,
      table.fightUrl
    ),
    index("character_mythic_wipes_run_idx").on(table.evidenceRunId),
    check(
      "character_mythic_wipes_guild_identity_check",
      sql`(${table.guildName} IS NULL AND ${table.guildRealm} IS NULL) OR (${table.guildName} IS NOT NULL AND ${table.guildRealm} IS NOT NULL)`
    )
  ]
);

/**
 * The raid tiers one character's evidence is stored for indefinitely: read
 * once, then never re-queried.
 *
 * Keyed by character rather than by evidence run, so a mark never depends on
 * any one run surviving. (Maintenance deleted terminal runs after 30 days
 * until #104; runs are now kept, but the mark still must not lean on them.)
 *
 * `collectionVersion` is the automatic half of the correction path. Bumping one
 * domain's version drops that domain's marks out of every read, so its tiers
 * re-collect once and settle again while the other domains stay terminal.
 * `character_evidence_runs.evidence_version` cannot serve this: it invalidates
 * everything at once, which is affordable while nothing is terminal and ruinous
 * when the point is to stop re-querying.
 */
export const characterTerminalTiers = pgTable(
  "character_terminal_tiers",
  {
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    /** The Warcraft Logs zone id, matching `character_mythic_kills.raid_id`. */
    raidId: text("raid_id").notNull(),
    domain: evidenceCollectionDomain("domain").notNull(),
    collectionVersion: integer("collection_version").notNull(),
    markedAt: timestamp("marked_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({
      name: "character_terminal_tiers_pkey",
      columns: [
        table.region,
        table.realmSlug,
        table.normalizedName,
        table.raidId,
        table.domain
      ]
    })
  ]
);

/**
 * Raider.IO-verified kills whose night was searched to the end in the named
 * guild's attendance and held nothing (#434).
 *
 * A kill whose first defeat was never logged can never be held, so without
 * this every full run walked that guild's attendance back to its night again:
 * characters with no stored Warcraft Logs evidence at all never get a scan
 * floor, and a current tier never settles. A row lets the run skip the search
 * until it goes stale, because logs and attendance can still be uploaded late.
 *
 * Keyed by character, like `character_terminal_tiers`, so it outlives run
 * cleanup; `collectionVersion` drops rows out of every read when the kill
 * collection changes, as it does for terminal marks. It holds a guild the
 * character was in and a kill time, both already public on Raider.IO and no
 * more identifying than a stored kill's guild.
 */
export const characterAttendanceSearches = pgTable(
  "character_attendance_searches",
  {
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    guildRegion: text("guild_region").notNull(),
    guildRealm: text("guild_realm").notNull(),
    guildName: text("guild_name").notNull(),
    /** Raider.IO's first-defeated time for the kill that was searched for. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    collectionVersion: integer("collection_version").notNull(),
    searchedAt: timestamp("searched_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({
      name: "character_attendance_searches_pkey",
      columns: [
        table.region,
        table.realmSlug,
        table.normalizedName,
        table.guildRegion,
        table.guildRealm,
        table.guildName,
        table.verifiedAt
      ]
    })
  ]
);

/**
 * The stable Warcraft Logs character ID each name, realm and region last
 * resolved to. The ID survives renames and realm transfers where the key does
 * not, so it is what can tell a character's former name from its current one.
 *
 * Deliberately not unique on `character_id`: a former name and a current name
 * resolving to the same ID is exactly the rename that links them (#424). And a
 * released name can later resolve to somebody else, so a new answer replaces
 * the old one.
 */
export const warcraftLogsCharacterIds = pgTable(
  "warcraft_logs_character_ids",
  {
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    characterId: integer("character_id").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "warcraft_logs_character_ids_pkey",
      columns: [table.region, table.realmSlug, table.normalizedName]
    }),
    index("warcraft_logs_character_ids_character_id_idx").on(table.characterId),
    check("warcraft_logs_character_ids_positive", sql`${table.characterId} > 0`)
  ]
);
