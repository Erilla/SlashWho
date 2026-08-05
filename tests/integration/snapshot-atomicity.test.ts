import type {
  CharacterKey,
  RaiderIoCharacter,
  RaiderIoGateway
} from "@slashwho/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDiscoveryJobHandler } from "../../packages/application/src";
import {
  createPostgresRepositories,
  runMigrations
} from "../../packages/database/src";
import { startPostgres } from "./postgres";

const rootKey: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "atomic-root"
};

function character(name: string): RaiderIoCharacter {
  return {
    key: { ...rootKey, name },
    displayName: name,
    className: "Mage",
    level: 80,
    ownerId: name === rootKey.name ? "owner" : null,
    profileGuess: null,
    declaredMain: null
  };
}

describe("discovery snapshot atomicity", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;

  beforeAll(async () => {
    postgres = await startPostgres();
    await runMigrations(postgres.pool);
  });

  afterAll(async () => {
    await postgres.stop();
  });

  it("rolls back observations, membership, and publication together", async () => {
    // Break caught: a mid-write failure could expose a partial snapshot or complete run.
    const repositories = createPostgresRepositories(postgres.pool);
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const gateway: RaiderIoGateway = {
      async getCharacter() {
        return character(rootKey.name);
      },
      async getClaimedCharacters() {
        return [character("related")];
      },
      async resolveProfileGuess() {
        return null;
      }
    };
    await postgres.pool.query(`
      CREATE FUNCTION reject_second_membership() RETURNS trigger AS $$
      BEGIN
        IF NEW.display_order = 1 THEN
          RAISE EXCEPTION 'controlled membership failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_second_membership
      BEFORE INSERT ON snapshot_characters
      FOR EACH ROW EXECUTE FUNCTION reject_second_membership();
    `);

    const handler = createDiscoveryJobHandler({
      repositories,
      gateway,
      requestCap: 12
    });

    await expect(handler.execute(run.id)).rejects.toThrow(
      "controlled membership failure"
    );
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "running",
      snapshotId: null
    });
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toBeNull();
    await expect(
      postgres.pool.query("SELECT count(*)::int AS count FROM snapshots")
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      postgres.pool.query(
        "SELECT count(*)::int AS count FROM snapshot_characters"
      )
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
