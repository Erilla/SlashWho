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
  "fingerprint_derived"
]);

export const dossierCharacterSchema = z
  .object({
    key: characterKeySchema,
    displayName: z.string().min(1),
    source: dossierSourceLabelSchema
  })
  .strict();

export const dossierGuildSchema = z
  .object({
    name: z.string().min(1),
    realm: z.string().min(1)
  })
  .strict();

export const dossierFirstKillSchema = z
  .object({
    killedAt: z.iso.datetime(),
    guild: dossierGuildSchema.nullable(),
    historicWorldRank: z.number().int().positive().nullable(),
    reportUrl: z.url().nullable(),
    characters: z.array(z.string().min(1))
  })
  .strict();

export const dossierBossSchema = z
  .object({
    bossId: z.string().min(1),
    bossName: z.string().min(1),
    bossOrder: z.number().int().nonnegative(),
    firstKill: dossierFirstKillSchema,
    firstKills: z.array(dossierFirstKillSchema).min(1).optional()
  })
  .strict();

export const dossierRaidSchema = z
  .object({
    raidId: z.string().min(1),
    raidName: z.string().min(1),
    cuttingEdge: z.literal(true).nullable(),
    bosses: z.array(dossierBossSchema)
  })
  .strict();

export const dossierLimitationSchema = z
  .object({
    source: z.enum(["raiderio", "warcraft_logs"]),
    character: characterKeySchema.nullable(),
    code: z.enum([
      "not_found",
      "private",
      "rate_limited",
      "request_cap",
      "unavailable",
      "schema_changed"
    ]),
    message: z.string().min(1)
  })
  .strict();

export const dossierResearchSchema = z
  .object({
    state: z.enum(["initial", "complete", "partial"]),
    message: z.string().min(1)
  })
  .strict();

export const createDossierRequestSchema = z
  .object({ characterUrl: z.url() })
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
    limitations: z.array(dossierLimitationSchema)
  })
  .strict();

export type CharacterKey = z.infer<typeof characterKeySchema>;
export type DossierSourceLabel = z.infer<typeof dossierSourceLabelSchema>;
export type DossierCharacter = z.infer<typeof dossierCharacterSchema>;
export type DossierLimitation = z.infer<typeof dossierLimitationSchema>;
export type DossierResearch = z.infer<typeof dossierResearchSchema>;
export type CreateDossierRequest = z.infer<typeof createDossierRequestSchema>;
export type DossierStartResponse = z.infer<typeof dossierStartResponseSchema>;
export type ApplicantDossier = z.infer<typeof applicantDossierSchema>;
