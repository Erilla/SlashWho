-- Drizzle runs each migration in one transaction. Keep the legacy tables during
-- the application transition, but remove every legacy credential and session.
UPDATE operator_auth_events SET operator_id = NULL WHERE operator_id IS NOT NULL;
--> statement-breakpoint
DELETE FROM operator_sessions;
--> statement-breakpoint
DELETE FROM operators;
--> statement-breakpoint
DELETE FROM operator_login_attempts;
--> statement-breakpoint
CREATE TABLE "accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "canonical_email" text NOT NULL,
  "email" text NOT NULL,
  "role" text DEFAULT 'user' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "verified_at" timestamp with time zone,
  "password_change_required" boolean DEFAULT false NOT NULL,
  "password_hash" text NOT NULL,
  "password_salt" text NOT NULL,
  "scrypt_version" integer NOT NULL,
  "scrypt_cost" integer NOT NULL,
  "credential_version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "accounts_role_check" CHECK ("role" IN ('user', 'admin')),
  CONSTRAINT "accounts_canonical_email_check" CHECK (
    char_length("canonical_email") BETWEEN 3 AND 254
    AND "canonical_email" ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_canonical_email_idx" ON "accounts" ("canonical_email");
--> statement-breakpoint
CREATE INDEX "accounts_unverified_created_idx" ON "accounts" ("created_at") WHERE "verified_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "account_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "secret_digest" text NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "credential_version" integer NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone NOT NULL,
  "idle_expires_at" timestamp with time zone NOT NULL,
  "absolute_expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "account_sessions_live_account_idx" ON "account_sessions" ("account_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "account_sessions_absolute_expiry_idx" ON "account_sessions" ("absolute_expires_at");
--> statement-breakpoint
CREATE TABLE "account_request_attempts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "purpose" text NOT NULL,
  "subject_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_request_attempts_subject_expiry_idx" ON "account_request_attempts" ("purpose", "subject_hash", "expires_at");
--> statement-breakpoint
CREATE INDEX "account_request_attempts_expiry_idx" ON "account_request_attempts" ("expires_at");
--> statement-breakpoint
CREATE TABLE "account_mail_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "token_digest" text NOT NULL,
  "purpose" text NOT NULL,
  "flow_id" uuid,
  "proposed_canonical_email" text,
  "proposed_email" text,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_mail_tokens_purpose_check" CHECK ("purpose" IN ('verify', 'reset', 'email_change_current', 'email_change_new'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_mail_tokens_digest_idx" ON "account_mail_tokens" ("token_digest");
--> statement-breakpoint
CREATE INDEX "account_mail_tokens_account_purpose_idx" ON "account_mail_tokens" ("account_id", "purpose", "expires_at");
--> statement-breakpoint
CREATE INDEX "account_mail_tokens_flow_idx" ON "account_mail_tokens" ("flow_id");
--> statement-breakpoint
CREATE INDEX "account_mail_tokens_expiry_idx" ON "account_mail_tokens" ("expires_at");
--> statement-breakpoint
CREATE TABLE "account_mail_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_id" uuid REFERENCES "account_mail_tokens"("id") ON DELETE CASCADE,
  "encrypted_message" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_mail_outbox_idempotency_idx" ON "account_mail_outbox" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "account_mail_outbox_due_idx" ON "account_mail_outbox" ("next_attempt_at", "expires_at") WHERE "sent_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "account_mail_outbox_expiry_idx" ON "account_mail_outbox" ("expires_at");
--> statement-breakpoint
CREATE TABLE "account_api_credentials" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "encrypted_payload" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_api_credentials_pkey" PRIMARY KEY ("account_id", "provider"),
  CONSTRAINT "account_api_credentials_provider_check" CHECK ("provider" IN ('blizzard', 'raiderio', 'warcraftlogs'))
);
--> statement-breakpoint
CREATE TABLE "account_auth_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_auth_events_outcome_check" CHECK ("outcome" IN ('success', 'failure'))
);
--> statement-breakpoint
CREATE INDEX "account_auth_events_account_occurred_idx" ON "account_auth_events" ("account_id", "occurred_at");
--> statement-breakpoint
ALTER TABLE "character_evidence_runs" ADD COLUMN "account_credential_owner_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "character_evidence_runs" ADD COLUMN "account_credential_version" integer;
