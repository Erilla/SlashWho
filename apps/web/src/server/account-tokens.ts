import { createHmac, randomBytes } from "node:crypto";
import { encryptAccountMail } from "@slashwho/application";
import type { AccountTokenPurpose, Repositories } from "@slashwho/database";
import { canonicalizeEmail } from "./account-email";
import { hashOperatorCredential, verifyCredential } from "./operator-auth";

const day = 86_400_000;
const halfHour = 1_800_000;

export function createAccountTokens(config: {
  repositories: Pick<Repositories, "accountTokens" | "accountMail">;
  tokenHashSecret: string;
  encryptionKey: Buffer;
  origin: string;
  from: string;
}) {
  const { accountTokens: repository, accountMail } = config.repositories;
  function addressSubject(purpose: "verify" | "reset", canonicalEmail: string) {
    return createHmac("sha256", config.tokenHashSecret)
      .update(`account-${purpose}\0${canonicalEmail}`)
      .digest("hex");
  }
  async function admit(
    purpose: "verify" | "reset",
    canonicalEmail: string,
    at: Date
  ) {
    return repository.admitRequest({
      purpose,
      subjectHash: addressSubject(purpose, canonicalEmail),
      limit: purpose === "verify" ? 3 : 5,
      expiresAt: new Date(
        at.getTime() + (purpose === "verify" ? day : 3_600_000)
      ),
      at
    });
  }
  function digest(purpose: AccountTokenPurpose, token: string) {
    return createHmac("sha256", config.tokenHashSecret)
      .update(purpose)
      .update("\0")
      .update(token)
      .digest("hex");
  }
  function message(
    destination: string,
    purpose: AccountTokenPurpose,
    token: string
  ) {
    const path =
      purpose === "verify"
        ? "/verify-email"
        : purpose === "reset"
          ? "/recover-password"
          : "/change-email";
    const link = new URL(path, config.origin);
    link.searchParams.set("token", token);
    return encryptAccountMail(
      JSON.stringify({
        from: config.from,
        to: [destination],
        subject:
          purpose === "verify"
            ? "Verify your SlashWho email"
            : purpose === "reset"
              ? "Reset your SlashWho password"
              : "Confirm your SlashWho email change",
        text: `Open this link to continue: ${link.toString()}`
      }),
      config.encryptionKey
    );
  }
  async function issue(
    accountId: string,
    destination: string,
    purpose: "verify" | "reset",
    at: Date
  ) {
    const token = randomBytes(32).toString("base64url");
    await accountMail.issue({
      accountId,
      destination,
      purpose,
      tokenDigest: digest(purpose, token),
      encryptedMessage: message(destination, purpose, token),
      expiresAt: new Date(
        at.getTime() + (purpose === "reset" ? halfHour : day)
      ),
      at
    });
  }
  return {
    async issueVerification(accountId: string, at: Date): Promise<void> {
      const account = await repository.findAccountById(accountId);
      if (
        !account?.active ||
        account.verifiedAt ||
        account.createdAt.getTime() <= at.getTime() - 7 * day
      )
        return;
      if (!(await admit("verify", account.canonicalEmail, at))) return;
      await issue(accountId, account.email, "verify", at);
    },
    async confirmVerification(
      token: string,
      password: string,
      at: Date
    ): Promise<"verified" | "invalid"> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return "invalid";
      const tokenDigest = digest("verify", token);
      const account = await repository.findToken({
        digest: tokenDigest,
        purpose: "verify",
        at
      });
      if (
        !account ||
        account.verifiedAt ||
        !(await verifyCredential(password, account))
      )
        return "invalid";
      return (await repository.confirmVerification({
        digest: tokenDigest,
        passwordHash: account.passwordHash,
        at
      }))
        ? "verified"
        : "invalid";
    },
    async requestReset(email: string, at: Date): Promise<void> {
      const canonical = canonicalizeEmail(email);
      if (!canonical) return;
      if (!(await admit("reset", canonical, at))) return;
      const account = await repository.findAccountByEmail(canonical);
      if (
        !account?.active ||
        (!account.verifiedAt &&
          account.createdAt.getTime() <= at.getTime() - 7 * day)
      )
        return;
      await issue(account.id, account.email, "reset", at);
    },
    async completeReset(
      token: string,
      newPassword: string,
      at: Date
    ): Promise<"changed" | "invalid"> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return "invalid";
      const tokenDigest = digest("reset", token);
      if (
        !(await repository.findToken({
          digest: tokenDigest,
          purpose: "reset",
          at
        }))
      )
        return "invalid";
      const password = await hashOperatorCredential(newPassword);
      return (await repository.completeReset({
        digest: tokenDigest,
        ...password,
        at
      }))
        ? "changed"
        : "invalid";
    },
    async requestEmailChange(
      accountId: string,
      password: string,
      newEmail: string,
      at: Date
    ): Promise<void> {
      const canonical = canonicalizeEmail(newEmail);
      const account = await repository.findAccountById(accountId);
      if (
        !canonical ||
        !account?.active ||
        !account.verifiedAt ||
        canonical === account.canonicalEmail ||
        !(await verifyCredential(password, account))
      )
        return;
      const currentToken = randomBytes(32).toString("base64url");
      const nextToken = randomBytes(32).toString("base64url");
      await repository.issueEmailChange({
        accountId,
        expectedPasswordHash: account.passwordHash,
        canonicalEmail: canonical,
        email: canonical,
        current: {
          digest: digest("email_change_current", currentToken),
          encryptedMessage: message(
            account.email,
            "email_change_current",
            currentToken
          )
        },
        next: {
          digest: digest("email_change_new", nextToken),
          encryptedMessage: message(canonical, "email_change_new", nextToken)
        },
        expiresAt: new Date(at.getTime() + day),
        at
      });
    },
    async confirmEmailChange(
      token: string,
      at: Date
    ): Promise<"pending" | "changed" | "invalid"> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return "invalid";
      // The digest is bound to purpose; only one purpose can match a token.
      for (const purpose of [
        "email_change_current",
        "email_change_new"
      ] as const) {
        const result = await repository.confirmEmailChange({
          digest: digest(purpose, token),
          purpose,
          at
        });
        if (result !== "invalid") return result;
      }
      return "invalid";
    }
  };
}
