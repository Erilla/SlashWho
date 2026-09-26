import { parseEncryptionKey } from "./credential-encryption";

/**
 * The environment primitives both services read their configuration with.
 * The web and the worker used to carry a copy each, and the copies drifted:
 * one treated a blank value as unset and the other rejected it, one checked
 * that DATABASE_URL was a PostgreSQL URL and the other did not (#569). Every
 * helper here treats a blank or whitespace-only value as unset, because a
 * Railway variable can exist with an empty value, and every error carries only
 * an authored code, never the configured value.
 */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The trimmed value, or undefined when it is unset or blank. */
export function optionalSecret(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function requiredSecret(
  value: string | undefined,
  code: string
): string {
  const secret = optionalSecret(value);
  if (!secret) throw new Error(code);
  return secret;
}

export function positiveInteger(
  value: string | undefined,
  fallback: number,
  code: string
): number {
  const authored = optionalSecret(value);
  const parsed = authored === undefined ? fallback : Number(authored);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

/**
 * For a limit with no safe default. Unset reports `requiredCode` rather than
 * `invalidCode`, so a deploy that forgot the variable says so.
 */
export function requiredPositiveInteger(
  value: string | undefined,
  requiredCode: string,
  invalidCode: string
): number {
  const authored = optionalSecret(value);
  if (authored === undefined) throw new Error(requiredCode);
  return positiveInteger(authored, 0, invalidCode);
}

export function positiveNumber(
  value: string | undefined,
  fallback: number,
  code: string
): number {
  const authored = optionalSecret(value);
  const parsed = authored === undefined ? fallback : Number(authored);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

export function integerInRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string
): number {
  const authored = optionalSecret(value);
  const parsed = authored === undefined ? fallback : Number(authored);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(code);
  }
  return parsed;
}

export function optionalHttpUrl(
  value: string | undefined,
  code: string
): string | undefined {
  const authored = optionalSecret(value);
  if (authored === undefined) return undefined;
  try {
    const url = new URL(authored);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error();
    return authored;
  } catch {
    throw new Error(code);
  }
}

export function parseDatabaseUrl(value: string | undefined): string {
  const authored = optionalSecret(value);
  if (!authored) throw new Error("database_url_required");
  let parsed: URL;
  try {
    parsed = new URL(authored);
  } catch {
    throw new Error("invalid_database_url");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("invalid_database_url");
  }
  return authored;
}

export function requiredEncryptionKey(
  value: string | undefined,
  code: string
): Buffer {
  return parseEncryptionKey(requiredSecret(value, code));
}

export function optionalEncryptionKey(
  value: string | undefined
): Buffer | undefined {
  const authored = optionalSecret(value);
  return authored === undefined ? undefined : parseEncryptionKey(authored);
}
