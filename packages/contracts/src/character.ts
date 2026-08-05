import { z } from "zod";

export const regionSchema = z.enum(["us", "eu", "kr", "tw"]);

export const characterSchema = z
  .object({
    region: regionSchema,
    realm: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    className: z.string().min(1),
    // Raider.IO reports 0 for characters it has seen but not yet levelled. The
    // normalizer in @slashwho/raiderio accepts any non-negative integer, and a
    // value it commits to an immutable snapshot must remain readable here forever.
    level: z.number().int().nonnegative(),
    raiderIoUrl: z.url().startsWith("https://raider.io/characters/")
  })
  .strict();

export const snapshotStateSchema = z.enum(["complete", "partial"]);

export const activeJobSchema = z
  .object({
    jobId: z.uuid(),
    status: z.enum(["queued", "running", "retrying"]),
    statusUrl: z.string().startsWith("/api/v1/searches/")
  })
  .strict();

export const currentSnapshotSchema = z
  .object({
    id: z.uuid(),
    state: snapshotStateSchema,
    refreshedAt: z.iso.datetime(),
    characterCount: z.number().int().nonnegative(),
    characters: z.array(characterSchema)
  })
  .strict();

export const characterResourceSchema = z
  .object({
    character: characterSchema,
    snapshot: currentSnapshotSchema,
    activeJob: activeJobSchema.nullable()
  })
  .strict();

export type Region = z.infer<typeof regionSchema>;
export type Character = z.infer<typeof characterSchema>;
export type SnapshotState = z.infer<typeof snapshotStateSchema>;
export type ActiveJob = z.infer<typeof activeJobSchema>;
export type CurrentSnapshot = z.infer<typeof currentSnapshotSchema>;
export type CharacterResource = z.infer<typeof characterResourceSchema>;
