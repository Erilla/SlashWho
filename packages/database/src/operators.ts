import type { Pool } from "pg";
import {
  type OperatorCredentialRow,
  type OperatorRow,
  type OperatorSessionRow,
  type UsedOperatorSessionRow,
  mapOperator,
  mapOperatorCredential,
  mapOperatorSession,
  mapUsedOperatorSession
} from "./mappers";
import type { Repositories } from "./repositories";
import { one, withTransaction } from "./sql";

export function createOperatorRepositories(
  pool: Pool
): Pick<Repositories, "operatorAuth"> {
  return {
    operatorAuth: {
      async findCredential(canonicalLogin) {
        const result = await pool.query<OperatorCredentialRow>(
          `SELECT id, canonical_login, display_login, password_hash,
                  password_salt, scrypt_version, scrypt_cost, active,
                  credential_version, created_at, updated_at
           FROM operators
           WHERE canonical_login = $1`,
          [canonicalLogin]
        );
        return result.rows[0] ? mapOperatorCredential(result.rows[0]) : null;
      },

      async provision(input) {
        return withTransaction(pool, async (client) => {
          const result = await client.query<OperatorRow>(
            `INSERT INTO operators
              (canonical_login, display_login, password_hash, password_salt,
               scrypt_version, scrypt_cost, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
             RETURNING id, canonical_login, display_login, active,
                       credential_version, created_at, updated_at`,
            [
              input.canonicalLogin,
              input.displayLogin,
              input.passwordHash,
              input.passwordSalt,
              input.scryptVersion,
              input.scryptCost,
              input.at
            ]
          );
          const operator = mapOperator(one(result));
          await client.query(
            `INSERT INTO operator_auth_events
              (operator_id, action, outcome, occurred_at)
             VALUES ($1, 'provision', 'success', $2)`,
            [operator.id, input.at]
          );
          return operator;
        });
      },

      async rotateCredential(input) {
        return withTransaction(pool, async (client) => {
          const result = await client.query<OperatorRow>(
            `UPDATE operators
             SET password_hash = $2,
                 password_salt = $3,
                 scrypt_version = $4,
                 scrypt_cost = $5,
                 credential_version = credential_version + 1,
                 updated_at = $6
             WHERE id = $1
             RETURNING id, canonical_login, display_login, active,
                       credential_version, created_at, updated_at`,
            [
              input.operatorId,
              input.passwordHash,
              input.passwordSalt,
              input.scryptVersion,
              input.scryptCost,
              input.at
            ]
          );
          if (!result.rows[0]) {
            return null;
          }
          const operator = mapOperator(result.rows[0]);
          await client.query(
            `UPDATE operator_sessions
             SET revoked_at = $2
             WHERE operator_id = $1 AND revoked_at IS NULL`,
            [operator.id, input.at]
          );
          await client.query(
            `INSERT INTO operator_auth_events
              (operator_id, action, outcome, occurred_at)
             VALUES ($1, 'rotate', 'success', $2)`,
            [operator.id, input.at]
          );
          return operator;
        });
      },

      async disable(operatorId, at) {
        return withTransaction(pool, async (client) => {
          const result = await client.query<OperatorRow>(
            `UPDATE operators
             SET active = false, updated_at = $2
             WHERE id = $1
             RETURNING id, canonical_login, display_login, active,
                       credential_version, created_at, updated_at`,
            [operatorId, at]
          );
          if (!result.rows[0]) {
            return null;
          }
          const operator = mapOperator(result.rows[0]);
          await client.query(
            `UPDATE operator_sessions
             SET revoked_at = $2
             WHERE operator_id = $1 AND revoked_at IS NULL`,
            [operator.id, at]
          );
          await client.query(
            `INSERT INTO operator_auth_events
              (operator_id, action, outcome, occurred_at)
             VALUES ($1, 'disable', 'success', $2)`,
            [operator.id, at]
          );
          return operator;
        });
      },

      async list() {
        const result = await pool.query<OperatorRow>(
          `SELECT id, canonical_login, display_login, active,
                  credential_version, created_at, updated_at
           FROM operators
           ORDER BY canonical_login`
        );
        return result.rows.map(mapOperator);
      },

      async admitLoginAttempt(input) {
        if (!Number.isInteger(input.limit) || input.limit < 1) {
          throw new RangeError("operator_login_limit_out_of_range");
        }
        if (input.expiresAt <= input.at) {
          throw new RangeError("operator_login_expiry_out_of_range");
        }
        return withTransaction(pool, async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
            [input.subjectHash]
          );
          const usage = await client.query<{
            count: string;
            retry_at: Date | null;
          }>(
            `SELECT count(*)::text AS count, min(expires_at) AS retry_at
             FROM operator_login_attempts
             WHERE subject_hash = $1 AND expires_at > $2`,
            [input.subjectHash, input.at]
          );
          if (Number(one(usage).count) >= input.limit) {
            const retryAt = one(usage).retry_at;
            if (!retryAt) throw new Error("operator_login_retry_missing");
            return { kind: "throttled" as const, retryAt };
          }
          await client.query(
            `INSERT INTO operator_login_attempts (subject_hash, expires_at)
             VALUES ($1, $2)`,
            [input.subjectHash, input.expiresAt]
          );
          return { kind: "admitted" as const };
        });
      },

      async appendEvent(input) {
        await pool.query(
          `INSERT INTO operator_auth_events
            (operator_id, action, outcome, occurred_at)
           VALUES ($1, $2, $3, $4)`,
          [input.operatorId, input.action, input.outcome, input.at]
        );
      },

      async issueSession(input) {
        const result = await pool.query<OperatorSessionRow>(
          `INSERT INTO operator_sessions
            (id, secret_digest, operator_id, credential_version, issued_at,
             last_used_at, idle_expires_at, absolute_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, operator_id, credential_version, issued_at,
                     last_used_at, idle_expires_at, absolute_expires_at,
                     revoked_at`,
          [
            input.sessionId,
            input.secretDigest,
            input.operatorId,
            input.credentialVersion,
            input.issuedAt,
            input.lastUsedAt,
            input.idleExpiresAt,
            input.absoluteExpiresAt
          ]
        );
        return mapOperatorSession(one(result));
      },

      async useSession(input) {
        const result = await pool.query<UsedOperatorSessionRow>(
          `UPDATE operator_sessions AS session
           SET last_used_at = $3,
               idle_expires_at = LEAST($4::timestamptz, session.absolute_expires_at)
           FROM operators AS operator
           WHERE session.id = $1
             AND session.secret_digest = $2
             AND session.operator_id = operator.id
             AND operator.active = true
             AND session.credential_version = operator.credential_version
             AND session.revoked_at IS NULL
             AND session.idle_expires_at > $3
             AND session.absolute_expires_at > $3
           RETURNING session.id AS session_id,
                     session.operator_id AS session_operator_id,
                     session.credential_version AS session_credential_version,
                     session.issued_at, session.last_used_at,
                     session.idle_expires_at, session.absolute_expires_at,
                     session.revoked_at,
                     operator.id, operator.canonical_login, operator.display_login,
                     operator.active, operator.credential_version,
                     operator.created_at, operator.updated_at`,
          [input.sessionId, input.secretDigest, input.at, input.idleExpiresAt]
        );
        return result.rows[0] ? mapUsedOperatorSession(result.rows[0]) : null;
      },

      async revokeSession(sessionId, at) {
        await pool.query(
          `UPDATE operator_sessions
           SET revoked_at = $2
           WHERE id = $1 AND revoked_at IS NULL`,
          [sessionId, at]
        );
      },

      async cleanupExpired(at) {
        const sessions = await pool.query(
          `DELETE FROM operator_sessions
           WHERE revoked_at IS NOT NULL
              OR idle_expires_at <= $1
              OR absolute_expires_at <= $1`,
          [at]
        );
        const loginAttempts = await pool.query(
          "DELETE FROM operator_login_attempts WHERE expires_at <= $1",
          [at]
        );
        return {
          sessions: sessions.rowCount ?? 0,
          loginAttempts: loginAttempts.rowCount ?? 0
        };
      }
    }
  };
}
