import {
  applicationConfigSchema,
  type ApplicationConfig
} from "@slashwho/application";

export type WebConfig = Readonly<{
  databaseUrl: string;
  application: ApplicationConfig;
  dossier: Readonly<{
    raiderIoBaseUrl: string;
    raiderIoTimeoutMs: number;
    warcraftLogsClientId: string;
    warcraftLogsClientSecret: string;
    warcraftLogsBaseUrl?: string;
    blizzardClientId: string;
    blizzardClientSecret: string;
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

function requiredSecret(value: string | undefined, errorCode: string): string {
  const secret = value?.trim();
  if (!secret) throw new Error(errorCode);
  return secret;
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
      warcraftLogsClientId: requiredSecret(
        environment.WARCRAFT_LOGS_CLIENT_ID,
        "warcraft_logs_client_id_required"
      ),
      warcraftLogsClientSecret: requiredSecret(
        environment.WARCRAFT_LOGS_CLIENT_SECRET,
        "warcraft_logs_client_secret_required"
      ),
      warcraftLogsBaseUrl:
        environment.WARCRAFT_LOGS_BASE_URL?.trim() || undefined,
      blizzardClientId: requiredSecret(
        environment.BLIZZARD_CLIENT_ID,
        "blizzard_client_id_required"
      ),
      blizzardClientSecret: requiredSecret(
        environment.BLIZZARD_CLIENT_SECRET,
        "blizzard_client_secret_required"
      )
    }
  };
}
