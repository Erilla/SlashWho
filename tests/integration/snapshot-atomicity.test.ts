import type {
  CharacterKey,
  RaiderIoCharacter,
  RaiderIoGateway
} from "@slashwho/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

  beforeEach(async () => {
    await postgres.pool.query(`
      DROP TRIGGER IF EXISTS reject_second_membership ON snapshot_characters;
      DROP FUNCTION IF EXISTS reject_second_membership();
      DROP TRIGGER IF EXISTS delay_snapshot_insert ON snapshots;
      DROP FUNCTION IF EXISTS delay_snapshot_insert();
      DROP TRIGGER IF EXISTS delay_negative_cache_insert ON negative_character_cache;
      DROP FUNCTION IF EXISTS delay_negative_cache_insert();
      TRUNCATE TABLE snapshot_characters, snapshots, discovery_runs, characters,
        negative_character_cache CASCADE;
    `);
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
        return { characters: [character("related")] };
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

    await expect(
      handler.execute(run.id, {
        attempt: 1,
        maxAttempts: 5,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ retryable: true });
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "retrying",
      attempt: 1,
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

  it("reconciles a final-delivery publication failure to failed", async () => {
    // Break caught: the last pg-boss delivery could leave a run active after rollback.
    const repositories = createPostgresRepositories(postgres.pool);
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const gateway: RaiderIoGateway = {
      async getCharacter() {
        return character(rootKey.name);
      },
      async getClaimedCharacters() {
        return { characters: [character("related")] };
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

    await expect(
      handler.execute(run.id, {
        attempt: 5,
        maxAttempts: 5,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("controlled membership failure");

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "failed",
      attempt: 5,
      errorCode: "search_failed",
      snapshotId: null
    });
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toBeNull();
  });

  it("rolls back a snapshot when cancellation arrives during persistence", async () => {
    // Break caught: a drain-time abort during SQL could still publish a snapshot.
    const repositories = createPostgresRepositories(postgres.pool);
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const controller = new AbortController();
    const gateway: RaiderIoGateway = {
      async getCharacter() {
        return character(rootKey.name);
      },
      async getClaimedCharacters() {
        return { characters: [character("related")] };
      },
      async resolveProfileGuess() {
        return null;
      }
    };
    await postgres.pool.query(`
      CREATE FUNCTION delay_snapshot_insert() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.25);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER delay_snapshot_insert
      BEFORE INSERT ON snapshots
      FOR EACH ROW EXECUTE FUNCTION delay_snapshot_insert();
    `);
    const handler = createDiscoveryJobHandler({
      repositories,
      gateway,
      requestCap: 12
    });
    const abortTimer = setTimeout(
      () => controller.abort(new DOMException("drain timeout", "AbortError")),
      50
    );

    await expect(
      handler.execute(run.id, {
        attempt: 1,
        maxAttempts: 5,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    clearTimeout(abortTimer);

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "running",
      attempt: 1,
      snapshotId: null,
      errorCode: null
    });
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toBeNull();
    await expect(
      postgres.pool.query("SELECT count(*)::int AS count FROM snapshots")
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("rolls back negative cache and failure when cancellation arrives during persistence", async () => {
    // Break caught: abort between cache insertion and run failure could leak an absence.
    const repositories = createPostgresRepositories(postgres.pool);
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const controller = new AbortController();
    const missing = Object.assign(new Error("missing"), { kind: "not_found" });
    const gateway: RaiderIoGateway = {
      async getCharacter() {
        throw missing;
      },
      async getClaimedCharacters() {
        return { characters: [] };
      },
      async resolveProfileGuess() {
        return null;
      }
    };
    await postgres.pool.query(`
      CREATE FUNCTION delay_negative_cache_insert() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.25);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER delay_negative_cache_insert
      BEFORE INSERT ON negative_character_cache
      FOR EACH ROW EXECUTE FUNCTION delay_negative_cache_insert();
    `);
    const handler = createDiscoveryJobHandler({
      repositories,
      gateway,
      requestCap: 12
    });
    const abortTimer = setTimeout(
      () => controller.abort(new DOMException("drain timeout", "AbortError")),
      50
    );

    await expect(
      handler.execute(run.id, {
        attempt: 1,
        maxAttempts: 5,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    clearTimeout(abortTimer);

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "running",
      attempt: 1,
      errorCode: null
    });
    await expect(repositories.negativeCache.find(rootKey)).resolves.toBeNull();
  });

  it("reconciles an unexpected gateway error before persistence", async () => {
    const repositories = createPostgresRepositories(postgres.pool);
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const gateway: RaiderIoGateway = {
      async getCharacter() {
        throw new Error("unexpected gateway failure");
      },
      async getClaimedCharacters() {
        return { characters: [] };
      },
      async resolveProfileGuess() {
        return null;
      }
    };
    const handler = createDiscoveryJobHandler({
      repositories,
      gateway,
      requestCap: 12
    });

    await expect(
      handler.execute(run.id, {
        attempt: 1,
        maxAttempts: 5,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ retryable: true });

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "retrying",
      attempt: 1,
      snapshotId: null
    });
  });

  it("atomically rejects an overlapping duplicate delivery", async () => {
    const repositories = createPostgresRepositories(postgres.pool);
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const gatewayStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gateway: RaiderIoGateway = {
      async getCharacter() {
        calls += 1;
        started();
        await blocked;
        return character(rootKey.name);
      },
      async getClaimedCharacters() {
        return { characters: [] };
      },
      async resolveProfileGuess() {
        return null;
      }
    };
    const handler = createDiscoveryJobHandler({
      repositories,
      gateway,
      requestCap: 12
    });
    const context = {
      attempt: 1,
      maxAttempts: 5,
      signal: new AbortController().signal
    };

    const first = handler.execute(run.id, context);
    await gatewayStarted;
    await expect(handler.execute(run.id, context)).resolves.toBeUndefined();
    expect(calls).toBe(1);
    release();
    await first;

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "complete",
      attempt: 1
    });
  });
});
