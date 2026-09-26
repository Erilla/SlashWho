-- Account sessions no longer carry an absolute lifetime (#534). NULL means the
-- session lasts until sign-out, revocation or its sliding idle deadline.
ALTER TABLE "account_sessions" ALTER COLUMN "absolute_expires_at" DROP NOT NULL;
--> statement-breakpoint
UPDATE "account_sessions" SET "absolute_expires_at" = NULL WHERE "revoked_at" IS NULL;
