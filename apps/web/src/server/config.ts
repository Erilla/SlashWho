import {
  applicationConfigSchema,
  parseEncryptionKey,
  type ApplicationConfig
} from "@slashwho/application";

export type WebConfig = Readonly<{
  databaseUrl: string;
  application: ApplicationConfig;
  operatorAuth: Readonly<{ origin: string; sessionHashSecret: string }>;
  accountCredentialEncryptionKey?: Buffer;
  accountMail?: Readonly<{
    from: string;
    encryptionKey: Buffer;
  }>;
  dossier: Readonly<{
    raiderIoBaseUrl: string;
    raiderIoTimeoutMs: number;
    raiderIoAccessKey?: string;
    blizzardClientId: string;
    blizzardClientSecret: string;
    evidenceJobCredentialEncryptionKey: Buffer;
    /**
     * Resolves pasted Warcraft Logs character-ID URLs. Optional: without it
     * the web process still serves everything else, and an ID URL reports
     * the upstream as unavailable.
     */
    warcraftLogs?: WarcraftLogsCredentials;
  }>;
}>;

export type WarcraftLogsCredentials = Readonly<{
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
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

function optionalWarcraftLogsCredentials(
  environment: Readonly<Record<string, string | undefined>>
): WarcraftLogsCredentials | undefined {
  const clientId = optionalSecret(environment.WARCRAFT_LOGS_CLIENT_ID);
  const clientSecret = optionalSecret(environment.WARCRAFT_LOGS_CLIENT_SECRET);
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new Error("incomplete_warcraft_logs_credentials");
  }
  const baseUrl = environment.WARCRAFT_LOGS_BASE_URL?.trim() || undefined;
  return { clientId, clientSecret, ...(baseUrl ? { baseUrl } : {}) };
}

function operatorOrigin(
  value: string | undefined,
  nodeEnvironment: string | undefined
): string {
  try {
    const url = new URL(value ?? "");
    if (url.protocol === "https:" && url.origin === value) return value;
    // E2E uses a dynamically allocated loopback HTTP port. This exception is
    // deliberately unavailable outside Node's test runtime; production still
    // accepts an exact HTTPS origin only, keeping Secure/__Host cookie policy.
    if (
      nodeEnvironment === "development" &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.origin === value
    )
      return value;
  } catch {
    /* Report only the authored code, never configuration values. */
  }
  throw new Error("invalid_operator_origin");
}

function operatorSessionSecret(value: string | undefined): string {
  if (!value || value.trim().length < 32)
    throw new Error("invalid_operator_session_hash_secret");
  return value;
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

function optionalAccountCredentialKey(
  environment: Readonly<Record<string, string | undefined>>
): Buffer | undefined {
  const authored = environment.ACCOUNT_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!authored) return undefined;
  const key = parseEncryptionKey(authored);
  if (
    key.equals(
      parseEncryptionKey(
        environment.EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY?.trim() ?? ""
      )
    )
  )
    throw new Error("account_credential_encryption_key_must_be_distinct");
  return key;
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
    operatorAuth: {
      origin: operatorOrigin(environment.OPERATOR_ORIGIN, environment.NODE_ENV),
      sessionHashSecret: operatorSessionSecret(
        environment.OPERATOR_SESSION_HASH_SECRET
      )
    },
    accountCredentialEncryptionKey: optionalAccountCredentialKey(environment),
    accountMail:
      environment.RESEND_API_KEY?.trim() &&
      environment.ACCOUNT_EMAIL_FROM?.trim() &&
      environment.ACCOUNT_CREDENTIAL_ENCRYPTION_KEY?.trim()
        ? {
            from: environment.ACCOUNT_EMAIL_FROM.trim(),
            encryptionKey: parseEncryptionKey(
              environment.ACCOUNT_CREDENTIAL_ENCRYPTION_KEY.trim()
            )
          }
        : undefined,
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
      ),
      warcraftLogs: optionalWarcraftLogsCredentials(environment)
    }
  };
}
