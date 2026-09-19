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
    wclClientIdEncrypted: text("wcl_client_id_encrypted"),
    wclClientSecretEncrypted: text("wcl_client_secret_encrypted"),
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
    // A partial run must name a shortfall, in either channel: the history
    // scan's or the parse budget's. Requiring `limitation_code` alone was the
    // pre-#280 shape, when a parse cap could not stand on its own.
    check(
      "character_evidence_runs_completion_limitations_check",
      sql`(${table.status} = 'complete' AND ${table.limitationCode} IS NULL) OR (${table.status} = 'partial' AND (${table.limitationCode} IS NOT NULL OR ${table.parseLimitationCode} IS NOT NULL)) OR ${table.status} NOT IN ('complete', 'partial')`
    )
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
    isFinalBoss: boolean("is_final_boss").notNull(),
    killedAt: timestamp("killed_at", { withTimezone: true }).notNull(),
    reportUrl: text("report_url").notNull(),
    fightUrl: text("fight_url").notNull(),
    guildName: text("guild_name"),
    guildRealm: text("guild_realm"),
    historicWorldRank: integer("historic_world_rank"),
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
      .notNull()
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
    fightUrl: text("fight_url").notNull()
  },
  (table) => [
    uniqueIndex("character_mythic_wipes_run_fight_idx").on(
      table.evidenceRunId,
      table.fightUrl
    ),
    index("character_mythic_wipes_run_idx").on(table.evidenceRunId)
  ]
);

/**
 * The raid tiers one character's evidence is stored for indefinitely: read
 * once, then never re-queried.
 *
 * Keyed by character rather than by evidence run, because the worker's
 * maintenance deletes terminal runs after 30 days and a mark has to outlive
 * that or the whole design unwinds every month.
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
