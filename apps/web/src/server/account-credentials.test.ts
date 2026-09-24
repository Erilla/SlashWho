import { describe, expect, it } from "vitest";
import type {
  AccountCredentialRepository,
  AccountCredentialRecord,
  AccountCredentialProvider
} from "@slashwho/database";
import { createAccountCredentials, validValues } from "./account-credentials";

function fixture() {
  const rows = new Map<string, AccountCredentialRecord>();
  const id = (accountId: string, provider: AccountCredentialProvider) =>
    `${accountId}:${provider}`;
  const repository: AccountCredentialRepository = {
    async list(accountId) {
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(`${accountId}:`))
        .map(([, row]) => row);
    },
    async get(accountId, provider) {
      return rows.get(id(accountId, provider)) ?? null;
    },
    async replace(input) {
      const key = id(input.accountId, input.provider);
      const prior = rows.get(key);
      if ((prior?.version ?? 0) !== input.expectedVersion) return "conflict";
      rows.set(key, {
        provider: input.provider,
        encryptedPayload: input.encryptedPayload,
        version: (prior?.version ?? 0) + 1,
        createdAt: prior?.createdAt ?? input.at,
        updatedAt: input.at
      });
      return "saved";
    },
    async remove(accountId, provider, at, expectedVersion) {
      const key = id(accountId, provider);
      const prior = rows.get(key);
      if (
        !prior ||
        (expectedVersion !== undefined && prior.version !== expectedVersion)
      )
        return false;
      if (prior)
        rows.set(key, {
          ...prior,
          encryptedPayload: null,
          version: prior.version + 1,
          updatedAt: at
        });
      return true;
    }
  };
  return { rows, repository };
}

describe("account credentials", () => {
  it("encrypts provider values, isolates owners, and exposes metadata only", async () => {
    const { rows, repository } = fixture();
    const service = createAccountCredentials(repository, Buffer.alloc(32, 42));
    expect(
      await service.replace("alice", "warcraftlogs", {
        clientId: "id-a",
        clientSecret: "secret-a"
      })
    ).toBe("saved");
    expect(rows.get("alice:warcraftlogs")?.encryptedPayload).not.toContain(
      "secret-a"
    );
    expect(JSON.stringify(await service.summary("alice"))).not.toContain(
      "secret-a"
    );
    expect((await service.summary("bob")).every((slot) => !slot.present)).toBe(
      true
    );
    expect(await service.resolve("bob", "warcraftlogs")).toBeNull();
    expect(await service.resolve("alice", "warcraftlogs")).toEqual({
      values: { clientId: "id-a", clientSecret: "secret-a" },
      version: 1
    });
    expect(
      await service.replace("alice", "warcraftlogs", {
        clientId: "id-b",
        clientSecret: "secret-b"
      })
    ).toBe("conflict");
    await service.remove("alice", "warcraftlogs");
    expect(await service.resolve("alice", "warcraftlogs")).toBeNull();
    expect((await service.summary("alice"))[2]).toMatchObject({
      present: false,
      version: 2
    });
  });

  it("rejects partial and extra provider values", () => {
    expect(validValues("blizzard", { clientId: "id" })).toBe(false);
    expect(
      validValues("warcraftlogs", { clientId: "id", clientSecret: "" })
    ).toBe(false);
    expect(validValues("raiderio", { accessKey: "key", extra: "secret" })).toBe(
      false
    );
  });
});
