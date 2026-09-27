import type { Pool } from "pg";
import { createAccountCredentials } from "../../apps/web/src/server/account-credentials";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  eventually,
  resetRepositoryTables,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

/**
 * Account registration, sessions, email changes, admin roles, the mail
 * outbox and admission limits, and operator authentication.
 *
 * Split from one file so each area runs in parallel with its own PostgreSQL;
 * the shared set-up is in `repository-fixtures.ts`.
 */
describe("PostgreSQL repositories: accounts and operators", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repositories: TestRepositories;

  beforeAll(async () => {
    ({ pool, stop, repositories } = await startRepositoryDatabase());
  });

  beforeEach(async () => {
    await resetRepositoryTables(pool);
  });

  afterAll(async () => {
    await stop();
  });

  const registration = (canonicalEmail: string, at: Date) => ({
    canonicalEmail,
    email: canonicalEmail,
    passwordHash: "derived-password-hash",
    passwordSalt: "derived-password-salt",
    scryptVersion: 1,
    scryptCost: 16_384,
    at
  });

  it("uses live account state and atomically revokes all sessions on password change", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.provisionAdmin(
      registration("session@example.com", at)
    );
    expect(
      (await repositories.accountAuth.findCredential("session@example.com"))?.id
    ).toBe(account.id);
    const issue = (id: string) =>
      repositories.accountAuth.issueSession({
        sessionId: id,
        secretDigest: `${id}-secret`,
        accountId: account.id,
        credentialVersion: 1,
        issuedAt: at,
        lastUsedAt: at,
        idleExpiresAt: new Date(at.getTime() + 30 * 60_000),
        absoluteExpiresAt: new Date(at.getTime() + 8 * 60 * 60_000)
      });
    const first = await issue(crypto.randomUUID());
    const second = await issue(crypto.randomUUID());
    if (!first || !second) throw new Error("expected sessions");
    const use = (id: string) =>
      repositories.accountAuth.useSession({
        sessionId: id,
        secretDigest: `${id}-secret`,
        at: new Date(at.getTime() + 60_000),
        idleExpiresAt: new Date(at.getTime() + 31 * 60_000)
      });
    expect((await use(first.id))?.account.passwordChangeRequired).toBe(true);
    await pool.query("UPDATE accounts SET role = 'user' WHERE id = $1", [
      account.id
    ]);
    expect((await use(first.id))?.account.role).toBe("user");
    expect(
      await repositories.accountAuth.changePassword({
        accountId: account.id,
        sessionId: first.id,
        expectedCredentialVersion: 1,
        expectedPasswordHash: "wrong",
        passwordHash: "new-hash",
        passwordSalt: "new-salt",
        scryptVersion: 1,
        scryptCost: 16_384,
        at: new Date(at.getTime() + 2 * 60_000)
      })
    ).toBe(false);
    expect(
      await repositories.accountAuth.changePassword({
        accountId: account.id,
        sessionId: first.id,
        expectedCredentialVersion: 1,
        expectedPasswordHash: "derived-password-hash",
        passwordHash: "new-hash",
        passwordSalt: "new-salt",
        scryptVersion: 1,
        scryptCost: 16_384,
        at: new Date(at.getTime() + 2 * 60_000)
      })
    ).toBe(true);
    expect(await use(first.id)).toBeNull();
    expect(await use(second.id)).toBeNull();
    expect(
      await repositories.accountAuth.findCredential("session@example.com")
    ).toMatchObject({
      passwordHash: "new-hash",
      credentialVersion: 2,
      passwordChangeRequired: false
    });
  });

  it("rejects account sessions for each independent live-state and expiry predicate", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.provisionAdmin(
      registration("predicates@example.com", at)
    );
    const session = await repositories.accountAuth.issueSession({
      sessionId: crypto.randomUUID(),
      secretDigest: "predicate-secret",
      accountId: account.id,
      credentialVersion: 1,
      issuedAt: at,
      lastUsedAt: at,
      idleExpiresAt: new Date(at.getTime() + 30 * 60_000),
      absoluteExpiresAt: new Date(at.getTime() + 8 * 60 * 60_000)
    });
    if (!session) throw new Error("expected session");
    const use = (atUse: Date) =>
      repositories.accountAuth.useSession({
        sessionId: session.id,
        secretDigest: "predicate-secret",
        at: atUse,
        idleExpiresAt: new Date(atUse.getTime() + 30 * 60_000)
      });
    const early = new Date(at.getTime() + 60_000);
    expect((await use(early))?.account.id).toBe(account.id);
    await pool.query("UPDATE accounts SET active = false WHERE id = $1", [
      account.id
    ]);
    expect(await use(early)).toBeNull();
    await pool.query(
      "UPDATE accounts SET active = true, verified_at = NULL WHERE id = $1",
      [account.id]
    );
    expect(await use(early)).toBeNull();
    await pool.query(
      "UPDATE accounts SET verified_at = $2, credential_version = 2 WHERE id = $1",
      [account.id, at]
    );
    expect(await use(early)).toBeNull();
    await pool.query(
      "UPDATE accounts SET credential_version = 1 WHERE id = $1",
      [account.id]
    );
    expect((await use(early))?.account.id).toBe(account.id);
    expect(await use(new Date(early.getTime() + 30 * 60_000))).toBeNull();
    await pool.query(
      "UPDATE account_sessions SET idle_expires_at = $2 WHERE id = $1",
      [session.id, new Date(at.getTime() + 9 * 60 * 60_000)]
    );
    expect(await use(new Date(at.getTime() + 8 * 60 * 60_000))).toBeNull();
    const persisted = await pool.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM account_sessions WHERE id = $1",
      [session.id]
    );
    expect(persisted.rows[0]?.revoked_at).toBeNull();
  });

  it("renews an account session with no absolute lifetime on idle alone", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const day = 24 * 60 * 60_000;
    const account = await repositories.accountAuth.provisionAdmin(
      registration("persistent@example.com", at)
    );
    const session = await repositories.accountAuth.issueSession({
      sessionId: crypto.randomUUID(),
      secretDigest: "persistent-secret",
      accountId: account.id,
      credentialVersion: 1,
      issuedAt: at,
      lastUsedAt: at,
      idleExpiresAt: new Date(at.getTime() + 400 * day),
      absoluteExpiresAt: null
    });
    expect(session?.absoluteExpiresAt).toBeNull();
    if (!session) throw new Error("expected session");
    const use = (atUse: Date) =>
      repositories.accountAuth.useSession({
        sessionId: session.id,
        secretDigest: "persistent-secret",
        at: atUse,
        idleExpiresAt: new Date(atUse.getTime() + 400 * day)
      });
    const later = new Date(at.getTime() + 399 * day);
    expect(await use(later)).toMatchObject({
      session: {
        idleExpiresAt: new Date(later.getTime() + 400 * day),
        absoluteExpiresAt: null
      }
    });
    const muchLater = new Date(later.getTime() + 399 * day);
    expect((await use(muchLater))?.account.id).toBe(account.id);
    expect(
      await repositories.accountAuth.changePassword({
        accountId: account.id,
        sessionId: session.id,
        expectedCredentialVersion: 1,
        expectedPasswordHash: "derived-password-hash",
        passwordHash: "new-hash",
        passwordSalt: "new-salt",
        scryptVersion: 1,
        scryptCost: 16_384,
        at: muchLater
      })
    ).toBe(true);
    expect(await use(muchLater)).toBeNull();
  });

  it("rejects an uncapped account session once its idle window lapses", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const day = 24 * 60 * 60_000;
    const account = await repositories.accountAuth.provisionAdmin(
      registration("lapsed@example.com", at)
    );
    const session = await repositories.accountAuth.issueSession({
      sessionId: crypto.randomUUID(),
      secretDigest: "lapsed-secret",
      accountId: account.id,
      credentialVersion: 1,
      issuedAt: at,
      lastUsedAt: at,
      idleExpiresAt: new Date(at.getTime() + 400 * day),
      absoluteExpiresAt: null
    });
    if (!session) throw new Error("expected session");
    const atUse = new Date(at.getTime() + 400 * day);
    expect(
      await repositories.accountAuth.useSession({
        sessionId: session.id,
        secretDigest: "lapsed-secret",
        at: atUse,
        idleExpiresAt: new Date(atUse.getTime() + 400 * day)
      })
    ).toBeNull();
  });

  it("consumes verification once only after matching the registration credential", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.registerPending(
      registration("verify@example.com", at)
    );
    await repositories.accountMail.issue({
      accountId: account.accountId!,
      purpose: "verify",
      destination: "verify@example.com",
      encryptedMessage: "encrypted",
      tokenDigest: "verify-digest",
      expiresAt: new Date(at.getTime() + 86_400_000),
      at
    });
    expect(
      await repositories.accountTokens.confirmVerification({
        digest: "verify-digest",
        passwordHash: "wrong",
        at
      })
    ).toBe(false);
    expect(
      await repositories.accountTokens.confirmVerification({
        digest: "verify-digest",
        passwordHash: "derived-password-hash",
        at
      })
    ).toBe(true);
    expect(
      await repositories.accountTokens.confirmVerification({
        digest: "verify-digest",
        passwordHash: "derived-password-hash",
        at
      })
    ).toBe(false);
    expect(
      (await repositories.accountTokens.findAccountById(account.accountId!))
        ?.verifiedAt
    ).toEqual(at);
  });

  it("does not verify an account disabled while confirmation waits", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.registerPending(
      registration("disable-race@example.com", at)
    );
    await repositories.accountMail.issue({
      accountId: account.accountId!,
      purpose: "verify",
      destination: "disable-race@example.com",
      encryptedMessage: "encrypted",
      tokenDigest: "disable-race-token",
      expiresAt: new Date(at.getTime() + 86_400_000),
      at
    });
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE accounts SET active = false WHERE id = $1", [
        account.accountId
      ]);
      const confirmation = repositories.accountTokens.confirmVerification({
        digest: "disable-race-token",
        passwordHash: "derived-password-hash",
        at
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await blocker.query("COMMIT");
      expect(await confirmation).toBe(false);
      expect(
        (await repositories.accountTokens.findAccountById(account.accountId!))
          ?.verifiedAt
      ).toBeNull();
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("does not revive a pending account after its seven-day lifetime", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.registerPending(
      registration("stale-pending@example.com", at)
    );
    await repositories.accountMail.issue({
      accountId: account.accountId!,
      purpose: "verify",
      destination: "stale-pending@example.com",
      encryptedMessage: "encrypted",
      tokenDigest: "stale-verify",
      expiresAt: new Date(at.getTime() + 8 * 86_400_000),
      at
    });
    const afterWeek = new Date(at.getTime() + 7 * 86_400_000);
    expect(
      await repositories.accountTokens.confirmVerification({
        digest: "stale-verify",
        passwordHash: "derived-password-hash",
        at: afterWeek
      })
    ).toBe(false);
    expect(
      await repositories.accountTokens.findToken({
        digest: "stale-verify",
        purpose: "verify",
        at: afterWeek
      })
    ).toBeNull();
  });

  it("recovery verifies a pending account, rotates credentials, and revokes sessions", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.registerPending(
      registration("recover@example.com", at)
    );
    await repositories.accountMail.issue({
      accountId: account.accountId!,
      purpose: "reset",
      destination: "recover@example.com",
      expectedCanonicalEmail: "recover@example.com",
      encryptedMessage: "encrypted",
      tokenDigest: "reset-digest",
      expiresAt: new Date(at.getTime() + 1_800_000),
      at
    });
    await pool.query(
      "INSERT INTO account_sessions (id, secret_digest, account_id, credential_version, issued_at, last_used_at, idle_expires_at, absolute_expires_at) VALUES (gen_random_uuid(), 'session-digest', $1, 1, $2, $2, $3, $3)",
      [account.accountId, at, new Date(at.getTime() + 60_000)]
    );
    expect(
      await repositories.accountTokens.completeReset({
        digest: "reset-digest",
        passwordHash: "new-hash",
        passwordSalt: "new-salt",
        scryptVersion: 1,
        scryptCost: 16_384,
        at
      })
    ).toBe(true);
    expect(
      await repositories.accountTokens.completeReset({
        digest: "reset-digest",
        passwordHash: "new-hash",
        passwordSalt: "new-salt",
        scryptVersion: 1,
        scryptCost: 16_384,
        at
      })
    ).toBe(false);
    const row = (
      await pool.query(
        "SELECT verified_at, password_hash, credential_version FROM accounts WHERE id = $1",
        [account.accountId]
      )
    ).rows[0];
    expect(row).toEqual({
      verified_at: at,
      password_hash: "new-hash",
      credential_version: 2
    });
    expect(
      (
        await pool.query(
          "SELECT revoked_at FROM account_sessions WHERE account_id = $1",
          [account.accountId]
        )
      ).rows[0].revoked_at
    ).toEqual(at);
  });

  it("rejects reset at its expiry and consumes every outstanding reset after success", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.registerPending(
      registration("reset-expiry@example.com", at)
    );
    for (const tokenDigest of [
      "expired-reset",
      "fresh-reset",
      "second-reset"
    ]) {
      await repositories.accountMail.issue({
        accountId: account.accountId!,
        purpose: "reset",
        destination: "reset-expiry@example.com",
        expectedCanonicalEmail: "reset-expiry@example.com",
        encryptedMessage: "encrypted",
        tokenDigest,
        expiresAt: new Date(at.getTime() + 1_800_000),
        at
      });
    }
    const reset = (digest: string, time: Date) =>
      repositories.accountTokens.completeReset({
        digest,
        passwordHash: "replacement-hash",
        passwordSalt: "replacement-salt",
        scryptVersion: 1,
        scryptCost: 16_384,
        at: time
      });
    expect(
      await reset("expired-reset", new Date(at.getTime() + 1_800_000))
    ).toBe(false);
    expect(await reset("fresh-reset", at)).toBe(true);
    expect(await reset("second-reset", at)).toBe(false);
  });

  it("throttles verification and reset requests in separate address buckets", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const admit = (purpose: "verify" | "reset") =>
      repositories.accountTokens.admitRequest({
        purpose,
        subjectHash: "same-address-hash",
        limit: 2,
        expiresAt: new Date(at.getTime() + 3_600_000),
        at
      });
    expect(await admit("verify")).toBe(true);
    expect(await admit("verify")).toBe(true);
    expect(await admit("verify")).toBe(false);
    expect(await admit("reset")).toBe(true);
  });

  async function emailChangeRequest(
    owner: string,
    destination: string,
    at: Date
  ) {
    const existing = await repositories.accountTokens.findAccountByEmail(owner);
    const accountId =
      existing?.id ??
      (await repositories.accountAuth.registerPending(registration(owner, at)))
        .accountId!;
    await pool.query("UPDATE accounts SET verified_at = $2 WHERE id = $1", [
      accountId,
      at
    ]);
    const input = {
      accountId,
      destinationSubjectHash: `hashed-${destination}`,
      expectedPasswordHash: "derived-password-hash",
      expectedCurrentCanonicalEmail: owner,
      expectedCredentialVersion: 1,
      canonicalEmail: destination,
      email: destination,
      expiresAt: new Date(at.getTime() + 86_400_000),
      at
    };
    let sequence = 0;
    return () =>
      repositories.accountTokens.issueEmailChange({
        ...input,
        current: {
          digest: `${owner}-${destination}-current-${sequence}`,
          encryptedMessage: "current"
        },
        next: {
          digest: `${owner}-${destination}-next-${sequence++}`,
          encryptedMessage: "next"
        }
      });
  }

  it("bounds repeated email changes by requesting account and destination without issuing rejected mail", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    for (let n = 0; n < 6; n++) {
      const issue = await emailChangeRequest(
        "owner@example.com",
        `next-${n}@example.com`,
        at
      );
      expect(await issue()).toBe(n < 5);
    }
    for (let n = 0; n < 4; n++) {
      const issue = await emailChangeRequest(
        `other-${n}@example.com`,
        "target@example.com",
        at
      );
      expect(await issue()).toBe(n < 3);
    }
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM account_mail_outbox"
        )
      ).rows[0].count
    ).toBe(16);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM account_mail_tokens"
        )
      ).rows[0].count
    ).toBe(16);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM account_mail_tokens WHERE consumed_at IS NULL"
        )
      ).rows[0].count
    ).toBe(8);
  });

  it.each(["account", "destination", "global"] as const)(
    "serializes concurrent email-change requests for the final %s slot",
    async (bucket) => {
      const at = new Date("2026-09-23T12:00:00Z");
      const requests = [];
      for (let n = 0; n < 8; n++)
        requests.push(
          await emailChangeRequest(
            bucket === "account"
              ? "owner@example.com"
              : `owner-${n}@example.com`,
            bucket === "destination"
              ? "target@example.com"
              : `next-${n}@example.com`,
            at
          )
        );
      const owner =
        await repositories.accountTokens.findAccountByEmail(
          "owner@example.com"
        );
      await pool.query(
        `INSERT INTO account_request_attempts (purpose, subject_hash, expires_at)
      SELECT $1, $2, $3 FROM generate_series(1, $4::int)`,
        [
          `email_change_${bucket}`,
          bucket === "account"
            ? owner!.id
            : bucket === "destination"
              ? "hashed-target@example.com"
              : "global",
          new Date(at.getTime() + 3_600_000),
          bucket === "account" ? 4 : bucket === "destination" ? 2 : 99
        ]
      );
      const outcomes = await Promise.all(requests.map((issue) => issue()));
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM account_mail_outbox"
          )
        ).rows[0].count
      ).toBe(2);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM account_mail_tokens"
          )
        ).rows[0].count
      ).toBe(2);
    }
  );

  it("requires both mailbox proofs, in either order, to change an email", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.registerPending(
      registration("old@example.com", at)
    );
    await pool.query("UPDATE accounts SET verified_at = $2 WHERE id = $1", [
      account.accountId,
      at
    ]);
    await pool.query(
      "INSERT INTO account_sessions (id, secret_digest, account_id, credential_version, issued_at, last_used_at, idle_expires_at, absolute_expires_at) VALUES (gen_random_uuid(), 'email-session', $1, 1, $2, $2, $3, $3)",
      [account.accountId, at, new Date(at.getTime() + 60_000)]
    );
    const issue = (suffix: string) =>
      repositories.accountTokens.issueEmailChange({
        accountId: account.accountId!,
        destinationSubjectHash: "email-change-subject",
        expectedPasswordHash: "derived-password-hash",
        expectedCurrentCanonicalEmail:
          suffix === "first" ? "old@example.com" : "first@example.com",
        expectedCredentialVersion: suffix === "first" ? 1 : 2,
        canonicalEmail: `${suffix}@example.com`,
        email: `${suffix}@example.com`,
        current: {
          digest: `current-${suffix}`,
          encryptedMessage: "encrypted-current"
        },
        next: { digest: `new-${suffix}`, encryptedMessage: "encrypted-new" },
        expiresAt: new Date(at.getTime() + 86_400_000),
        at
      });
    expect(await issue("first")).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM account_mail_outbox WHERE encrypted_message <> ''"
        )
      ).rows[0].count
    ).toBe(2);
    expect(
      await repositories.accountTokens.confirmEmailChange({
        digest: "new-first",
        purpose: "email_change_new",
        at
      })
    ).toBe("pending");
    expect(
      (await repositories.accountTokens.findAccountById(account.accountId!))
        ?.canonicalEmail
    ).toBe("old@example.com");
    expect(
      await repositories.accountTokens.confirmEmailChange({
        digest: "current-first",
        purpose: "email_change_current",
        at
      })
    ).toBe("changed");
    expect(
      await repositories.accountTokens.confirmEmailChange({
        digest: "current-first",
        purpose: "email_change_current",
        at
      })
    ).toBe("invalid");
    expect(
      (await repositories.accountTokens.findAccountById(account.accountId!))
        ?.canonicalEmail
    ).toBe("first@example.com");
    expect(
      (
        await pool.query(
          "SELECT revoked_at FROM account_sessions WHERE account_id = $1",
          [account.accountId]
        )
      ).rows[0].revoked_at
    ).toEqual(at);
    expect(await issue("second")).toBe(true);
    expect(
      await repositories.accountTokens.confirmEmailChange({
        digest: "current-second",
        purpose: "email_change_current",
        at
      })
    ).toBe("pending");
    expect(
      await repositories.accountTokens.confirmEmailChange({
        digest: "new-second",
        purpose: "email_change_new",
        at
      })
    ).toBe("changed");
    expect(
      (await repositories.accountTokens.findAccountById(account.accountId!))
        ?.canonicalEmail
    ).toBe("second@example.com");
  });

  it("does not issue approvals to a former current address after an email change", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.registerPending(
      registration("former@example.com", at)
    );
    await pool.query(
      "UPDATE accounts SET verified_at = $2, canonical_email = 'current@example.com', email = 'current@example.com', credential_version = credential_version + 1 WHERE id = $1",
      [account.accountId, at]
    );
    expect(
      await repositories.accountTokens.issueEmailChange({
        accountId: account.accountId!,
        destinationSubjectHash: "email-change-subject",
        expectedPasswordHash: "derived-password-hash",
        expectedCurrentCanonicalEmail: "former@example.com",
        expectedCredentialVersion: 1,
        canonicalEmail: "destination@example.com",
        email: "destination@example.com",
        current: {
          digest: "former-current",
          encryptedMessage: "mail-to-former"
        },
        next: {
          digest: "former-next",
          encryptedMessage: "mail-to-destination"
        },
        expiresAt: new Date(at.getTime() + 86_400_000),
        at
      })
    ).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM account_mail_outbox"
        )
      ).rows[0].count
    ).toBe(0);
  });

  it("invalidates old reset links when the login address changes", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.registerPending(
      registration("reset-old@example.com", at)
    );
    await pool.query("UPDATE accounts SET verified_at = $2 WHERE id = $1", [
      account.accountId,
      at
    ]);
    await repositories.accountMail.issue({
      accountId: account.accountId!,
      purpose: "reset",
      expectedCanonicalEmail: "reset-old@example.com",
      destination: "reset-old@example.com",
      encryptedMessage: "reset-to-old",
      tokenDigest: "reset-before-email",
      expiresAt: new Date(at.getTime() + 1_800_000),
      at
    });
    await repositories.accountTokens.issueEmailChange({
      accountId: account.accountId!,
      destinationSubjectHash: "email-change-subject",
      expectedPasswordHash: "derived-password-hash",
      expectedCurrentCanonicalEmail: "reset-old@example.com",
      expectedCredentialVersion: 1,
      canonicalEmail: "reset-new@example.com",
      email: "reset-new@example.com",
      current: {
        digest: "change-reset-current",
        encryptedMessage: "old-proof"
      },
      next: { digest: "change-reset-next", encryptedMessage: "new-proof" },
      expiresAt: new Date(at.getTime() + 86_400_000),
      at
    });
    expect(
      await repositories.accountTokens.confirmEmailChange({
        digest: "change-reset-current",
        purpose: "email_change_current",
        at
      })
    ).toBe("pending");
    expect(
      await repositories.accountTokens.confirmEmailChange({
        digest: "change-reset-next",
        purpose: "email_change_new",
        at
      })
    ).toBe("changed");
    expect(
      await repositories.accountTokens.completeReset({
        digest: "reset-before-email",
        passwordHash: "attacker-hash",
        passwordSalt: "attacker-salt",
        scryptVersion: 1,
        scryptCost: 16_384,
        at
      })
    ).toBe(false);
  });

  it("does not persist a reset link based on an address changed during issuance", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.registerPending(
      registration("race-old@example.com", at)
    );
    await pool.query("UPDATE accounts SET verified_at = $2 WHERE id = $1", [
      account.accountId,
      at
    ]);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "UPDATE accounts SET canonical_email = 'race-new@example.com', email = 'race-new@example.com' WHERE id = $1",
        [account.accountId]
      );
      const issuing = repositories.accountMail.issue({
        accountId: account.accountId!,
        purpose: "reset",
        expectedCanonicalEmail: "race-old@example.com",
        destination: "race-old@example.com",
        encryptedMessage: "mail-to-old",
        tokenDigest: "racing-reset",
        expiresAt: new Date(at.getTime() + 1_800_000),
        at
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await blocker.query("COMMIT");
      await issuing;
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM account_mail_tokens WHERE token_digest = 'racing-reset'"
          )
        ).rows[0].count
      ).toBe(0);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("returns invalid to the loser when two accounts claim one email concurrently", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const accounts = await Promise.all(
      ["collision-a@example.com", "collision-b@example.com"].map((email) =>
        repositories.accountAuth.registerPending(registration(email, at))
      )
    );
    await pool.query(
      "UPDATE accounts SET verified_at = $2 WHERE id = ANY($1::uuid[])",
      [accounts.map((account) => account.accountId), at]
    );
    await pool.query(
      `CREATE FUNCTION test_delay_email_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.canonical_email = 'collision@example.com' THEN PERFORM pg_sleep(0.2); END IF; RETURN NEW; END $$`
    );
    await pool.query(
      "CREATE TRIGGER test_delay_email_claim_trigger BEFORE UPDATE OF canonical_email ON accounts FOR EACH ROW EXECUTE FUNCTION test_delay_email_claim()"
    );
    try {
      for (const [index, account] of accounts.entries()) {
        const suffix = index.toString();
        await repositories.accountTokens.issueEmailChange({
          accountId: account.accountId!,
          destinationSubjectHash: "email-change-subject",
          expectedPasswordHash: "derived-password-hash",
          expectedCurrentCanonicalEmail: `collision-${index === 0 ? "a" : "b"}@example.com`,
          expectedCredentialVersion: 1,
          canonicalEmail: "collision@example.com",
          email: "collision@example.com",
          current: {
            digest: `collision-current-${suffix}`,
            encryptedMessage: "current-proof"
          },
          next: {
            digest: `collision-new-${suffix}`,
            encryptedMessage: "new-proof"
          },
          expiresAt: new Date(at.getTime() + 86_400_000),
          at
        });
        expect(
          await repositories.accountTokens.confirmEmailChange({
            digest: `collision-current-${suffix}`,
            purpose: "email_change_current",
            at
          })
        ).toBe("pending");
      }
      const results = await Promise.allSettled(
        accounts.map((_account, index) =>
          repositories.accountTokens.confirmEmailChange({
            digest: `collision-new-${index}`,
            purpose: "email_change_new",
            at
          })
        )
      );
      expect(results).toEqual(
        expect.arrayContaining([
          { status: "fulfilled", value: "changed" },
          { status: "fulfilled", value: "invalid" }
        ])
      );
    } finally {
      await pool.query(
        "DROP TRIGGER test_delay_email_claim_trigger ON accounts"
      );
      await pool.query("DROP FUNCTION test_delay_email_claim()");
    }
  });

  it("rolls back both email-change tokens and mail rows when either message fails", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.registerPending(
      registration("original@example.com", at)
    );
    await pool.query("UPDATE accounts SET verified_at = $2 WHERE id = $1", [
      account.accountId,
      at
    ]);
    await expect(
      repositories.accountTokens.issueEmailChange({
        accountId: account.accountId!,
        destinationSubjectHash: "email-change-subject",
        expectedPasswordHash: "derived-password-hash",
        expectedCurrentCanonicalEmail: "original@example.com",
        expectedCredentialVersion: 1,
        canonicalEmail: "replacement@example.com",
        email: "replacement@example.com",
        current: { digest: "current-rollback", encryptedMessage: "encrypted" },
        next: {
          digest: "next-rollback",
          encryptedMessage: null as unknown as string
        },
        expiresAt: new Date(at.getTime() + 86_400_000),
        at
      })
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM account_mail_tokens WHERE account_id = $1",
          [account.accountId]
        )
      ).rows[0].count
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM account_mail_outbox"
        )
      ).rows[0].count
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM account_request_attempts WHERE purpose LIKE 'email_change_%'"
        )
      ).rows[0].count
    ).toBe(0);
  });

  it("bootstraps a verified admin that must replace the temporary password", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const admin = await repositories.accountAuth.provisionAdmin(
      registration("owner@example.com", at)
    );
    expect(admin).toMatchObject({
      canonicalEmail: "owner@example.com",
      role: "admin",
      active: true,
      verifiedAt: at,
      passwordChangeRequired: true
    });
    const row = await pool.query(
      "SELECT password_hash FROM accounts WHERE id = $1",
      [admin.id]
    );
    expect(row.rows[0].password_hash).toBe("derived-password-hash");
    expect(
      (await pool.query("SELECT action, outcome FROM account_auth_events")).rows
    ).toEqual([{ action: "provision_admin", outcome: "success" }]);
  });

  it("keeps one active admin when two admins demote concurrently", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const a = await repositories.accountAuth.provisionAdmin(
      registration("a@example.com", at)
    );
    const b = await repositories.accountAuth.provisionAdmin(
      registration("b@example.com", at)
    );
    await pool.query(
      "UPDATE accounts SET password_change_required = false WHERE id = ANY($1::uuid[])",
      [[a.id, b.id]]
    );
    const outcomes = await Promise.all([
      repositories.accountAuth.setRole({
        actorId: a.id,
        targetId: a.id,
        role: "user",
        at
      }),
      repositories.accountAuth.setRole({
        actorId: b.id,
        targetId: b.id,
        role: "user",
        at
      })
    ]);
    expect(outcomes.sort()).toEqual(["last_admin", "updated"]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM accounts WHERE role = 'admin' AND active"
        )
      ).rows[0].count
    ).toBe(1);
  });

  it("keeps one active admin when two admins disable concurrently", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const a = await repositories.accountAuth.provisionAdmin(
      registration("a@example.com", at)
    );
    const b = await repositories.accountAuth.provisionAdmin(
      registration("b@example.com", at)
    );
    await pool.query(
      "UPDATE accounts SET password_change_required = false WHERE id = ANY($1::uuid[])",
      [[a.id, b.id]]
    );
    const outcomes = await Promise.all([
      repositories.accountAuth.setActive({
        actorId: a.id,
        targetId: a.id,
        active: false,
        at
      }),
      repositories.accountAuth.setActive({
        actorId: b.id,
        targetId: b.id,
        active: false,
        at
      })
    ]);
    expect(outcomes.sort()).toEqual(["last_admin", "updated"]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM accounts WHERE role = 'admin' AND active"
        )
      ).rows[0].count
    ).toBe(1);
  });

  it("cannot count a pending expiring account as a replacement admin", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const admin = await repositories.accountAuth.provisionAdmin(
      registration("owner@example.com", at)
    );
    await pool.query(
      "UPDATE accounts SET password_change_required = false WHERE id = $1",
      [admin.id]
    );
    const pending = await repositories.accountAuth.registerPending(
      registration(
        "pending@example.com",
        new Date(at.getTime() - 8 * 86_400_000)
      )
    );
    expect(
      await repositories.accountAuth.setRole({
        actorId: admin.id,
        targetId: pending.accountId!,
        role: "admin",
        at
      })
    ).toBe("forbidden");
    expect(
      await repositories.accountAuth.setRole({
        actorId: admin.id,
        targetId: admin.id,
        role: "user",
        at
      })
    ).toBe("last_admin");
    await repositories.accountAuth.registerPending(
      registration("fresh@example.com", at)
    );
    expect(
      (
        await pool.query("SELECT id FROM accounts WHERE id = $1", [
          pending.accountId
        ])
      ).rowCount
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM accounts WHERE role = 'admin' AND active AND verified_at IS NOT NULL"
        )
      ).rows[0].count
    ).toBe(1);
  });

  it("does not treat a legacy unverified admin row as last-admin coverage during cleanup", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const admin = await repositories.accountAuth.provisionAdmin(
      registration("owner@example.com", at)
    );
    await pool.query(
      "UPDATE accounts SET password_change_required = false WHERE id = $1",
      [admin.id]
    );
    const pending = await repositories.accountAuth.registerPending(
      registration(
        "pending@example.com",
        new Date(at.getTime() - 8 * 86_400_000)
      )
    );
    await pool.query("UPDATE accounts SET role = 'admin' WHERE id = $1", [
      pending.accountId
    ]);
    expect(
      await repositories.accountAuth.setActive({
        actorId: admin.id,
        targetId: pending.accountId!,
        active: true,
        at
      })
    ).toBe("forbidden");
    const [demotion, cleanup] = await Promise.all([
      repositories.accountAuth.setRole({
        actorId: admin.id,
        targetId: admin.id,
        role: "user",
        at
      }),
      repositories.accountAuth.registerPending(
        registration("fresh@example.com", at)
      )
    ]);
    expect(demotion).toBe("last_admin");
    expect(cleanup.kind).toBe("created");
    expect(
      (
        await pool.query("SELECT id FROM accounts WHERE id = $1", [
          pending.accountId
        ])
      ).rowCount
    ).toBe(0);
  });

  it("requires a live admin actor and revokes target sessions on role, status, and password flags", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const admin = await repositories.accountAuth.provisionAdmin(
      registration("owner@example.com", at)
    );
    const peer = await repositories.accountAuth.provisionAdmin(
      registration("peer@example.com", at)
    );
    await pool.query(
      "UPDATE accounts SET password_change_required = false WHERE id = ANY($1::uuid[])",
      [[admin.id, peer.id]]
    );
    const created = await repositories.accountAuth.registerPending(
      registration("user@example.com", at)
    );
    const userId = created.accountId!;
    const issueSession = async (accountId: string) => {
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO account_sessions
        (id, secret_digest, account_id, credential_version, issued_at,
         last_used_at, idle_expires_at, absolute_expires_at)
        VALUES ($1, 'digest', $2, 1, $3, $3, $4, $4)`,
        [id, accountId, at, new Date(at.getTime() + 3600000)]
      );
      return id;
    };
    const userSession = await issueSession(userId);
    expect(
      await repositories.accountAuth.requirePasswordChange({
        actorId: admin.id,
        targetId: userId,
        at
      })
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT revoked_at FROM account_sessions WHERE id = $1",
          [userSession]
        )
      ).rows[0].revoked_at
    ).toEqual(at);
    expect(
      (
        await pool.query(
          "SELECT password_change_required FROM accounts WHERE id = $1",
          [userId]
        )
      ).rows[0].password_change_required
    ).toBe(true);
    expect(
      await repositories.accountAuth.setRole({
        actorId: userId,
        targetId: peer.id,
        role: "user",
        at
      })
    ).toBe("forbidden");
    const peerSession = await issueSession(peer.id);
    expect(
      await repositories.accountAuth.setRole({
        actorId: admin.id,
        targetId: peer.id,
        role: "user",
        at
      })
    ).toBe("updated");
    expect(
      (
        await pool.query(
          "SELECT revoked_at FROM account_sessions WHERE id = $1",
          [peerSession]
        )
      ).rows[0].revoked_at
    ).toEqual(at);
    expect(
      await repositories.accountAuth.setRole({
        actorId: peer.id,
        targetId: admin.id,
        role: "user",
        at
      })
    ).toBe("forbidden");
    expect(
      await repositories.accountAuth.setRole({
        actorId: userId,
        targetId: userId,
        role: "admin",
        at
      })
    ).toBe("forbidden");
    const adminSession = await issueSession(admin.id);
    const secondUserSession = await issueSession(userId);
    expect(
      await repositories.accountAuth.setActive({
        actorId: admin.id,
        targetId: admin.id,
        active: false,
        at
      })
    ).toBe("last_admin");
    expect(
      await repositories.accountAuth.setActive({
        actorId: admin.id,
        targetId: userId,
        active: false,
        at
      })
    ).toBe("updated");
    expect(
      (
        await pool.query(
          "SELECT revoked_at FROM account_sessions WHERE id = $1",
          [secondUserSession]
        )
      ).rows[0].revoked_at
    ).toEqual(at);
    expect(
      (
        await pool.query(
          "SELECT revoked_at FROM account_sessions WHERE id = $1",
          [adminSession]
        )
      ).rows[0].revoked_at
    ).toBeNull();
    expect(
      await repositories.accountAuth.setActive({
        actorId: admin.id,
        targetId: "00000000-0000-0000-0000-000000000000",
        active: false,
        at
      })
    ).toBe("missing");
    expect(await repositories.accountAuth.listAccounts(userId)).toEqual([]);
    expect(await repositories.accountAuth.listAccounts(admin.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: userId, role: "user", active: false })
      ])
    );
    expect(
      JSON.stringify(await repositories.accountAuth.listAccounts(admin.id))
    ).not.toContain("derived-password-hash");
    await pool.query("UPDATE accounts SET active = false WHERE id = $1", [
      admin.id
    ]);
    expect(
      await repositories.accountAuth.setActive({
        actorId: admin.id,
        targetId: userId,
        active: true,
        at
      })
    ).toBe("forbidden");
    expect(await repositories.accountAuth.listAccounts(admin.id)).toEqual([]);
  });

  it("atomically issues mail, leases retries, and removes delivered and expired ciphertext", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.registerPending(
      registration("mail@example.com", at)
    );
    const input = {
      accountId: account.accountId!,
      purpose: "verify" as const,
      destination: "mail@example.com",
      encryptedMessage: "encrypted-payload",
      tokenDigest: "token-digest",
      expiresAt: new Date(at.getTime() + 3600000),
      at
    };
    await repositories.accountMail.issue(input);
    expect(
      (await pool.query("SELECT token_digest FROM account_mail_tokens")).rows
    ).toEqual([{ token_digest: "token-digest" }]);
    // A failure inserting the payload must roll back the token too.
    await expect(
      repositories.accountMail.issue({
        ...input,
        tokenDigest: "rollback-digest",
        encryptedMessage: null as unknown as string
      })
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM account_mail_tokens"
        )
      ).rows[0].count
    ).toBe(1);
    const claims = await Promise.all([
      repositories.accountMail.claimDue(at),
      repositories.accountMail.claimDue(at)
    ]);
    const claimed = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await repositories.accountMail.claimDue(new Date(at.getTime() + 59000))
    ).toBeNull();
    const retried = await repositories.accountMail.claimDue(
      new Date(at.getTime() + 60000)
    );
    expect(retried).toMatchObject({
      id: claimed.id,
      idempotencyKey: claimed.idempotencyKey,
      encryptedMessage: "encrypted-payload",
      attempt: 2
    });
    // The second lease/backoff is longer than the first.
    expect(
      await repositories.accountMail.claimDue(new Date(at.getTime() + 120000))
    ).toBeNull();
    await repositories.accountMail.markSent(claimed.id, at);
    expect(
      (
        await pool.query(
          "SELECT encrypted_message, sent_at FROM account_mail_outbox"
        )
      ).rows
    ).toEqual([{ encrypted_message: "", sent_at: at }]);
    await repositories.accountMail.issue({ ...input, tokenDigest: "expires" });
    expect(await repositories.accountMail.claimDue(input.expiresAt)).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM account_mail_outbox WHERE encrypted_message <> ''"
        )
      ).rows[0].count
    ).toBe(0);
  });
  it("cancels blocked outbox SQL without consuming its retry lease", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const account = await repositories.accountAuth.registerPending(
      registration("cancel@example.com", at)
    );
    await repositories.accountMail.issue({
      accountId: account.accountId!,
      purpose: "verify",
      destination: "cancel@example.com",
      encryptedMessage: "encrypted",
      tokenDigest: "cancel-digest",
      expiresAt: new Date(at.getTime() + 3600000),
      at
    });
    const blocker = await pool.connect();
    const controller = new AbortController();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK account_mail_outbox IN ACCESS EXCLUSIVE MODE");
      const pending = repositories.accountMail.claimDue(at, controller.signal);
      const assertion = expect(pending).rejects.toThrow(
        "account_mail_database_cancelled"
      );
      await eventually(
        async () =>
          (
            await pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%DELETE FROM account_mail_outbox%'"
            )
          ).rowCount! > 0
      );
      controller.abort();
      await assertion;
      await blocker.query("ROLLBACK");
      const row = await repositories.accountMail.claimDue(at);
      expect(row).toMatchObject({ encryptedMessage: "encrypted", attempt: 1 });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
  it("rejects empty local-part dot segments at the database boundary", async () => {
    for (const canonicalEmail of [
      "a..b@example.com",
      ".alice@example.com",
      "alice.@example.com"
    ]) {
      await expect(
        pool.query(
          `INSERT INTO accounts
             (canonical_email, email, password_hash, password_salt,
              scrypt_version, scrypt_cost)
           VALUES ($1, $1, 'hash', 'salt', 1, 16384)`,
          [canonicalEmail]
        )
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("atomically keeps one account for concurrent duplicate registrations", async () => {
    const at = new Date("2026-09-23T12:00:00.000Z");
    const outcomes = await Promise.all([
      repositories.accountAuth.registerPending(
        registration("person@example.com", at)
      ),
      repositories.accountAuth.registerPending(
        registration("person@example.com", at)
      )
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
      "created",
      "existing"
    ]);
    const rows = await pool.query(
      `SELECT id, role, verified_at FROM accounts WHERE canonical_email = 'person@example.com'`
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({ role: "user", verified_at: null });
  });

  it("stores encrypted account keys with owner isolation and compare-and-set versions", async () => {
    const accountRows = await pool.query<{ id: string }>(
      `INSERT INTO accounts (canonical_email, email, password_hash, password_salt, scrypt_version, scrypt_cost, verified_at)
       VALUES ('alice@example.com', 'alice@example.com', 'hash', 'salt', 1, 16384, now()),
              ('bob@example.com', 'bob@example.com', 'hash', 'salt', 1, 16384, now())
       RETURNING id`
    );
    const [alice, bob] = accountRows.rows.map((row) => row.id);
    const credentials = createAccountCredentials(
      repositories.accountCredentials!,
      Buffer.alloc(32, 44)
    );
    expect(
      await credentials.replace(alice!, "warcraftlogs", {
        clientId: "id-a",
        clientSecret: "secret-a"
      })
    ).toBe("saved");
    const stored = await pool.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM account_api_credentials WHERE account_id = $1 AND provider = 'warcraftlogs'",
      [alice]
    );
    expect(stored.rows[0]!.encrypted_payload).not.toContain("secret-a");
    expect(await credentials.resolve(bob!, "warcraftlogs")).toBeNull();
    expect(
      await credentials.replace(
        alice!,
        "warcraftlogs",
        { clientId: "id-b", clientSecret: "secret-b" },
        0
      )
    ).toBe("conflict");
    expect(
      await credentials.replace(
        alice!,
        "warcraftlogs",
        { clientId: "id-b", clientSecret: "secret-b" },
        1
      )
    ).toBe("saved");
    await credentials.remove(alice!, "warcraftlogs");
    expect(await credentials.resolve(alice!, "warcraftlogs")).toBeNull();
    expect(
      await credentials.replace(
        alice!,
        "warcraftlogs",
        { clientId: "id-c", clientSecret: "secret-c" },
        3
      )
    ).toBe("saved");
    expect(await credentials.resolve(alice!, "warcraftlogs")).toMatchObject({
      version: 4
    });
  });

  it("expires stale unverified registrations while retaining verified accounts", async () => {
    const at = new Date("2026-09-23T12:00:00.000Z");
    await repositories.accountAuth.registerPending(
      registration("old@example.com", new Date(at.getTime() - 8 * 86_400_000))
    );
    await repositories.accountAuth.registerPending(
      registration(
        "current@example.com",
        new Date(at.getTime() - 6 * 86_400_000)
      )
    );
    await pool.query(
      `UPDATE accounts SET verified_at = $1, created_at = $1::timestamptz - interval '8 days' WHERE canonical_email = 'current@example.com'`,
      [at]
    );
    await repositories.accountAuth.registerPending(
      registration("new@example.com", at)
    );
    const rows = await pool.query<{ canonical_email: string }>(
      `SELECT canonical_email FROM accounts ORDER BY canonical_email`
    );
    expect(rows.rows.map((row) => row.canonical_email)).toEqual([
      "current@example.com",
      "new@example.com"
    ]);
  });

  it("deletes at most 100 stale pending accounts during opportunistic cleanup", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    await pool.query(
      `INSERT INTO accounts
      (canonical_email, email, password_hash, password_salt, scrypt_version, scrypt_cost, created_at, updated_at)
      SELECT 'stale-' || n || '@example.com', 'stale-' || n || '@example.com',
        'hash', 'salt', 1, 16384, $1::timestamptz - interval '8 days', $1
      FROM generate_series(1, 105) n`,
      [at]
    );
    await repositories.accountAuth.registerPending(
      registration("fresh@example.com", at)
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM accounts WHERE canonical_email LIKE 'stale-%'"
        )
      ).rows[0].count
    ).toBe(5);
  });

  it("re-registers an expired address even when older cleanup exceeds one batch", async () => {
    const at = new Date("2026-09-23T12:00:00.000Z");
    await pool.query(
      `INSERT INTO accounts
         (canonical_email, email, password_hash, password_salt,
          scrypt_version, scrypt_cost, created_at, updated_at)
       SELECT 'stale-' || n || '@example.com', 'stale-' || n || '@example.com',
              'hash', 'salt', 1, 16384, $1::timestamptz - interval '9 days',
              $1::timestamptz - interval '9 days'
       FROM generate_series(1, 100) n`,
      [at]
    );
    await pool.query(
      `INSERT INTO accounts
         (canonical_email, email, password_hash, password_salt,
          scrypt_version, scrypt_cost, created_at, updated_at)
       VALUES ('target@example.com', 'target@example.com', 'hash', 'salt', 1,
               16384, $1::timestamptz - interval '8 days',
               $1::timestamptz - interval '8 days')`,
      [at]
    );
    const result = await repositories.accountAuth.registerPending(
      registration("target@example.com", at)
    );
    expect(result.kind).toBe("created");
    const row = await pool.query<{ created_at: Date }>(
      `SELECT created_at FROM accounts WHERE canonical_email = 'target@example.com'`
    );
    expect(row.rows[0]?.created_at).toEqual(at);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM accounts WHERE canonical_email LIKE 'stale-%'"
        )
      ).rows[0].count
    ).toBe(1);
  });

  it("enforces per IP, global, missing IP, and address admission limits", async () => {
    const at = new Date("2026-09-23T12:00:00.000Z");
    const admit = (
      ipSubjectHash: string | null,
      emailSubjectHash: string,
      date = at
    ) =>
      repositories.accountAuth.admitRegistration({
        ipSubjectHash,
        emailSubjectHash,
        at: date
      });
    for (let i = 0; i < 5; i++)
      expect(await admit("ip-a", `mail-${i}`)).toBe("admitted");
    expect(await admit("ip-a", "mail-5")).toBe("throttled");
    expect(await admit("ip-b", "mail-0")).toBe("admitted");
    expect(await admit("ip-b", "mail-0")).toBe("admitted");
    expect(await admit("ip-b", "mail-0")).toBe("throttled");
    for (let i = 0; i < 10; i++)
      expect(await admit(null, `fallback-${i}`)).toBe("admitted");
    expect(await admit(null, "fallback-10")).toBe("throttled");
    for (let i = 0; i < 83; i++)
      expect(await admit(`ip-${i}`, `global-${i}`)).toBe("admitted");
    expect(await admit("ip-last", "global-last")).toBe("throttled");
    expect(
      await admit("ip-a", "mail-0", new Date(at.getTime() + 86_400_001))
    ).toBe("admitted");
  });

  it.each(["ip", "email", "global", "missing_ip"] as const)(
    "admits only one concurrent registration into the final %s slot",
    async (bucket) => {
      const at = new Date("2026-09-23T12:00:00Z");
      await pool.query(
        `INSERT INTO account_request_attempts (purpose, subject_hash, expires_at)
      SELECT $1, $2, $3 FROM generate_series(1, $4::int)`,
        [
          `registration_${bucket}`,
          bucket === "global"
            ? "global"
            : bucket === "missing_ip"
              ? "fallback"
              : "shared",
          new Date(at.getTime() + 3_600_000),
          { ip: 4, email: 2, global: 99, missing_ip: 9 }[bucket]
        ]
      );
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, n) =>
          repositories.accountAuth.admitRegistration({
            ipSubjectHash:
              bucket === "missing_ip"
                ? null
                : bucket === "ip"
                  ? "shared"
                  : `ip-${n}`,
            emailSubjectHash: bucket === "email" ? "shared" : `mail-${n}`,
            at
          })
        )
      );
      expect(results.filter((result) => result === "admitted")).toHaveLength(1);
    }
  );

  it.each(["ip", "email", "global", "missing_ip"] as const)(
    "expires registration %s admission exactly at its hour/day boundary",
    async (bucket) => {
      const at = new Date("2026-09-23T12:00:00Z");
      const duration = bucket === "email" ? 86_400_000 : 3_600_000;
      const boundary = new Date(at.getTime() + duration);
      await pool.query(
        `INSERT INTO account_request_attempts (purpose, subject_hash, expires_at)
      SELECT $1, $2, $3 FROM generate_series(1, $4::int)`,
        [
          `registration_${bucket}`,
          bucket === "global"
            ? "global"
            : bucket === "missing_ip"
              ? "fallback"
              : "shared",
          boundary,
          { ip: 5, email: 3, global: 100, missing_ip: 10 }[bucket]
        ]
      );
      const admit = (date: Date) =>
        repositories.accountAuth.admitRegistration({
          ipSubjectHash: bucket === "missing_ip" ? null : "shared",
          emailSubjectHash: "shared",
          at: date
        });
      expect(await admit(new Date(boundary.getTime() - 1))).toBe("throttled");
      expect(await admit(boundary)).toBe("admitted");
    }
  );

  it("shares the daily address cap between resend and registration", async () => {
    const at = new Date("2026-09-23T12:00:00.000Z");
    for (const state of ["unknown", "verified", "pending"]) {
      const subjectHash = `resend-before-registration-${state}`;
      for (let count = 0; count < 3; count++)
        expect(
          await repositories.accountTokens.admitRequest({
            purpose: "verify",
            subjectHash,
            limit: 3,
            expiresAt: new Date(at.getTime() + 86_400_000),
            at
          })
        ).toBe(true);
      expect(
        await repositories.accountAuth.admitRegistration({
          ipSubjectHash: `fresh-ip-${state}`,
          emailSubjectHash: subjectHash,
          at
        })
      ).toBe("throttled");
    }
  });

  async function provisionOperator() {
    return repositories.operatorAuth.provision({
      canonicalLogin: "operator_one",
      displayLogin: "Operator One",
      passwordHash: "derived-password-hash",
      passwordSalt: "derived-password-salt",
      scryptVersion: 1,
      scryptCost: 16_384,
      at: new Date("2026-09-21T12:00:00.000Z")
    });
  }

  it("renews only a valid operator session without extending its absolute expiry", async () => {
    // Break caught: a session lookup that verifies only the id could accept a
    // forged secret, expired session, disabled operator, or stale credential.
    const auth = repositories.operatorAuth;
    const operator = await provisionOperator();
    const sessionId = "10000000-0000-0000-0000-000000000001";
    const issuedAt = new Date("2026-09-21T12:00:00.000Z");
    const absoluteExpiresAt = new Date("2026-09-21T20:00:00.000Z");

    await auth.issueSession({
      sessionId,
      secretDigest: "hmac:valid-secret",
      operatorId: operator.id,
      credentialVersion: operator.credentialVersion,
      issuedAt,
      lastUsedAt: issuedAt,
      idleExpiresAt: new Date("2026-09-21T12:30:00.000Z"),
      absoluteExpiresAt
    });

    await expect(
      auth.useSession({
        sessionId,
        secretDigest: "hmac:valid-secret",
        at: new Date("2026-09-21T12:10:00.000Z"),
        idleExpiresAt: new Date("2026-09-21T20:30:00.000Z")
      })
    ).resolves.toMatchObject({
      operator: { id: operator.id, active: true },
      session: {
        id: sessionId,
        lastUsedAt: new Date("2026-09-21T12:10:00.000Z"),
        idleExpiresAt: absoluteExpiresAt,
        absoluteExpiresAt
      }
    });
    await expect(
      auth.useSession({
        sessionId,
        secretDigest: "hmac:wrong-secret",
        at: new Date("2026-09-21T12:11:00.000Z"),
        idleExpiresAt: new Date("2026-09-21T12:41:00.000Z")
      })
    ).resolves.toBeNull();
    await expect(
      auth.useSession({
        sessionId,
        secretDigest: "hmac:valid-secret",
        at: absoluteExpiresAt,
        idleExpiresAt: new Date("2026-09-21T20:30:00.000Z")
      })
    ).resolves.toBeNull();
  });

  it("denies revoked, idle-expired, stale-version, and disabled operator sessions", async () => {
    // Break caught: missing any use-session predicate revives a session that
    // was explicitly revoked, superseded, expired, or belongs to a disabled operator.
    const auth = repositories.operatorAuth;
    const operator = await provisionOperator();
    const at = new Date("2026-09-21T12:00:00.000Z");
    const absoluteExpiresAt = new Date("2026-09-21T20:00:00.000Z");
    const cases = [
      {
        id: "10000000-0000-0000-0000-000000000002",
        digest: "hmac:revoked",
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z")
      },
      {
        id: "10000000-0000-0000-0000-000000000003",
        digest: "hmac:idle-expired",
        idleExpiresAt: at
      },
      {
        id: "10000000-0000-0000-0000-000000000004",
        digest: "hmac:stale-version",
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z"),
        credentialVersion: 0
      },
      {
        id: "10000000-0000-0000-0000-000000000005",
        digest: "hmac:disabled",
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z")
      }
    ];
    for (const session of cases) {
      await auth.issueSession({
        sessionId: session.id,
        secretDigest: session.digest,
        operatorId: operator.id,
        credentialVersion:
          session.credentialVersion ?? operator.credentialVersion,
        issuedAt: at,
        lastUsedAt: at,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt
      });
    }
    await auth.revokeSession(cases[0]!.id, at);
    for (const session of cases.slice(0, 3)) {
      await expect(
        auth.useSession({
          sessionId: session.id,
          secretDigest: session.digest,
          at,
          idleExpiresAt: new Date("2026-09-21T12:30:00.000Z")
        })
      ).resolves.toBeNull();
    }
    await pool.query("UPDATE operators SET active = false WHERE id = $1", [
      operator.id
    ]);
    await expect(
      auth.useSession({
        sessionId: cases[3]!.id,
        secretDigest: cases[3]!.digest,
        at,
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z")
      })
    ).resolves.toBeNull();
  });

  it("rotates and disables credentials with session revocation and safe audit evidence", async () => {
    // Break caught: credential lifecycle changes that leave old sessions alive
    // or make lifecycle evidence disappear from the same durable operation.
    const auth = repositories.operatorAuth;
    const operator = await provisionOperator();
    const at = new Date("2026-09-21T12:00:00.000Z");
    const firstSession = "10000000-0000-0000-0000-000000000006";
    const secondSession = "10000000-0000-0000-0000-000000000007";
    const issue = async (sessionId: string, credentialVersion: number) =>
      auth.issueSession({
        sessionId,
        secretDigest: `hmac:${sessionId}`,
        operatorId: operator.id,
        credentialVersion,
        issuedAt: at,
        lastUsedAt: at,
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z"),
        absoluteExpiresAt: new Date("2026-09-21T20:00:00.000Z")
      });

    await issue(firstSession, operator.credentialVersion);
    await expect(
      auth.rotateCredential({
        operatorId: operator.id,
        passwordHash: "rotated-password-hash",
        passwordSalt: "rotated-password-salt",
        scryptVersion: 2,
        scryptCost: 32_768,
        at
      })
    ).resolves.toMatchObject({
      id: operator.id,
      credentialVersion: 2,
      active: true
    });
    await expect(
      auth.useSession({
        sessionId: firstSession,
        secretDigest: `hmac:${firstSession}`,
        at,
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z")
      })
    ).resolves.toBeNull();

    await issue(secondSession, 2);
    await expect(auth.disable(operator.id, at)).resolves.toMatchObject({
      id: operator.id,
      active: false,
      credentialVersion: 2
    });
    await expect(
      auth.useSession({
        sessionId: secondSession,
        secretDigest: `hmac:${secondSession}`,
        at,
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z")
      })
    ).resolves.toBeNull();

    const events = await pool.query<{
      operator_id: string;
      action: string;
      outcome: string;
    }>(`SELECT operator_id, action, outcome FROM operator_auth_events
       ORDER BY id`);
    expect(events.rows).toEqual([
      { operator_id: operator.id, action: "provision", outcome: "success" },
      { operator_id: operator.id, action: "rotate", outcome: "success" },
      { operator_id: operator.id, action: "disable", outcome: "success" }
    ]);
  });

  it("bounds hashed throttle buckets and cleans up only expired or revoked auth records", async () => {
    // Break caught: a throttle that lets a hash exceed its window, conflates
    // independently derived buckets, or cleanup that deletes live sessions.
    const auth = repositories.operatorAuth;
    const operator = await provisionOperator();
    const at = new Date("2026-09-21T12:00:00.000Z");
    const expiresAt = new Date("2026-09-21T12:15:00.000Z");
    await expect(
      auth.admitLoginAttempt({
        subjectHash: "hmac:login-and-address",
        limit: 2,
        expiresAt,
        at
      })
    ).resolves.toEqual({ kind: "admitted" });
    await expect(
      auth.admitLoginAttempt({
        subjectHash: "hmac:login-and-address",
        limit: 2,
        expiresAt,
        at
      })
    ).resolves.toEqual({ kind: "admitted" });
    await expect(
      auth.admitLoginAttempt({
        subjectHash: "hmac:login-and-address",
        limit: 2,
        expiresAt,
        at
      })
    ).resolves.toEqual({ kind: "throttled", retryAt: expiresAt });
    await expect(
      auth.admitLoginAttempt({
        subjectHash: "hmac:global-fallback",
        limit: 2,
        expiresAt,
        at
      })
    ).resolves.toEqual({ kind: "admitted" });

    await auth.issueSession({
      sessionId: "10000000-0000-0000-0000-000000000008",
      secretDigest: "hmac:revoked-cleanup",
      operatorId: operator.id,
      credentialVersion: operator.credentialVersion,
      issuedAt: at,
      lastUsedAt: at,
      idleExpiresAt: new Date("2026-09-21T12:30:00.000Z"),
      absoluteExpiresAt: new Date("2026-09-21T20:00:00.000Z")
    });
    await auth.revokeSession("10000000-0000-0000-0000-000000000008", at);
    await auth.issueSession({
      sessionId: "10000000-0000-0000-0000-000000000009",
      secretDigest: "hmac:live-cleanup",
      operatorId: operator.id,
      credentialVersion: operator.credentialVersion,
      issuedAt: at,
      lastUsedAt: at,
      idleExpiresAt: new Date("2026-09-21T12:30:00.000Z"),
      absoluteExpiresAt: new Date("2026-09-21T20:00:00.000Z")
    });
    await expect(auth.cleanupExpired(expiresAt)).resolves.toEqual({
      sessions: 1,
      loginAttempts: 3
    });
    await expect(
      auth.useSession({
        sessionId: "10000000-0000-0000-0000-000000000009",
        secretDigest: "hmac:live-cleanup",
        at: new Date("2026-09-21T12:16:00.000Z"),
        idleExpiresAt: new Date("2026-09-21T12:46:00.000Z")
      })
    ).resolves.toMatchObject({ operator: { id: operator.id } });
  });

  it("appends audit rows that contain only the allowed safe fields", async () => {
    // Break caught: audit logging that stores any credential or session
    // material, or drops unknown-identity failures.
    const auth = repositories.operatorAuth;
    await auth.appendEvent({
      operatorId: null,
      action: "sign_in",
      outcome: "failure",
      at: new Date("2026-09-21T12:00:00.000Z")
    });

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'operator_auth_events'
       ORDER BY ordinal_position`
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "id",
      "operator_id",
      "action",
      "outcome",
      "occurred_at"
    ]);
    await expect(
      pool.query(
        "SELECT operator_id, action, outcome, occurred_at FROM operator_auth_events"
      )
    ).resolves.toMatchObject({
      rows: [
        {
          operator_id: null,
          action: "sign_in",
          outcome: "failure",
          occurred_at: new Date("2026-09-21T12:00:00.000Z")
        }
      ]
    });
  });
});
