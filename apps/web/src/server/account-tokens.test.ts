import { describe, expect, it } from "vitest";
import { decryptAccountMail } from "@slashwho/application";
import type { AccountCredential, Repositories } from "@slashwho/database";
import { hashOperatorCredential } from "./operator-auth";
import { createAccountTokens } from "./account-tokens";

const at = new Date("2026-09-23T12:00:00Z");
const password = "registration-password-123456";
const key = Buffer.alloc(32, 7);

async function fixture() {
  const credential: AccountCredential = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    canonicalEmail: "person@example.com",
    email: "person@example.com",
    role: "user",
    active: true,
    verifiedAt: null,
    passwordChangeRequired: false,
    credentialVersion: 1,
    createdAt: at,
    updatedAt: at,
    ...(await hashOperatorCredential(password))
  };
  const mail: Array<{
    purpose: string;
    tokenDigest: string;
    encryptedMessage: string;
    expiresAt: Date;
  }> = [];
  const admissions: Array<{ purpose: string; subjectHash: string }> = [];
  const repository = {
    admitRequest: async (input: { purpose: string; subjectHash: string }) => {
      admissions.push(input);
      return (
        admissions.filter(
          (value) =>
            value.purpose === input.purpose &&
            value.subjectHash === input.subjectHash
        ).length <= 1
      );
    },
    findAccountById: async (id: string) =>
      id === credential.id ? credential : null,
    findAccountByEmail: async (email: string) =>
      email === credential.canonicalEmail ? credential : null,
    findToken: async ({
      digest,
      purpose,
      at: time
    }: {
      digest: string;
      purpose: string;
      at: Date;
    }) =>
      mail.some(
        (item) =>
          item.tokenDigest === digest &&
          item.purpose === purpose &&
          item.expiresAt > time
      )
        ? credential
        : null,
    confirmVerification: async ({
      digest,
      passwordHash
    }: {
      digest: string;
      passwordHash: string;
    }) =>
      mail.some((item) => item.tokenDigest === digest) &&
      passwordHash === credential.passwordHash,
    completeReset: async ({ digest }: { digest: string }) =>
      mail.some((item) => item.tokenDigest === digest),
    issueEmailChange: async () => true,
    confirmEmailChange: async () => "invalid" as const
  };
  const accountMail = {
    issue: async (input: {
      purpose: string;
      tokenDigest: string;
      encryptedMessage: string;
      expiresAt: Date;
    }) => {
      mail.push(input);
    }
  };
  const service = createAccountTokens({
    repositories: {
      accountTokens: repository,
      accountMail
    } as unknown as Repositories,
    tokenHashSecret: "h".repeat(32),
    encryptionKey: key,
    origin: "https://slashwho.example",
    from: "Accounts <accounts@example.com>"
  });
  return { service, credential, mail, admissions };
}

describe("account tokens", () => {
  it("issues an encrypted verification link that needs the registration password", async () => {
    const f = await fixture();
    await f.service.issueVerification(f.credential.id, at);
    const message = JSON.parse(
      decryptAccountMail(f.mail[0]!.encryptedMessage, key)
    );
    const token = new URL(
      message.text.match(/https:\/\/\S+/)![0]
    ).searchParams.get("token")!;
    expect(f.mail[0]!.expiresAt).toEqual(new Date(at.getTime() + 86_400_000));
    expect(f.mail[0]!.tokenDigest).not.toContain(token);
    expect(
      await f.service.confirmVerification(
        token,
        "wrong-password-1234567890",
        at
      )
    ).toBe("invalid");
    expect(await f.service.confirmVerification(token, password, at)).toBe(
      "verified"
    );
  });

  it("returns the same response for unknown and disabled reset addresses", async () => {
    const f = await fixture();
    await expect(
      f.service.requestReset("missing@example.com", at)
    ).resolves.toBeUndefined();
    expect(f.mail).toHaveLength(0);
    await f.service.requestReset(" PERSON@EXAMPLE.COM ", at);
    expect(f.mail[0]!.purpose).toBe("reset");
    expect(f.mail[0]!.expiresAt).toEqual(new Date(at.getTime() + 1_800_000));
  });

  it("checks reset admission before looking up an address", async () => {
    const f = await fixture();
    await f.service.requestReset("person@example.com", at);
    await f.service.requestReset("person@example.com", at);
    expect(f.mail).toHaveLength(1);
    expect(f.admissions.map((admission) => admission.purpose)).toEqual([
      "reset",
      "reset"
    ]);
  });
});
