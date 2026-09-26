import {
  applicationConfigSchema,
  loadSharedConfig,
  optionalSecret,
  type ApplicationConfig,
  type Environment
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

function optionalWarcraftLogsCredentials(
  environment: Environment
): WarcraftLogsCredentials | undefined {
  const clientId = optionalSecret(environment.WARCRAFT_LOGS_CLIENT_ID);
  const clientSecret = optionalSecret(environment.WARCRAFT_LOGS_CLIENT_SECRET);
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new Error("incomplete_warcraft_logs_credentials");
  }
  const baseUrl = optionalSecret(environment.WARCRAFT_LOGS_BASE_URL);
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

export function loadWebConfig(
  environment: Environment = process.env
): WebConfig {
  const application = applicationConfigSchema.parse(environment);
  const shared = loadSharedConfig(environment);
  const accountMailFrom = optionalSecret(environment.ACCOUNT_EMAIL_FROM);
  return {
    databaseUrl: shared.databaseUrl,
    application,
    operatorAuth: {
      origin: operatorOrigin(environment.OPERATOR_ORIGIN, environment.NODE_ENV),
      sessionHashSecret: operatorSessionSecret(
        environment.OPERATOR_SESSION_HASH_SECRET
      )
    },
    accountCredentialEncryptionKey: shared.accountCredentialEncryptionKey,
    accountMail:
      optionalSecret(environment.RESEND_API_KEY) &&
      accountMailFrom &&
      shared.accountCredentialEncryptionKey
        ? {
            from: accountMailFrom,
            encryptionKey: shared.accountCredentialEncryptionKey
          }
        : undefined,
    dossier: {
      raiderIoBaseUrl: shared.raiderIoBaseUrl,
      raiderIoTimeoutMs: shared.raiderIoTimeoutMs,
      raiderIoAccessKey: shared.raiderIoAccessKey,
      blizzardClientId: shared.blizzardClientId,
      blizzardClientSecret: shared.blizzardClientSecret,
      evidenceJobCredentialEncryptionKey:
        shared.evidenceJobCredentialEncryptionKey,
      warcraftLogs: optionalWarcraftLogsCredentials(environment)
    }
  };
}
