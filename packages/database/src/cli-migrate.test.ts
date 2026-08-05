import { expect, it, vi } from "vitest";

import { migrateFromEnvironment } from "./cli-migrate";
import { resolveMigrationsFolder } from "./migrate";

it("uses the packaged migration directory when configured", () => {
  // Break caught: bundlers rewrite import.meta.url, so web readiness must not
  // derive the migration directory from a virtual Next.js chunk path.
  expect(
    resolveMigrationsFolder({
      SLASHWHO_MIGRATIONS_FOLDER: "/app/migrate/drizzle"
    })
  ).toBe("/app/migrate/drizzle");
});

it("fails closed when a deployment has no database URL", async () => {
  // Break caught: a container could start without applying migrations.
  await expect(migrateFromEnvironment({}, {} as never)).rejects.toThrow(
    "database_url_required"
  );
});

it("waits for migrations and closes the deployment pool", async () => {
  // Break caught: the app process could start before migrations settle or leak
  // its one-shot pool after a successful deployment migration.
  const events: string[] = [];
  const pool = { end: vi.fn(async () => void events.push("closed")) };
  await migrateFromEnvironment(
    { DATABASE_URL: "postgresql://slashwho:test@db/slashwho" },
    {
      createPool: () => pool,
      runMigrations: vi.fn(async () => void events.push("migrated"))
    }
  );

  expect(events).toEqual(["migrated", "closed"]);
});

it("closes the deployment pool when migration fails", async () => {
  // Break caught: a failed migration could leave the container hanging on an
  // open database handle instead of terminating for Railway to restart.
  const pool = { end: vi.fn(async () => undefined) };
  await expect(
    migrateFromEnvironment(
      { DATABASE_URL: "postgresql://slashwho:test@db/slashwho" },
      {
        createPool: () => pool,
        runMigrations: async () => {
          throw new Error("migration_failed");
        }
      }
    )
  ).rejects.toThrow("migration_failed");
  expect(pool.end).toHaveBeenCalledOnce();
});
