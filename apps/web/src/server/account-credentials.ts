import { hkdfSync } from "node:crypto";
import { decryptCredential, encryptCredential } from "@slashwho/application";
import type {
  AccountCredentialProvider,
  AccountCredentialRepository
} from "@slashwho/database";

export type ProviderCredentials =
  | Readonly<{ clientId: string; clientSecret: string }>
  | Readonly<{ accessKey: string }>;
export type ProviderPresence = Readonly<{
  provider: AccountCredentialProvider;
  present: boolean;
  version: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}>;

const providers = ["blizzard", "raiderio", "warcraftlogs"] as const;

export function validProvider(
  value: unknown
): value is AccountCredentialProvider {
  return providers.some((provider) => provider === value);
}

export function validValues(
  provider: AccountCredentialProvider,
  value: unknown
): value is ProviderCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  const expected =
    provider === "raiderio" ? ["accessKey"] : ["clientId", "clientSecret"];
  return (
    Object.keys(fields).length === expected.length &&
    expected.every(
      (key) =>
        typeof fields[key] === "string" &&
        (fields[key] as string).trim().length > 0 &&
        (fields[key] as string).length <= 2048
    )
  );
}

export function createAccountCredentials(
  repository: AccountCredentialRepository,
  masterKey: Buffer
) {
  if (masterKey.length !== 32)
    throw new Error("invalid_account_credential_encryption_key");
  const key = Buffer.from(
    hkdfSync("sha256", masterKey, "", "account-provider-credentials-v1", 32)
  );
  return {
    async summary(accountId: string): Promise<ProviderPresence[]> {
      const rows = await repository.list(accountId);
      return providers.map((provider) => {
        const row = rows.find((item) => item.provider === provider);
        return {
          provider,
          present: Boolean(row?.encryptedPayload),
          version: row?.version ?? 0,
          createdAt: row?.createdAt ?? null,
          updatedAt: row?.updatedAt ?? null
        };
      });
    },
    async replace(
      accountId: string,
      provider: AccountCredentialProvider,
      values: ProviderCredentials,
      expectedVersion = 0
    ): Promise<"saved" | "conflict"> {
      if (
        !validValues(provider, values) ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0
      )
        throw new Error("invalid_account_credentials");
      return repository.replace({
        accountId,
        provider,
        encryptedPayload: encryptCredential(JSON.stringify(values), key),
        expectedVersion,
        at: new Date()
      });
    },
    async remove(
      accountId: string,
      provider: AccountCredentialProvider,
      expectedVersion?: number
    ): Promise<boolean> {
      return repository.remove(
        accountId,
        provider,
        new Date(),
        expectedVersion
      );
    },
    async resolve(
      accountId: string,
      provider: AccountCredentialProvider
    ): Promise<{ values: ProviderCredentials; version: number } | null> {
      const row = await repository.get(accountId, provider);
      if (!row?.encryptedPayload) return null;
      return {
        values: JSON.parse(
          decryptCredential(row.encryptedPayload, key)
        ) as ProviderCredentials,
        version: row.version
      };
    }
  };
}
