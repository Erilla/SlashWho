CREATE TABLE "dossier_searches" (
	"region" text NOT NULL,
	"realm_slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"searched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dossier_searches_pkey" PRIMARY KEY("region","realm_slug","normalized_name")
);
--> statement-breakpoint
CREATE INDEX "dossier_searches_searched_at_idx" ON "dossier_searches" USING btree ("searched_at");
