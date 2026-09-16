import {
  applicationConfigSchema,
  parseEncryptionKey,
  type ApplicationConfig
} from "@slashwho/application";

export type WebConfig = Readonly<{
  databaseUrl: string;
  application: ApplicationConfig;
  dossier: Readonly<{
    raiderIoBaseUrl: string;
    raiderIoTimeoutMs: number;
    raiderIoAccessKey?: string;
    blizzardClientId: string;
    blizzardClientSecret: string;
    evidenceJobCredentialEncryptionKey: Buffer;
  }>;
}>;

function parseDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error("database_url_required");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid_database_url");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("invalid_database_url");
  }
  return value;
}

function optionalSecret(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function requiredSecret(value: string | undefined, errorCode: string): string {
  const secret = value?.trim();
  if (!secret) throw new Error(errorCode);
  return secret;
}

function requiredEncryptionKey(value: string | undefined): Buffer {
  const secret = value?.trim();
  if (!secret) {
    throw new Error("evidence_job_credential_encryption_key_required");
  }
  return parseEncryptionKey(secret);
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  errorCode: string
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(errorCode);
  return parsed;
}

export function loadWebConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env
): WebConfig {
  const application = applicationConfigSchema.parse(environment);
  return {
    databaseUrl: parseDatabaseUrl(environment.DATABASE_URL),
    application,
    dossier: {
      raiderIoBaseUrl:
        environment.RAIDER_IO_BASE_URL?.trim() || "https://raider.io",
      raiderIoTimeoutMs: positiveInteger(
        environment.RAIDER_IO_TIMEOUT_MS,
        10_000,
        "invalid_raider_io_timeout_ms"
      ),
      raiderIoAccessKey: optionalSecret(environment.RAIDER_IO_ACCESS_KEY),
      blizzardClientId: requiredSecret(
        environment.BLIZZARD_CLIENT_ID,
        "blizzard_client_id_required"
      ),
      blizzardClientSecret: requiredSecret(
        environment.BLIZZARD_CLIENT_SECRET,
        "blizzard_client_secret_required"
      ),
      evidenceJobCredentialEncryptionKey: requiredEncryptionKey(
        environment.EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY
      )
    }
  };
}
