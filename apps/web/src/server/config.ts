import {
  applicationConfigSchema,
  type ApplicationConfig
} from "@slashwho/application";

export type WebConfig = Readonly<{
  databaseUrl: string;
  application: ApplicationConfig;
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

export function loadWebConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env
): WebConfig {
  return {
    databaseUrl: parseDatabaseUrl(environment.DATABASE_URL),
    application: applicationConfigSchema.parse(environment)
  };
}
