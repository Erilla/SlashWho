import {
  createPostgresRepositories,
  runMigrations,
  type FingerprintAdmission,
  type FingerprintSweepRepository,
  type Repositories
} from ".";

// @ts-expect-error The raw Drizzle client bypasses repository invariants.
import { createDatabase } from ".";
// @ts-expect-error The mutable Drizzle schema is internal persistence detail.
import { schema } from ".";

void createPostgresRepositories;
void runMigrations;
void (undefined as Repositories | undefined);
void (undefined as FingerprintAdmission | undefined);
void (undefined as FingerprintSweepRepository | undefined);
void createDatabase;
void schema;
