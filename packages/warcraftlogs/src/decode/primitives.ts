/**
 * Narrowing for untrusted upstream JSON. Each returns null rather than
 * throwing, so a decoder can say which field drifted.
 */
import { isValidCharacterKey, type CharacterKey } from "@slashwho/domain";
import { nonEmptyString, record } from "@slashwho/upstream-http";

import type { WarcraftLogsLimitation } from "../types";

export const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

export { nonEmptyString, record };

export function isLimitation(value: unknown): value is WarcraftLogsLimitation {
  return record(value)?.kind === "limitation";
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
  if (!isValidCharacterKey(value)) throw new Error("invalid_character_key");
  return value;
}

export function normalizedIdentity(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

export function normalizedRealm(value: string): string {
  return value.replaceAll(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase("en-US");
}
