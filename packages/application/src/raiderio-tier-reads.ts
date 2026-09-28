import type { CharacterKey } from "@slashwho/domain";

const dayMs = 24 * 60 * 60 * 1_000;

/**
 * How long a settled Raider.IO tier's read stands before it is asked again.
 * Raider.IO can attach a logged encounter to an old kill later, or withdraw
 * one, and a name can change owner; a re-ask is one request per tier.
 */
export const RAIDER_IO_TIER_READ_TTL_MS = 90 * dayMs;
const MAX_OFFSET_DAYS = 14;

/**
 * A stable 0-14 day offset per character, so tiers marked in the same rollout
 * week do not all fall due on the same day. FNV-1a over the key.
 */
export function raiderIoTierReadOffsetMs(key: CharacterKey): number {
  let hash = 0x811c9dc5;
  for (const char of `${key.region}/${key.realm}/${key.name}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % (MAX_OFFSET_DAYS + 1)) * dayMs;
}

/** Marks read before this are expired for the character. */
export function raiderIoTierReadSince(key: CharacterKey, at: Date): Date {
  return new Date(
    at.getTime() - RAIDER_IO_TIER_READ_TTL_MS - raiderIoTierReadOffsetMs(key)
  );
}
