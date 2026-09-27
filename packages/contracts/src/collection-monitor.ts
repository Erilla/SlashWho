import { z } from "zod";

import { characterKeySchema, collectionPhaseSchema } from "./dossier";

const timestampSchema = z.iso.datetime({ offset: true });

/**
 * Why an evidence run was queued: the path that reserved it (#708). A class,
 * never an identity -- no visitor, account, request URL or referrer.
 * `unknown` is a run reserved before origins were recorded, and is never a
 * guess at which path that was.
 */
export const evidenceRunOriginSchema = z.enum([
  "dossier_initial",
  "dossier_read",
  "refresh",
  "rebuild",
  "historic_alias",
  "tier_search",
  "resume_sweep",
  "applicant_sheet",
  "fingerprint_admission",
  "unknown"
]);

export type EvidenceRunOrigin = z.infer<typeof evidenceRunOriginSchema>;

/** Every origin a reservation can be made with; `unknown` is history only. */
export type EvidenceRunRequestOrigin = Exclude<EvidenceRunOrigin, "unknown">;

/** How many more completed runs the monitor reveals each time it loads more. */
export const collectionMonitorCompletedPageSize = 50;
/** The most completed runs one monitor read returns, however far it scrolls. */
export const collectionMonitorCompletedLimitMax = 1_000;

export const collectionMonitorInFlightRunSchema = z
  .object({
    character: characterKeySchema,
    status: z.enum(["queued", "running", "retrying"]),
    origin: evidenceRunOriginSchema,
    attempt: z.number().int().nonnegative(),
    startedAt: timestampSchema.nullable(),
    elapsedSeconds: z.number().int().nonnegative().nullable(),
    retryAfterAt: timestampSchema.nullable(),
    /** The run's steps, as the dossier shows them; absent without a ledger. */
    collectionProgress: z.array(collectionPhaseSchema).min(1).optional()
  })
  .strict();

export const collectionMonitorCompletedRunSchema = z
  .object({
    character: characterKeySchema,
    state: z.enum(["complete", "partial"]),
    origin: evidenceRunOriginSchema,
    limitationCode: z.string().min(1).nullable(),
    parseLimitationCode: z.string().min(1).nullable(),
    completedAt: timestampSchema.nullable(),
    evidenceVersion: z.number().int().positive()
  })
  .strict();

export const collectionMonitorFailedRunSchema = z
  .object({
    character: characterKeySchema,
    origin: evidenceRunOriginSchema,
    errorCode: z.string().min(1).nullable(),
    stoppedAt: timestampSchema.nullable()
  })
  .strict();

export const collectionMonitorDiscoveryRunSchema = z
  .object({
    character: characterKeySchema,
    status: z.enum(["queued", "running", "retrying", "complete", "failed"]),
    attempt: z.number().int().nonnegative(),
    requestedAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    errorCode: z.string().min(1).nullable()
  })
  .strict();

export const collectionMonitorResponseSchema = z
  .object({
    generatedAt: timestampSchema,
    hasActiveRuns: z.boolean(),
    inFlight: z.array(collectionMonitorInFlightRunSchema),
    /** The most recently completed runs, newest first, up to the requested limit. */
    completed: z.array(collectionMonitorCompletedRunSchema),
    /** Whether older completed runs exist beyond the ones returned. */
    hasMoreCompleted: z.boolean(),
    failed: z.array(collectionMonitorFailedRunSchema),
    /** The most recently requested discovery runs, newest first. */
    discoveryRuns: z.array(collectionMonitorDiscoveryRunSchema)
  })
  .strict();

export type CollectionMonitorResponse = z.infer<
  typeof collectionMonitorResponseSchema
>;
