import { z } from "zod";
import { characterResourceSchema } from "./character";
import { safeErrorDetailSchema } from "./errors";

export const createSearchRequestSchema = z
  .object({
    characterUrl: z.url()
  })
  .strict();

export const discoveryRunStatusSchema = z.enum([
  "queued",
  "running",
  "retrying",
  "complete",
  "failed"
]);

export const createSearchResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("character"),
      character: characterResourceSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("job"),
      jobId: z.uuid(),
      status: discoveryRunStatusSchema,
      statusUrl: z.string().startsWith("/api/v1/searches/"),
      characterUrl: z.string().startsWith("/characters/")
    })
    .strict()
]);

export const jobStatusResponseSchema = z
  .object({
    jobId: z.uuid(),
    status: discoveryRunStatusSchema,
    characterUrl: z.string().startsWith("/characters/"),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    retryAt: z.iso.datetime().nullable(),
    error: safeErrorDetailSchema.nullable()
  })
  .strict();

export type CreateSearchRequest = z.infer<typeof createSearchRequestSchema>;
export type DiscoveryRunStatus = z.infer<typeof discoveryRunStatusSchema>;
export type CreateSearchResponse = z.infer<typeof createSearchResponseSchema>;
export type JobStatusResponse = z.infer<typeof jobStatusResponseSchema>;
