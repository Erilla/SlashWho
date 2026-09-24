ALTER TABLE "accounts" DROP CONSTRAINT "accounts_canonical_email_check";
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_canonical_email_check" CHECK (
  char_length("canonical_email") BETWEEN 3 AND 254
  AND "canonical_email" ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$'
);
