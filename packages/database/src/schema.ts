import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
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
  "profile_guess"
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
    raiderIoUrl: text("raider_io_url").notNull()
  },
  (table) => [
    uniqueIndex("snapshot_characters_membership_idx").on(
      table.snapshotId,
      table.characterId
    ),
    uniqueIndex("snapshot_characters_display_order_idx").on(
      table.snapshotId,
      table.displayOrder
    )
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
    index("rate_limit_events_expiry_idx").on(table.expiresAt)
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
