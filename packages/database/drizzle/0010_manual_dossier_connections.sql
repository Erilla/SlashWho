CREATE TABLE "manual_dossier_connections" (
	"root_character_id" uuid NOT NULL,
	"connected_character_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_dossier_connections_pkey" PRIMARY KEY("root_character_id","connected_character_id"),
	CONSTRAINT "manual_dossier_connections_distinct_characters_check" CHECK ("manual_dossier_connections"."root_character_id" <> "manual_dossier_connections"."connected_character_id")
);
--> statement-breakpoint
ALTER TABLE "manual_dossier_connections" ADD CONSTRAINT "manual_dossier_connections_root_character_id_characters_id_fk" FOREIGN KEY ("root_character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_dossier_connections" ADD CONSTRAINT "manual_dossier_connections_connected_character_id_characters_id_fk" FOREIGN KEY ("connected_character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;

