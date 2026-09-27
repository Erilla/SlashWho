import type { Pool } from "pg";
import { withAccountMailClient } from "./account-mail-query";
import {
  type AccountCredentialRow,
  type AccountRow,
  mapAccount,
  mapAccountCredential,
  mapAccountSummary
} from "./mappers";
import type { Account, AccountSession, Repositories } from "./repositories";
import { one, withTransaction } from "./sql";

type AdminMutation =
  | { kind: "role"; role: Account["role"] }
  | { kind: "active"; active: boolean }
  | { kind: "password_change" };

async function mutateAccountAdmin(
  pool: Pool,
  input: { actorId: string; targetId: string; at: Date },
  mutation: AdminMutation
): Promise<"updated" | "last_admin" | "forbidden" | "missing"> {
  return withTransaction(pool, async (client) => {
    // Serialize admin changes even when separate requests target different rows.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('account-admin', 1))"
    );
    const actor = await client.query<{
      role: Account["role"];
      active: boolean;
      verified_at: Date | null;
      password_change_required: boolean;
    }>(
      `SELECT role, active, verified_at, password_change_required
       FROM accounts WHERE id = $1 FOR UPDATE`,
      [input.actorId]
    );
    if (
      actor.rows[0]?.role !== "admin" ||
      !actor.rows[0].active ||
      !actor.rows[0].verified_at ||
      actor.rows[0].password_change_required
    ) {
      return "forbidden";
    }
    const target = await client.query<{
      role: Account["role"];
      active: boolean;
      verified_at: Date | null;
    }>(
      "SELECT role, active, verified_at FROM accounts WHERE id = $1 FOR UPDATE",
      [input.targetId]
    );
    if (!target.rows[0]) {
      return "missing";
    }
    if (
      !target.rows[0].verified_at &&
      ((mutation.kind === "role" && mutation.role === "admin") ||
        (mutation.kind === "active" &&
          mutation.active &&
          target.rows[0].role === "admin"))
    ) {
      return "forbidden";
    }
    const removesAdmin =
      target.rows[0].role === "admin" &&
      target.rows[0].active &&
      target.rows[0].verified_at !== null &&
      ((mutation.kind === "role" && mutation.role !== "admin") ||
        (mutation.kind === "active" && !mutation.active));
    if (removesAdmin) {
      const count = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM accounts WHERE role = 'admin' AND active AND verified_at IS NOT NULL"
      );
      if (one(count).count <= 1) {
        return "last_admin";
      }
    }
    if (mutation.kind === "role") {
      await client.query(
        `UPDATE accounts SET role = $2, credential_version = credential_version + 1,
         updated_at = $3 WHERE id = $1`,
        [input.targetId, mutation.role, input.at]
      );
    } else if (mutation.kind === "active") {
      await client.query(
        `UPDATE accounts SET active = $2, credential_version = credential_version + 1,
         updated_at = $3 WHERE id = $1`,
        [input.targetId, mutation.active, input.at]
      );
    } else {
      await client.query(
        `UPDATE accounts SET password_change_required = true,
         credential_version = credential_version + 1, updated_at = $2 WHERE id = $1`,
        [input.targetId, input.at]
      );
    }
    await client.query(
      `UPDATE account_sessions SET revoked_at = $2
       WHERE account_id = $1 AND revoked_at IS NULL`,
      [input.targetId, input.at]
    );
    await client.query(
      `INSERT INTO account_auth_events (account_id, action, outcome, occurred_at)
       VALUES ($1, $2, 'success', $3)`,
      [input.targetId, mutation.kind, input.at]
    );
    return "updated";
  });
}

export function createAccountRepositories(
  pool: Pool
): Pick<
  Repositories,
  "accountTokens" | "accountMail" | "accountCredentials" | "accountAuth"
> {
  return {
    accountTokens: {
      async admitRequest(input) {
        return withTransaction(pool, async (client) => {
          await client.query(
            input.purpose === "verify"
              ? "SELECT pg_advisory_xact_lock(hashtextextended('account-registration', 1))"
              : "SELECT pg_advisory_xact_lock(hashtextextended($1, 2))",
            input.purpose === "verify"
              ? []
              : [`account-${input.purpose}-${input.subjectHash}`]
          );
          const purpose =
            input.purpose === "verify"
              ? "registration_email"
              : `account_${input.purpose}`;
          const count = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM account_request_attempts
             WHERE purpose = $1 AND subject_hash = $2 AND expires_at > $3`,
            [purpose, input.subjectHash, input.at]
          );
          if (Number(one(count).count) >= input.limit) {
            return false;
          }
          await client.query(
            "INSERT INTO account_request_attempts (purpose, subject_hash, expires_at) VALUES ($1, $2, $3)",
            [purpose, input.subjectHash, input.expiresAt]
          );
          return true;
        });
      },
      async findAccountById(id) {
        const result = await pool.query<AccountCredentialRow>(
          "SELECT * FROM accounts WHERE id = $1",
          [id]
        );
        return result.rows[0] ? mapAccountCredential(result.rows[0]) : null;
      },
      async findAccountByEmail(canonicalEmail) {
        const result = await pool.query<AccountCredentialRow>(
          "SELECT * FROM accounts WHERE canonical_email = $1",
          [canonicalEmail]
        );
        return result.rows[0] ? mapAccountCredential(result.rows[0]) : null;
      },
      async findToken(input) {
        const result = await pool.query<AccountCredentialRow>(
          `SELECT a.* FROM account_mail_tokens t JOIN accounts a ON a.id = t.account_id
           WHERE t.token_digest = $1 AND t.purpose = $2 AND t.expires_at > $3
             AND t.consumed_at IS NULL AND a.active
             AND (a.verified_at IS NOT NULL OR a.created_at > $3::timestamptz - interval '7 days')`,
          [input.digest, input.purpose, input.at]
        );
        return result.rows[0] ? mapAccountCredential(result.rows[0]) : null;
      },
      async confirmVerification(input) {
        return withTransaction(pool, async (client) => {
          const lookup = await client.query<{ account_id: string }>(
            "SELECT account_id FROM account_mail_tokens WHERE token_digest = $1 AND purpose = 'verify'",
            [input.digest]
          );
          if (!lookup.rows[0]) {
            return false;
          }
          const account = await client.query(
            "SELECT id FROM accounts WHERE id = $1 AND active AND verified_at IS NULL AND password_hash = $2 AND created_at > $3::timestamptz - interval '7 days' FOR UPDATE",
            [lookup.rows[0].account_id, input.passwordHash, input.at]
          );
          if (!account.rows[0]) {
            return false;
          }
          const result = await client.query<{ account_id: string }>(
            `UPDATE account_mail_tokens t SET consumed_at = $3
             FROM accounts a WHERE t.account_id = a.id AND t.token_digest = $1
               AND t.purpose = 'verify' AND t.consumed_at IS NULL AND t.expires_at > $3
               AND a.active AND a.verified_at IS NULL AND a.password_hash = $2
             RETURNING t.account_id`,
            [input.digest, input.passwordHash, input.at]
          );
          if (!result.rows[0]) {
            return false;
          }
          await client.query(
            "UPDATE accounts SET verified_at = $2, updated_at = $2 WHERE id = $1 AND verified_at IS NULL",
            [result.rows[0].account_id, input.at]
          );
          await client.query(
            "UPDATE account_mail_tokens SET consumed_at = $2 WHERE account_id = $1 AND purpose = 'verify' AND consumed_at IS NULL",
            [result.rows[0].account_id, input.at]
          );
          return true;
        });
      },
      async completeReset(input) {
        return withTransaction(pool, async (client) => {
          const lookup = await client.query<{ account_id: string }>(
            "SELECT account_id FROM account_mail_tokens WHERE token_digest = $1 AND purpose = 'reset'",
            [input.digest]
          );
          if (!lookup.rows[0]) {
            return false;
          }
          const account = await client.query(
            "SELECT id FROM accounts WHERE id = $1 AND active AND (verified_at IS NOT NULL OR created_at > $2::timestamptz - interval '7 days') FOR UPDATE",
            [lookup.rows[0].account_id, input.at]
          );
          if (!account.rows[0]) {
            return false;
          }
          const token = await client.query<{ account_id: string }>(
            `UPDATE account_mail_tokens t SET consumed_at = $2 FROM accounts a
             WHERE t.account_id = a.id AND t.token_digest = $1 AND t.purpose = 'reset'
               AND t.consumed_at IS NULL AND t.expires_at > $2 AND a.active
             RETURNING t.account_id`,
            [input.digest, input.at]
          );
          if (!token.rows[0]) {
            return false;
          }
          const id = token.rows[0].account_id;
          await client.query(
            `UPDATE accounts SET password_hash = $2, password_salt = $3,
             scrypt_version = $4, scrypt_cost = $5, verified_at = COALESCE(verified_at, $6),
             password_change_required = false, credential_version = credential_version + 1,
             updated_at = $6 WHERE id = $1`,
            [
              id,
              input.passwordHash,
              input.passwordSalt,
              input.scryptVersion,
              input.scryptCost,
              input.at
            ]
          );
          await client.query(
            "UPDATE account_mail_tokens SET consumed_at = $2 WHERE account_id = $1 AND purpose IN ('reset', 'verify') AND consumed_at IS NULL",
            [id, input.at]
          );
          await client.query(
            "UPDATE account_sessions SET revoked_at = $2 WHERE account_id = $1 AND revoked_at IS NULL",
            [id, input.at]
          );
          return true;
        });
      },
      async issueEmailChange(input) {
        return withTransaction(pool, async (client) => {
          // One lock covers all three buckets and their inserts, including
          // requests from different accounts targeting the same destination.
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('account-email-change', 1))"
          );
          const account = await client.query<{ id: string; email: string }>(
            `SELECT id, email FROM accounts WHERE id = $1 AND password_hash = $2
             AND canonical_email = $3 AND credential_version = $4
             AND active AND verified_at IS NOT NULL FOR UPDATE`,
            [
              input.accountId,
              input.expectedPasswordHash,
              input.expectedCurrentCanonicalEmail,
              input.expectedCredentialVersion
            ]
          );
          if (!account.rows[0] || input.expiresAt <= input.at) {
            return false;
          }
          const buckets = [
            {
              purpose: "email_change_account",
              subject: input.accountId,
              limit: 5,
              duration: 3_600_000
            },
            {
              purpose: "email_change_destination",
              subject: input.destinationSubjectHash,
              limit: 3,
              duration: 86_400_000
            },
            {
              purpose: "email_change_global",
              subject: "global",
              limit: 100,
              duration: 3_600_000
            }
          ];
          for (const bucket of buckets) {
            const usage = await client.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM account_request_attempts
               WHERE purpose = $1 AND subject_hash = $2 AND expires_at > $3`,
              [bucket.purpose, bucket.subject, input.at]
            );
            if (Number(one(usage).count) >= bucket.limit) {
              return false;
            }
          }
          const occupied = await client.query(
            "SELECT 1 FROM accounts WHERE canonical_email = $1",
            [input.canonicalEmail]
          );
          if (occupied.rowCount) {
            return false;
          }
          // Admission and both outbox rows commit together: a rejected request
          // consumes no capacity and cannot invalidate the existing proofs.
          for (const bucket of buckets) {
            await client.query(
              `INSERT INTO account_request_attempts (purpose, subject_hash, expires_at)
               VALUES ($1, $2, $3)`,
              [
                bucket.purpose,
                bucket.subject,
                new Date(input.at.getTime() + bucket.duration)
              ]
            );
          }
          await client.query(
            "UPDATE account_mail_tokens SET consumed_at = $2 WHERE account_id = $1 AND purpose IN ('email_change_current', 'email_change_new') AND consumed_at IS NULL",
            [input.accountId, input.at]
          );
          const flow = await client.query<{ id: string }>(
            "SELECT gen_random_uuid() AS id"
          );
          for (const [purpose, proof] of [
            ["email_change_current", input.current],
            ["email_change_new", input.next]
          ] as const) {
            const token = await client.query<{ id: string }>(
              `INSERT INTO account_mail_tokens (account_id, purpose, token_digest, flow_id, proposed_canonical_email, proposed_email, expires_at, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
              [
                input.accountId,
                purpose,
                proof.digest,
                one(flow).id,
                input.canonicalEmail,
                input.email,
                input.expiresAt,
                input.at
              ]
            );
            await client.query(
              `INSERT INTO account_mail_outbox (token_id, encrypted_message, idempotency_key, expires_at, next_attempt_at, created_at)
               VALUES ($1, $2, gen_random_uuid()::text, $3, $4, $4)`,
              [one(token).id, proof.encryptedMessage, input.expiresAt, input.at]
            );
          }
          return true;
        });
      },
      async confirmEmailChange(input) {
        return withTransaction(pool, async (client) => {
          const lookup = await client.query<{ account_id: string }>(
            "SELECT account_id FROM account_mail_tokens WHERE token_digest = $1 AND purpose = $2",
            [input.digest, input.purpose]
          );
          if (!lookup.rows[0]) {
            return "invalid";
          }
          const account = await client.query<{ id: string }>(
            "SELECT id FROM accounts WHERE id = $1 AND active AND verified_at IS NOT NULL FOR UPDATE",
            [lookup.rows[0].account_id]
          );
          if (!account.rows[0]) {
            return "invalid";
          }
          const proof = await client.query<{
            flow_id: string;
            proposed_canonical_email: string;
            proposed_email: string;
          }>(
            `UPDATE account_mail_tokens SET consumed_at = $3 WHERE token_digest = $1 AND purpose = $2
             AND consumed_at IS NULL AND expires_at > $3 RETURNING flow_id, proposed_canonical_email, proposed_email`,
            [input.digest, input.purpose, input.at]
          );
          if (!proof.rows[0]) {
            return "invalid";
          }
          const partner = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM account_mail_tokens
             WHERE flow_id = $1 AND purpose = $2 AND consumed_at IS NOT NULL AND expires_at > $3`,
            [
              proof.rows[0].flow_id,
              input.purpose === "email_change_current"
                ? "email_change_new"
                : "email_change_current",
              input.at
            ]
          );
          if (Number(one(partner).count) !== 1) {
            return "pending";
          }
          const updated = await client.query(
            `UPDATE accounts SET canonical_email = $2, email = $3, credential_version = credential_version + 1,
             updated_at = $4 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM accounts WHERE canonical_email = $2 AND id <> $1)`,
            [
              account.rows[0].id,
              proof.rows[0].proposed_canonical_email,
              proof.rows[0].proposed_email,
              input.at
            ]
          );
          if (!updated.rowCount) {
            return "invalid";
          }
          await client.query(
            "UPDATE account_sessions SET revoked_at = $2 WHERE account_id = $1 AND revoked_at IS NULL",
            [account.rows[0].id, input.at]
          );
          await client.query(
            "UPDATE account_mail_tokens SET consumed_at = $2 WHERE account_id = $1 AND purpose = 'reset' AND consumed_at IS NULL",
            [account.rows[0].id, input.at]
          );
          await client.query(
            "UPDATE account_mail_tokens SET consumed_at = $2 WHERE account_id = $1 AND purpose IN ('email_change_current', 'email_change_new') AND consumed_at IS NULL",
            [account.rows[0].id, input.at]
          );
          return "changed";
        }).catch((error: unknown) => {
          if (
            (error as { code?: string; constraint?: string }).code ===
              "23505" &&
            (error as { constraint?: string }).constraint ===
              "accounts_canonical_email_idx"
          )
            return "invalid" as const;
          throw error;
        });
      }
    },
    accountMail: {
      async issue(input) {
        if (input.expiresAt <= input.at)
          throw new Error("account_mail_expired");
        if (input.purpose === "reset" && !input.expectedCanonicalEmail)
          throw new Error("account_reset_expected_email_required");
        return withTransaction(pool, async (client) => {
          if (input.purpose === "reset") {
            const account = await client.query(
              `SELECT id FROM accounts WHERE id = $1 AND canonical_email = $2
               AND active AND (verified_at IS NOT NULL OR created_at > $3::timestamptz - interval '7 days') FOR UPDATE`,
              [input.accountId, input.expectedCanonicalEmail, input.at]
            );
            if (!account.rows[0]) {
              return;
            }
          }
          const token = await client.query<{ id: string }>(
            `INSERT INTO account_mail_tokens
             (account_id, purpose, token_digest, expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [
              input.accountId,
              input.purpose,
              input.tokenDigest,
              input.expiresAt,
              input.at
            ]
          );
          await client.query(
            `INSERT INTO account_mail_outbox
             (token_id, encrypted_message, idempotency_key, expires_at, next_attempt_at, created_at)
             VALUES ($1, $2, gen_random_uuid()::text, $3, $4, $4)`,
            [one(token).id, input.encryptedMessage, input.expiresAt, input.at]
          );
        });
      },
      async claimDue(at, signal) {
        return withAccountMailClient(pool, signal, async (client, signal) => {
          // Also purge sent metadata after expiry; token records contain digests only.
          await client.query(
            "DELETE FROM account_mail_outbox WHERE expires_at <= $1",
            [at]
          );
          signal.throwIfAborted();
          const result = await client.query<{
            id: string;
            encrypted_message: string;
            idempotency_key: string;
            expires_at: Date;
            attempt: number;
          }>(
            `WITH due AS (
             SELECT id FROM account_mail_outbox
             WHERE sent_at IS NULL AND expires_at > $1 AND next_attempt_at <= $1
             ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE account_mail_outbox AS mail
           SET attempt = attempt + 1,
               next_attempt_at = $1 + make_interval(secs =>
                 LEAST(3600, 60 * power(2, LEAST(mail.attempt, 6)))::int)
           FROM due WHERE mail.id = due.id
           RETURNING mail.id, encrypted_message, idempotency_key, expires_at, attempt`,
            [at]
          );
          const row = result.rows[0];
          return row
            ? {
                id: row.id,
                encryptedMessage: row.encrypted_message,
                idempotencyKey: row.idempotency_key,
                expiresAt: row.expires_at,
                attempt: row.attempt
              }
            : null;
        });
      },
      async markSent(id, at, signal) {
        await withAccountMailClient(pool, signal, async (client) => {
          await client.query(
            `UPDATE account_mail_outbox SET sent_at = $2, encrypted_message = '' WHERE id = $1`,
            [id, at]
          );
        });
      }
    },
    accountCredentials: {
      async list(accountId) {
        const result = await pool.query<{
          provider: "blizzard" | "raiderio" | "warcraftlogs";
          encrypted_payload: string | null;
          version: number;
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT provider, encrypted_payload, version, created_at, updated_at
           FROM account_api_credentials WHERE account_id = $1`,
          [accountId]
        );
        return result.rows.map((row) => ({
          provider: row.provider,
          encryptedPayload: row.encrypted_payload,
          version: row.version,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }));
      },
      async get(accountId, provider) {
        const result = await pool.query<{
          provider: "blizzard" | "raiderio" | "warcraftlogs";
          encrypted_payload: string | null;
          version: number;
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT c.provider, c.encrypted_payload, c.version, c.created_at, c.updated_at
           FROM account_api_credentials c JOIN accounts a ON a.id = c.account_id
           WHERE c.account_id = $1 AND c.provider = $2 AND a.active AND a.verified_at IS NOT NULL`,
          [accountId, provider]
        );
        const row = result.rows[0];
        return row
          ? {
              provider: row.provider,
              encryptedPayload: row.encrypted_payload,
              version: row.version,
              createdAt: row.created_at,
              updatedAt: row.updated_at
            }
          : null;
      },
      async replace(input) {
        const result = await pool.query(
          `WITH changed AS (
           INSERT INTO account_api_credentials (account_id, provider, encrypted_payload, version, created_at, updated_at)
           SELECT id, $2, $3, 1, $5, $5 FROM accounts
           WHERE id = $1 AND active AND verified_at IS NOT NULL
             AND ($4 = 0 OR EXISTS (
               SELECT 1 FROM account_api_credentials
               WHERE account_id = $1 AND provider = $2 AND version = $4
             ))
           ON CONFLICT (account_id, provider) DO UPDATE SET
             encrypted_payload = EXCLUDED.encrypted_payload,
             version = account_api_credentials.version + 1,
             updated_at = EXCLUDED.updated_at
           WHERE account_api_credentials.version = $4
             AND EXISTS (SELECT 1 FROM accounts WHERE id = $1 AND active AND verified_at IS NOT NULL)
           RETURNING account_id
           )
           INSERT INTO account_auth_events (account_id, action, outcome, occurred_at)
           SELECT account_id, 'credential_replace', 'success', $5 FROM changed
           RETURNING id`,
          [
            input.accountId,
            input.provider,
            input.encryptedPayload,
            input.expectedVersion,
            input.at
          ]
        );
        return result.rowCount === 1 ? "saved" : "conflict";
      },
      async remove(accountId, provider, at, expectedVersion) {
        const result = await pool.query(
          `WITH changed AS (
           UPDATE account_api_credentials SET encrypted_payload = NULL,
             version = version + 1, updated_at = $3
           WHERE account_id = $1 AND provider = $2
             AND encrypted_payload IS NOT NULL
             AND ($4::integer IS NULL OR version = $4)
             AND EXISTS (SELECT 1 FROM accounts WHERE id = $1 AND active AND verified_at IS NOT NULL)
           RETURNING account_id
           )
           INSERT INTO account_auth_events (account_id, action, outcome, occurred_at)
           SELECT account_id, 'credential_remove', 'success', $3 FROM changed`,
          [accountId, provider, at, expectedVersion ?? null]
        );
        return result.rowCount === 1;
      }
    },
    accountAuth: {
      async findCredential(canonicalEmail) {
        const result = await pool.query<AccountCredentialRow>(
          "SELECT * FROM accounts WHERE canonical_email = $1",
          [canonicalEmail]
        );
        return result.rows[0] ? mapAccountCredential(result.rows[0]) : null;
      },
      async admitLoginAttempt(input) {
        return withTransaction(pool, async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 2))",
            [`account-login-${input.subjectHash}`]
          );
          const count = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM account_request_attempts WHERE purpose = 'login' AND subject_hash = $1 AND expires_at > $2",
            [input.subjectHash, input.at]
          );
          if (Number(one(count).count) >= input.limit) {
            return { kind: "throttled" as const, retryAt: input.expiresAt };
          }
          await client.query(
            "INSERT INTO account_request_attempts (purpose, subject_hash, expires_at) VALUES ('login', $1, $2)",
            [input.subjectHash, input.expiresAt]
          );
          return { kind: "admitted" as const };
        });
      },
      async appendEvent(input) {
        await pool.query(
          "INSERT INTO account_auth_events (account_id, action, outcome, occurred_at) VALUES ($1, $2, $3, $4)",
          [input.accountId, input.action, input.outcome, input.at]
        );
      },
      async issueSession(input) {
        const result = await pool.query<{
          id: string;
          account_id: string;
          credential_version: number;
          issued_at: Date;
          last_used_at: Date;
          idle_expires_at: Date;
          absolute_expires_at: Date | null;
          revoked_at: Date | null;
        }>(
          `INSERT INTO account_sessions (id, secret_digest, account_id, credential_version, issued_at, last_used_at, idle_expires_at, absolute_expires_at)
           SELECT $1, $2, id, credential_version, $5, $6, $7, $8 FROM accounts
           WHERE id = $3 AND credential_version = $4 AND active AND verified_at IS NOT NULL
           RETURNING id, account_id, credential_version, issued_at, last_used_at, idle_expires_at, absolute_expires_at, revoked_at`,
          [
            input.sessionId,
            input.secretDigest,
            input.accountId,
            input.credentialVersion,
            input.issuedAt,
            input.lastUsedAt,
            input.idleExpiresAt,
            input.absoluteExpiresAt
          ]
        );
        const row = result.rows[0];
        if (!row) return null;
        return {
          id: row.id,
          accountId: row.account_id,
          credentialVersion: row.credential_version,
          issuedAt: row.issued_at,
          lastUsedAt: row.last_used_at,
          idleExpiresAt: row.idle_expires_at,
          absoluteExpiresAt: row.absolute_expires_at,
          revokedAt: row.revoked_at
        } satisfies AccountSession;
      },
      async useSession(input) {
        const result = await pool.query<
          AccountRow & {
            session_id: string;
            session_account_id: string;
            session_credential_version: number;
            issued_at: Date;
            last_used_at: Date;
            idle_expires_at: Date;
            absolute_expires_at: Date | null;
            revoked_at: Date | null;
          }
        >(
          `UPDATE account_sessions s SET last_used_at = $3, idle_expires_at = LEAST($4, s.absolute_expires_at)
           FROM accounts a WHERE s.id = $1 AND s.secret_digest = $2 AND s.account_id = a.id
             AND s.revoked_at IS NULL AND s.idle_expires_at > $3 AND (s.absolute_expires_at IS NULL OR s.absolute_expires_at > $3)
             AND s.credential_version = a.credential_version AND a.active AND a.verified_at IS NOT NULL
           RETURNING a.*, s.id AS session_id, s.account_id AS session_account_id, s.credential_version AS session_credential_version,
             s.issued_at, s.last_used_at, s.idle_expires_at, s.absolute_expires_at, s.revoked_at`,
          [input.sessionId, input.secretDigest, input.at, input.idleExpiresAt]
        );
        const row = result.rows[0];
        return row
          ? {
              account: mapAccount(row),
              session: {
                id: row.session_id,
                accountId: row.session_account_id,
                credentialVersion: row.session_credential_version,
                issuedAt: row.issued_at,
                lastUsedAt: row.last_used_at,
                idleExpiresAt: row.idle_expires_at,
                absoluteExpiresAt: row.absolute_expires_at,
                revokedAt: row.revoked_at
              }
            }
          : null;
      },
      async revokeSession(sessionId, at) {
        await pool.query(
          "UPDATE account_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL",
          [sessionId, at]
        );
      },
      async changePassword(input) {
        return withTransaction(pool, async (client) => {
          const updated = await client.query<{ id: string }>(
            `UPDATE accounts SET password_hash = $5, password_salt = $6, scrypt_version = $7, scrypt_cost = $8,
               password_change_required = false, credential_version = credential_version + 1, updated_at = $9
             WHERE id = $1 AND credential_version = $3 AND password_hash = $4 AND active AND verified_at IS NOT NULL
               AND EXISTS (SELECT 1 FROM account_sessions WHERE id = $2 AND account_id = $1 AND revoked_at IS NULL AND idle_expires_at > $9 AND (absolute_expires_at IS NULL OR absolute_expires_at > $9))
             RETURNING id`,
            [
              input.accountId,
              input.sessionId,
              input.expectedCredentialVersion,
              input.expectedPasswordHash,
              input.passwordHash,
              input.passwordSalt,
              input.scryptVersion,
              input.scryptCost,
              input.at
            ]
          );
          if (updated.rows[0])
            await client.query(
              "UPDATE account_sessions SET revoked_at = $2 WHERE account_id = $1 AND revoked_at IS NULL",
              [input.accountId, input.at]
            );
          return Boolean(updated.rows[0]);
        });
      },
      async provisionAdmin(input) {
        return withTransaction(pool, async (client) => {
          const result = await client.query<AccountRow>(
            `INSERT INTO accounts
               (canonical_email, email, role, verified_at, password_change_required,
                password_hash, password_salt, scrypt_version, scrypt_cost,
                created_at, updated_at)
             VALUES ($1, $2, 'admin', $7, true, $3, $4, $5, $6, $7, $7)
             RETURNING id, canonical_email, email, role, active, verified_at,
                       password_change_required, credential_version, created_at, updated_at`,
            [
              input.canonicalEmail,
              input.email,
              input.passwordHash,
              input.passwordSalt,
              input.scryptVersion,
              input.scryptCost,
              input.at
            ]
          );
          const account = mapAccount(one(result));
          await client.query(
            `INSERT INTO account_auth_events (account_id, action, outcome, occurred_at)
             VALUES ($1, 'provision_admin', 'success', $2)`,
            [account.id, input.at]
          );
          return account;
        });
      },

      setRole(input) {
        return mutateAccountAdmin(pool, input, {
          kind: "role",
          role: input.role
        });
      },

      setActive(input) {
        return mutateAccountAdmin(pool, input, {
          kind: "active",
          active: input.active
        });
      },

      async requirePasswordChange(input) {
        return (
          (await mutateAccountAdmin(pool, input, {
            kind: "password_change"
          })) === "updated"
        );
      },

      async listAccounts(actorId) {
        const result = await pool.query<AccountRow>(
          `SELECT id, canonical_email, email, role, active, verified_at,
                  password_change_required, credential_version, created_at, updated_at
           FROM accounts
           WHERE EXISTS (
             SELECT 1 FROM accounts AS actor
             WHERE actor.id = $1 AND actor.role = 'admin' AND actor.active
               AND actor.verified_at IS NOT NULL
               AND NOT actor.password_change_required
           )
           ORDER BY canonical_email`,
          [actorId]
        );
        return result.rows.map(mapAccountSummary);
      },

      async registerPending(input) {
        return withTransaction(pool, async (client) => {
          // A limited batch makes progress on old pending registrations without
          // turning a signup into an unbounded table sweep. Remove the target
          // first so a backlog cannot keep an expired address unavailable.
          const targetCleanup = await client.query(
            `DELETE FROM accounts
             WHERE canonical_email = $2 AND verified_at IS NULL
               AND created_at <= $1::timestamptz - interval '7 days'`,
            [input.at, input.canonicalEmail]
          );
          await client.query(
            `WITH expired AS (
               SELECT id FROM accounts
               WHERE verified_at IS NULL AND created_at <= $1::timestamptz - interval '7 days'
               ORDER BY created_at, id LIMIT $2
               FOR UPDATE SKIP LOCKED
             )
             DELETE FROM accounts WHERE id IN (SELECT id FROM expired)`,
            [input.at, 100 - (targetCleanup.rowCount ?? 0)]
          );
          const result = await client.query<{ id: string }>(
            `INSERT INTO accounts
               (canonical_email, email, password_hash, password_salt,
                scrypt_version, scrypt_cost, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
             ON CONFLICT (canonical_email) DO NOTHING
             RETURNING id`,
            [
              input.canonicalEmail,
              input.email,
              input.passwordHash,
              input.passwordSalt,
              input.scryptVersion,
              input.scryptCost,
              input.at
            ]
          );
          return result.rows[0]
            ? { kind: "created" as const, accountId: result.rows[0].id }
            : { kind: "existing" as const };
        });
      },

      async admitRegistration(input) {
        return withTransaction(pool, async (client) => {
          // The global lock serializes all admission buckets, including the
          // missing-IP fallback, so concurrent requests cannot over-admit.
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('account-registration', 1))"
          );
          const buckets = [
            {
              purpose: "registration_global",
              subject: "global",
              limit: 100,
              duration: 3_600_000
            },
            input.ipSubjectHash
              ? {
                  purpose: "registration_ip",
                  subject: input.ipSubjectHash,
                  limit: 5,
                  duration: 3_600_000
                }
              : {
                  purpose: "registration_missing_ip",
                  subject: "fallback",
                  limit: 10,
                  duration: 3_600_000
                },
            {
              purpose: "registration_email",
              subject: input.emailSubjectHash,
              limit: 3,
              duration: 86_400_000
            }
          ];
          for (const bucket of buckets) {
            const usage = await client.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM account_request_attempts
               WHERE purpose = $1 AND subject_hash = $2 AND expires_at > $3`,
              [bucket.purpose, bucket.subject, input.at]
            );
            if (Number(one(usage).count) >= bucket.limit) {
              return "throttled";
            }
          }
          for (const bucket of buckets) {
            await client.query(
              `INSERT INTO account_request_attempts (purpose, subject_hash, expires_at)
               VALUES ($1, $2, $3)`,
              [
                bucket.purpose,
                bucket.subject,
                new Date(input.at.getTime() + bucket.duration)
              ]
            );
          }
          return "admitted";
        });
      }
    }
  };
}
