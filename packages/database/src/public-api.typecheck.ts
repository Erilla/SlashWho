import {
  createPostgresRepositories,
  runMigrations,
  type Repositories
} from ".";

// @ts-expect-error The raw Drizzle client bypasses repository invariants.
import { createDatabase } from ".";
// @ts-expect-error The mutable Drizzle schema is internal persistence detail.
import { schema } from ".";

void createPostgresRepositories;
void runMigrations;
void (undefined as Repositories | undefined);
void createDatabase;
void schema;
