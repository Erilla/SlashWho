import { z } from "zod";
import { characterSchema, snapshotStateSchema } from "./character";

export const historyItemSchema = z
  .object({
    id: z.uuid(),
    refreshedAt: z.iso.datetime(),
    state: snapshotStateSchema,
    characterCount: z.number().int().nonnegative(),
    url: z.string().startsWith("/api/v1/characters/"),
    characterUrl: z.string().startsWith("/characters/")
  })
  .strict();

export const historyPageSchema = z
  .object({
    items: z.array(historyItemSchema),
    nextCursor: z.string().min(1).nullable()
  })
  .strict();

export const historicalSnapshotSchema = z
  .object({
    id: z.uuid(),
    root: characterSchema,
    refreshedAt: z.iso.datetime(),
    state: snapshotStateSchema,
    characters: z.array(characterSchema)
  })
  .strict();

export type HistoryItem = z.infer<typeof historyItemSchema>;
export type HistoryPage = z.infer<typeof historyPageSchema>;
export type HistoricalSnapshot = z.infer<typeof historicalSnapshotSchema>;
