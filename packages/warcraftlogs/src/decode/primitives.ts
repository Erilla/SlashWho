/**
 * Narrowing for untrusted upstream JSON. Each returns null rather than
 * throwing, so a decoder can say which field drifted.
 */
import { supportedRegions, type CharacterKey } from "@slashwho/domain";

import type { WarcraftLogsLimitation } from "../types";

export const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isLimitation(value: unknown): value is WarcraftLogsLimitation {
  return record(value)?.kind === "limitation";
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

export function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function nonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function positiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function validTimestampMilliseconds(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DATE_MILLISECONDS
    ? value
    : null;
}

export function validCharacterKey(value: CharacterKey): CharacterKey {
  const valid =
    supportedRegions.includes(value.region) &&
    /^[a-z0-9-]+$/.test(value.realm) &&
    /^[\p{L}\p{M}'-]+$/u.test(value.name) &&
    value.realm === value.realm.toLocaleLowerCase("en-US") &&
    value.name === value.name.toLocaleLowerCase("en-US");
  if (!valid) throw new Error("invalid_character_key");
  return value;
}

export function normalizedIdentity(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

export function normalizedRealm(value: string): string {
  return value.replaceAll(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase("en-US");
}
