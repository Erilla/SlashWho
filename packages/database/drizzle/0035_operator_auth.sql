CREATE TABLE "operators" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "canonical_login" text NOT NULL,
  "display_login" text NOT NULL,
  "password_hash" text NOT NULL,
  "password_salt" text NOT NULL,
  "scrypt_version" integer NOT NULL,
  "scrypt_cost" integer NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "credential_version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "operators_canonical_login_check"
    CHECK (char_length("canonical_login") BETWEEN 1 AND 64 AND "canonical_login" ~ '^[a-z0-9_-]+$')
);
--> statement-breakpoint
CREATE TABLE "operator_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "secret_digest" text NOT NULL,
  "operator_id" uuid NOT NULL REFERENCES "operators"("id"),
  "credential_version" integer NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone NOT NULL,
  "idle_expires_at" timestamp with time zone NOT NULL,
  "absolute_expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "operator_login_attempts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "subject_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_auth_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "operator_id" uuid REFERENCES "operators"("id"),
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "operator_auth_events_action_check"
    CHECK ("action" IN ('provision', 'rotate', 'disable', 'sign_in', 'sign_out', 'session_revoke')),
  CONSTRAINT "operator_auth_events_outcome_check"
    CHECK ("outcome" IN ('success', 'failure'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operators_canonical_login_idx"
  ON "operators" USING btree ("canonical_login");
--> statement-breakpoint
CREATE INDEX "operator_sessions_live_operator_idx"
  ON "operator_sessions" USING btree ("operator_id")
  WHERE "operator_sessions"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "operator_sessions_absolute_expiry_idx"
  ON "operator_sessions" USING btree ("absolute_expires_at");
--> statement-breakpoint
CREATE INDEX "operator_login_attempts_subject_expiry_idx"
  ON "operator_login_attempts" USING btree ("subject_hash", "expires_at");
--> statement-breakpoint
CREATE INDEX "operator_login_attempts_expiry_idx"
  ON "operator_login_attempts" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "operator_auth_events_operator_occurred_idx"
  ON "operator_auth_events" USING btree ("operator_id", "occurred_at");
