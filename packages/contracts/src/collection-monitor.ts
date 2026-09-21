import { z } from "zod";

import { characterKeySchema } from "./dossier";

const timestampSchema = z.iso.datetime({ offset: true });

export const collectionMonitorInFlightRunSchema = z
  .object({
    character: characterKeySchema,
    status: z.enum(["queued", "running", "retrying"]),
    attempt: z.number().int().nonnegative(),
    startedAt: timestampSchema.nullable(),
    elapsedSeconds: z.number().int().nonnegative().nullable(),
    retryAfterAt: timestampSchema.nullable()
  })
  .strict();

export const collectionMonitorCompletedRunSchema = z
  .object({
    character: characterKeySchema,
    state: z.enum(["complete", "partial"]),
    limitationCode: z.string().min(1).nullable(),
    parseLimitationCode: z.string().min(1).nullable(),
    completedAt: timestampSchema.nullable(),
    evidenceVersion: z.number().int().positive()
  })
  .strict();

export const collectionMonitorFailedRunSchema = z
  .object({
    character: characterKeySchema,
    errorCode: z.string().min(1).nullable(),
    stoppedAt: timestampSchema.nullable()
  })
  .strict();

export const collectionMonitorResponseSchema = z
  .object({
    generatedAt: timestampSchema,
    hasActiveRuns: z.boolean(),
    inFlight: z.array(collectionMonitorInFlightRunSchema),
    completed: z.array(collectionMonitorCompletedRunSchema),
    failed: z.array(collectionMonitorFailedRunSchema)
  })
  .strict();

export type CollectionMonitorResponse = z.infer<
  typeof collectionMonitorResponseSchema
>;
