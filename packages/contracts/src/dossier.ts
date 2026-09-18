import { z } from "zod";

import { regionSchema } from "./character";

export const characterKeySchema = z
  .object({
    region: regionSchema,
    realm: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1)
  })
  .strict();

export const dossierSourceLabelSchema = z.enum([
  "submitted",
  "raiderio_declared",
  "fingerprint_derived",
  "manually_added"
]);

export const dossierEvidenceStateSchema = z.enum([
  "waiting",
  "scanning",
  "complete",
  "partial"
]);

export const dossierGuildSchema = z
  .object({
    name: z.string().min(1),
    region: regionSchema,
    realm: z.string().min(1)
  })
  .strict();

export const dossierCharacterSchema = z
  .object({
    key: characterKeySchema,
    displayName: z.string().min(1),
    className: z.string().min(1).nullable(),
    raiderIoUrl: z.url(),
    /**
     * The character's guild as at the snapshot. Optional as well as nullable:
     * snapshots committed before this field existed carry no guild at all, and
     * this schema is strict, so requiring it would make them unreadable.
     */
    guild: dossierGuildSchema.nullable().optional(),
    source: dossierSourceLabelSchema,
    evidenceState: dossierEvidenceStateSchema.optional(),
    /** A manually added character a reviewer has excluded from the evidence. */
    excluded: z.literal(true).optional(),
    /** @deprecated Use evidenceState for the precise scan state. */
    researchState: z.enum(["complete", "gathering"]).optional()
  })
  .strict();

export const applicantDossierParseMetricSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("available"),
      percentile: z.number().min(0).max(100),
      reportUrl: z.url()
    })
    .strict(),
  z.object({ state: z.literal("not_applicable") }).strict(),
  z.object({ state: z.literal("unavailable") }).strict()
]);

export const applicantDossierCharacterParsesSchema = z
  .object({
    character: z.string().min(1),
    spec: z
      .object({ name: z.string().min(1), iconUrl: z.url() })
      .strict()
      .nullable()
      .optional(),
    damage: applicantDossierParseMetricSchema,
    healing: applicantDossierParseMetricSchema,
    bossDamage: applicantDossierParseMetricSchema
  })
  .strict();

export const dossierFirstKillSchema = z
  .object({
    killedAt: z.iso.datetime(),
    guild: dossierGuildSchema.nullable(),
    historicWorldRank: z.number().int().positive().nullable(),
    reportUrl: z.url().nullable(),
    reportUrls: z.array(z.url()).optional(),
    characters: z.array(characterKeySchema),
    parses: z.array(applicantDossierCharacterParsesSchema)
  })
  .strict();

const dossierBossMetadata = {
  bossId: z.string().min(1),
  bossName: z.string().min(1),
  bossOrder: z.number().int().nonnegative(),
  imageUrl: z.url().nullable()
};

const dossierWipeSchema = z
  .object({
    attemptedAt: z.iso.datetime(),
    reportUrl: z.url(),
    characters: z.array(characterKeySchema).min(1)
  })
  .strict();

export const dossierBossSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...dossierBossMetadata,
      state: z.literal("kill"),
      firstKill: dossierFirstKillSchema,
      firstKills: z.array(dossierFirstKillSchema).min(1).optional(),
      bestParses: z.array(applicantDossierCharacterParsesSchema),
      wipes: z.array(dossierWipeSchema).optional()
    })
    .strict(),
  z
    .object({
      ...dossierBossMetadata,
      state: z.literal("wipe"),
      wipe: dossierWipeSchema,
      wipes: z.array(dossierWipeSchema).min(1).optional()
    })
    .strict(),
  z.object({ ...dossierBossMetadata, state: z.literal("no_logs") }).strict(),
  z.object({ ...dossierBossMetadata, state: z.literal("incomplete") }).strict()
]);

export const dossierRaidSchema = z
  .object({
    raidId: z.string().min(1),
    raidName: z.string().min(1),
    imageUrl: z.url().nullable(),
    cuttingEdge: z.literal(true).nullable(),
    bosses: z.array(dossierBossSchema)
  })
  .strict();

export const dossierCuttingEdgeSchema = z
  .object({
    achievementId: z.string().regex(/^\d+$/),
    achievementName: z.string().min(1),
    description: z.string().min(1),
    iconUrl: z.url().nullable(),
    completedAt: z.iso.datetime()
  })
  .strict();

export const dossierLimitationSchema = z
  .object({
    source: z.enum(["raiderio", "warcraft_logs", "blizzard"]),
    character: characterKeySchema.nullable(),
    code: z.enum([
      "not_found",
      "private",
      "rate_limited",
      "points_budget_low",
      "request_cap",
      "unavailable",
      "schema_changed",
      "parse_private",
      "parse_rate_limited",
      "parse_request_cap",
      "parse_unavailable",
      "parse_schema_drift",
      "current_content_window_unknown",
      "current_content_evidence_withheld",
      "unmatched_encounter"
    ]),
    message: z.string().min(1),
    observedAt: z.iso.datetime(),
    retryAt: z.iso.datetime().optional()
  })
  .strict();

export const dossierResearchSchema = z
  .object({
    state: z.enum(["initial", "gathering", "complete", "partial"]),
    message: z.string().min(1)
  })
  .strict();

export const createDossierRequestSchema = z
  .object({ characterUrl: z.url() })
  .strict();

/** Hides a manually added character from the dossier evidence, or restores it. */
export const connectedCharacterExclusionRequestSchema = z
  .object({ characterUrl: z.url(), excluded: z.boolean() })
  .strict();

export const dossierStartResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }).strict(),
  z
    .object({
      kind: z.literal("job"),
      jobId: z.uuid(),
      status: z.enum(["queued", "running", "retrying"])
    })
    .strict()
]);

export const applicantDossierSchema = z
  .object({
    root: characterKeySchema,
    research: dossierResearchSchema,
    characters: z.array(dossierCharacterSchema),
    raids: z.array(dossierRaidSchema),
    cuttingEdges: z.array(dossierCuttingEdgeSchema),
    limitations: z.array(dossierLimitationSchema),
    /**
     * When this dossier's evidence was last collected, as the oldest of its
     * characters' completed runs — so it reads as "everything is at least this
     * fresh" rather than flattering the dossier with the most recent one.
     * Null before anything has been collected, and absent on payloads written
     * before this field existed — including the frozen demo snapshot.
     */
    lastCollectedAt: z.string().datetime().nullable().optional()
  })
  .strict();

export type CharacterKey = z.infer<typeof characterKeySchema>;
export type DossierSourceLabel = z.infer<typeof dossierSourceLabelSchema>;
export type DossierEvidenceState = z.infer<typeof dossierEvidenceStateSchema>;
export type DossierCharacter = z.infer<typeof dossierCharacterSchema>;
export type DossierCuttingEdge = z.infer<typeof dossierCuttingEdgeSchema>;
export type DossierLimitation = z.infer<typeof dossierLimitationSchema>;
export type DossierResearch = z.infer<typeof dossierResearchSchema>;
export type ApplicantDossierParseMetric = z.infer<
  typeof applicantDossierParseMetricSchema
>;
export type ApplicantDossierCharacterParses = z.infer<
  typeof applicantDossierCharacterParsesSchema
>;
export type CreateDossierRequest = z.infer<typeof createDossierRequestSchema>;
export type ConnectedCharacterExclusionRequest = z.infer<
  typeof connectedCharacterExclusionRequestSchema
>;
export const dossierRefreshResponseSchema = z
  .object({
    /**
     * `full` re-collects the character's history. `light` reads only the most
     * recent reports, which is what a refresh inside its cooldown does, so the
     * control can say which happened rather than pretending they are the same.
     */
    mode: z.enum(["full", "light"]),
    lastCollectedAt: z.string().datetime().nullable()
  })
  .strict();
export type DossierRefreshResponse = z.infer<
  typeof dossierRefreshResponseSchema
>;
export type DossierStartResponse = z.infer<typeof dossierStartResponseSchema>;
export type ApplicantDossier = z.infer<typeof applicantDossierSchema>;
