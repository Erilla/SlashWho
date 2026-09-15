ALTER TABLE "manual_dossier_connections" ADD COLUMN "connected_region" text;--> statement-breakpoint
ALTER TABLE "manual_dossier_connections" ADD COLUMN "connected_realm_slug" text;--> statement-breakpoint
ALTER TABLE "manual_dossier_connections" ADD COLUMN "connected_normalized_name" text;--> statement-breakpoint
UPDATE "manual_dossier_connections" AS connection
SET "connected_region" = connected."region",
    "connected_realm_slug" = connected."realm_slug",
    "connected_normalized_name" = connected."normalized_name"
FROM "characters" AS connected
WHERE connected."id" = connection."connected_character_id";--> statement-breakpoint
ALTER TABLE "manual_dossier_connections" ALTER COLUMN "connected_region" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "manual_dossier_connections" ALTER COLUMN "connected_realm_slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "manual_dossier_connections" ALTER COLUMN "connected_normalized_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "manual_dossier_connections" DROP CONSTRAINT "manual_dossier_connections_pkey";--> statement-breakpoint
ALTER TABLE "manual_dossier_connections" DROP CONSTRAINT "manual_dossier_connections_distinct_characters_check";--> statement-breakpoint
ALTER TABLE "manual_dossier_connections" DROP CONSTRAINT "manual_dossier_connections_connected_character_id_characters_id_fk";--> statement-breakpoint
ALTER TABLE "manual_dossier_connections" DROP COLUMN "connected_character_id";--> statement-breakpoint
ALTER TABLE "manual_dossier_connections" ADD CONSTRAINT "manual_dossier_connections_pkey" PRIMARY KEY("root_character_id","connected_region","connected_realm_slug","connected_normalized_name");
