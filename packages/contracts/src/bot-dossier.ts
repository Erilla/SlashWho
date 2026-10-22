import { z } from "zod";

import {
  characterKeySchema,
  dossierGuildSchema,
  dossierLimitationAffectsSchema,
  dossierLimitationCodeSchema,
  dossierSourceLabelSchema
} from "./dossier";

/** How the bot should read a dossier: wait, publish, or publish with a note. */
export const botDossierStateSchema = z.enum(["collecting", "ready", "partial"]);

/** The same states a public dossier gives one character's evidence. */
export const botDossierEvidenceStateSchema = z.enum([
  "waiting",
  "scanning",
  "complete",
  "partial"
]);

/**
 * One character the application declared. A pending character is linked but
 * has no snapshot yet: its class and guild are unknown, so they are null
 * rather than invented.
 */
export const botDossierCharacterSchema = z
  .object({
    key: characterKeySchema,
    displayName: z.string().min(1),
    className: z.string().min(1).nullable(),
    guild: dossierGuildSchema.nullable(),
    source: dossierSourceLabelSchema,
    /**
     * Always null in v1. SlashWho does not retain a fingerprint score; the
     * field exists so a later score can be added without a new contract. The
     * bot must not infer a score from it.
     */
    confidence: z.number().min(0).max(100).nullable(),
    evidenceState: botDossierEvidenceStateSchema,
    /** True until discovery creates this declared character's row. */
    pending: z.boolean()
  })
  .strict();

/** One raid stint inside a guild span, built from the stored Mythic kills. */
export const botDossierGuildRaidSchema = z
  .object({
    raidName: z.string().min(1),
    kills: z.number().int().positive(),
    firstKillAt: z.iso.datetime(),
    lastKillAt: z.iso.datetime(),
    /** Display names; the top-level `characters` list carries the keys. */
    characters: z.array(z.string().min(1)).min(1)
  })
  .strict();

/**
 * One continuous stretch of raid nights in a guild, using the same rules as
 * the page: a UTC day is a night, renames merge, and a single-night guild is
 * a pug rather than a membership.
 */
export const botDossierGuildHistorySchema = z
  .object({
    guild: dossierGuildSchema,
    firstNight: z.iso.date(),
    lastNight: z.iso.date(),
    raidNights: z.number().int().positive(),
    tiers: z.array(z.string().min(1)),
    /** Display names; the top-level `characters` list carries the keys. */
    characters: z.array(z.string().min(1)).min(1),
    raids: z.array(botDossierGuildRaidSchema)
  })
  .strict();

/**
 * One boss the bot's log message can render. `firstKilledAt` is null on a wipe
 * because there was no kill; `worldRank` is null when no rank was stored.
 */
export const botDossierBossSchema = z
  .object({
    bossName: z.string().min(1),
    state: z.enum(["kill", "wipe"]),
    firstKilledAt: z.iso.datetime().nullable(),
    /** Display names; the top-level `characters` list carries the keys. */
    characters: z.array(z.string().min(1)).min(1),
    worldRank: z.number().int().positive().nullable(),
    reportUrl: z.url().nullable()
  })
  .strict();

export const botDossierRaidSchema = z
  .object({
    raidName: z.string().min(1),
    /**
     * `true` when stored evidence supports it; `null` means the stored-only
     * read did not restore it, never that the account lacks it.
     */
    cuttingEdge: z.literal(true).nullable(),
    bosses: z.array(botDossierBossSchema).min(1)
  })
  .strict();

export const botDossierCuttingEdgeSchema = z
  .object({
    achievementName: z.string().min(1),
    completedAt: z.iso.datetime()
  })
  .strict();

export const botDossierLimitationSchema = z
  .object({
    code: dossierLimitationCodeSchema,
    affects: dossierLimitationAffectsSchema,
    character: characterKeySchema.nullable()
  })
  .strict();

/**
 * The chat-sized dossier. It carries what the bot's three messages render and
 * never the public document: no parses, rosters, reports or per-kill rows.
 */
export const botDossierSummarySchema = z
  .object({
    root: characterKeySchema,
    state: botDossierStateSchema,
    /** The dossier's own root snapshot; null until it exists. */
    snapshotId: z.uuid().nullable(),
    lastCollectedAt: z.iso.datetime().nullable(),
    /**
     * True only when every included character's stored evidence collected
     * Cutting Edge. When false, `cuttingEdges` is incomplete, not a statement
     * that none exist.
     */
    cuttingEdgesRestored: z.boolean(),
    characters: z.array(botDossierCharacterSchema),
    guildHistory: z.array(botDossierGuildHistorySchema),
    raids: z.array(botDossierRaidSchema),
    cuttingEdges: z.array(botDossierCuttingEdgeSchema),
    limitations: z.array(botDossierLimitationSchema)
  })
  .strict();

/**
 * The cheap poll. `etag` hashes the other fields, so a 304 means nothing the
 * bot renders has changed.
 */
export const botDossierStatusSchema = z
  .object({
    state: botDossierStateSchema,
    snapshotId: z.uuid().nullable(),
    lastCollectedAt: z.iso.datetime().nullable(),
    evidenceRunIds: z.array(z.uuid()),
    etag: z.string().min(1)
  })
  .strict();

/**
 * A create carries every character an application declared. Duplicate URLs are
 * deduplicated by canonical key and charged once; the response has one outcome
 * per unique character.
 */
export const botCreateDossierRequestSchema = z
  .object({
    characters: z.array(z.url()).min(1).max(10)
  })
  .strict();

export const botCreateDossierOutcomeSchema = z
  .object({
    key: characterKeySchema,
    outcome: z.enum([
      "queued",
      "existing",
      "rate_limited",
      "suppressed",
      "not_found",
      "failed"
    ]),
    /** Present when the outcome is a queued or joined job. */
    jobId: z.uuid().optional()
  })
  .strict();

export const botCreateDossierResponseSchema = z
  .object({
    root: characterKeySchema,
    state: botDossierStateSchema,
    snapshotId: z.uuid().nullable(),
    lastCollectedAt: z.iso.datetime().nullable(),
    evidenceRunIds: z.array(z.uuid()),
    outcomes: z.array(botCreateDossierOutcomeSchema).min(1),
    /** Present when any character was rate limited. */
    retryAfterSeconds: z.number().int().positive().optional()
  })
  .strict();

export const botAddDossierCharacterRequestSchema = z
  .object({ characterUrl: z.url() })
  .strict();

/**
 * The character is linked. `jobId` is present when a search is queued or was
 * resumed; it is absent when the character already had completed evidence and
 * no search was needed.
 */
export const botAddDossierCharacterResponseSchema = z
  .object({
    kind: z.literal("linked"),
    jobId: z.uuid().optional()
  })
  .strict();

export type BotDossierState = z.infer<typeof botDossierStateSchema>;
export type BotDossierEvidenceState = z.infer<
  typeof botDossierEvidenceStateSchema
>;
export type BotDossierCharacter = z.infer<typeof botDossierCharacterSchema>;
export type BotDossierGuildRaid = z.infer<typeof botDossierGuildRaidSchema>;
export type BotDossierGuildHistory = z.infer<
  typeof botDossierGuildHistorySchema
>;
export type BotDossierBoss = z.infer<typeof botDossierBossSchema>;
export type BotDossierRaid = z.infer<typeof botDossierRaidSchema>;
export type BotDossierCuttingEdge = z.infer<typeof botDossierCuttingEdgeSchema>;
export type BotDossierLimitation = z.infer<typeof botDossierLimitationSchema>;
export type BotDossierSummary = z.infer<typeof botDossierSummarySchema>;
export type BotDossierStatus = z.infer<typeof botDossierStatusSchema>;
export type BotCreateDossierRequest = z.infer<
  typeof botCreateDossierRequestSchema
>;
export type BotCreateDossierOutcome = z.infer<
  typeof botCreateDossierOutcomeSchema
>;
export type BotCreateDossierResponse = z.infer<
  typeof botCreateDossierResponseSchema
>;
export type BotAddDossierCharacterRequest = z.infer<
  typeof botAddDossierCharacterRequestSchema
>;
export type BotAddDossierCharacterResponse = z.infer<
  typeof botAddDossierCharacterResponseSchema
>;
