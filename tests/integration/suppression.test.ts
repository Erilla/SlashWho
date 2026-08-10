import type {
  DiscoveryQueue,
  SnapshotCharacterInput
} from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applicationConfigSchema,
  createDiscoveryJobHandler,
  createSearchService
} from "../../packages/application/src";
import {
  createPostgresRepositories,
  runMigrations,
  type Repositories
} from "../../packages/database/src";
import { startPostgres } from "./postgres";

const root = { region: "eu", realm: "silvermoon", name: "ryii" } as const;
const related = { region: "us", realm: "area-52", name: "related" } as const;
const now = new Date("2026-08-04T12:00:00.000Z");
const config = applicationConfigSchema.parse({
  BOT_API_KEY: "bot-secret-that-is-at-least-32-characters",
  RATE_LIMIT_HASH_SECRET: "rate-secret-that-is-at-least-32-characters"
});

function observation(
  key: CharacterKey,
  displayName: string,
  source: SnapshotCharacterInput["source"]
): SnapshotCharacterInput {
  return {
    key,
    displayName,
    className: "Mage",
    level: 80,
    raiderIoUrl: `https://raider.io/characters/${key.region}/${key.realm}/${key.name}`,
    source
  };
}

describe("application suppression policy", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repositories: Repositories;
  let enqueued: string[];
  let seededRunId: string;
  let seededSnapshotId: string;
  let service: ReturnType<typeof createSearchService>;

  beforeAll(async () => {
    ({ pool, stop } = await startPostgres());
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE
      snapshot_characters,
      snapshots,
      rate_limit_events,
      discovery_runs,
      characters,
      suppressed_characters,
      negative_character_cache
      CASCADE`);
    repositories = createPostgresRepositories(pool);
    const run = await repositories.runs.createOrReuse(root, "anonymous");
    seededRunId = run.id;
    const snapshot = await repositories.snapshots.create({
      runId: run.id,
      rootKey: root,
      state: "complete",
      limitationCode: null,
      refreshedAt: now,
      characters: [
        observation(root, "Ryii", "input"),
        observation(related, "Related", "profile_guess")
      ]
    });
    seededSnapshotId = snapshot.id;
    enqueued = [];
    const queue: Pick<DiscoveryQueue, "enqueue"> = {
      async enqueue(payload) {
        enqueued.push(payload.runId);
        return payload.runId;
      }
    };
    service = createSearchService({
      repositories,
      queue,
      config,
      now: () => now
    });
  });

  afterAll(async () => {
    await stop();
  });

  it("filters a suppressed related character from public resources", async () => {
    // Break caught: removal of a related character could leave it visible in old snapshots.
    await repositories.suppressions.suppress(
      related,
      "verified private removal reason",
      null
    );

    const resource = await service.getCurrent(root);

    expect(resource?.snapshot.characters.map(({ name }) => name)).toEqual([
      "Ryii"
    ]);
    expect(resource?.snapshot.characterCount).toBe(1);
    expect(JSON.stringify(resource)).not.toMatch(
      /Related|profile_guess|verified private removal reason/
    );
  });

  it("returns not found and creates no job for a suppressed root", async () => {
    // Break caught: active suppression could hide reads but still permit rediscovery.
    await repositories.suppressions.suppress(
      root,
      "verified private removal reason",
      null
    );

    await expect(
      service.create({
        characterUrl: "https://raider.io/characters/eu/silvermoon/ryii",
        headers: new Headers({ "x-real-ip": "203.0.113.8" })
      })
    ).resolves.toEqual({
      kind: "not_found",
      code: "suppressed_character"
    });
    expect(enqueued).toHaveLength(0);
  });

  it("hides a pre-existing job after its root is suppressed", async () => {
    // Break caught: the job endpoint could keep disclosing a removed character URL.
    await repositories.suppressions.suppress(
      root,
      "verified private removal reason",
      null
    );

    await expect(service.getRun(seededRunId)).resolves.toBeNull();
  });

  it("hides a pre-existing historical snapshot after its root is suppressed", async () => {
    // Break caught: a direct immutable-snapshot URL could bypass a root removal.
    await repositories.suppressions.suppress(
      root,
      "verified private removal reason",
      null
    );

    await expect(
      service.getSnapshot(root, seededSnapshotId)
    ).resolves.toBeNull();
  });

  it("fails a reserved run whose root is suppressed before the worker executes it", async () => {
    // Break caught: suppression landing after reservation could publish a rootless
    // snapshot, roll the write back with snapshot_root_missing, burn every retry, and
    // leave the run permanently search_failed.
    const reserved = await repositories.runs.createOrReuse(root, "anonymous");
    await repositories.suppressions.suppress(
      root,
      "verified private removal reason",
      null
    );
    const handler = createDiscoveryJobHandler({
      repositories,
      gateway: {
        async getCharacter() {
          throw new Error("gateway_must_not_be_called");
        },
        async getClaimedCharacters() {
          throw new Error("gateway_must_not_be_called");
        },
        async resolveProfileGuess() {
          throw new Error("gateway_must_not_be_called");
        }
      },
      requestCap: 12,
      now: () => now
    });

    await expect(
      handler.execute(reserved.id, {
        attempt: 1,
        maxAttempts: 5,
        signal: new AbortController().signal
      })
    ).resolves.toBeUndefined();

    await expect(repositories.runs.find(reserved.id)).resolves.toMatchObject({
      status: "failed",
      errorCode: "character_not_found",
      snapshotId: null
    });
    await expect(
      pool.query(
        "SELECT count(*)::int AS total FROM snapshots WHERE discovery_run_id = $1",
        [reserved.id]
      )
    ).resolves.toMatchObject({ rows: [{ total: 0 }] });
  });

  it("cleans expired negative cache and suppression rows while retaining active rows", async () => {
    // Break caught: maintenance could delete permanent suppressions or retain expired policy state.
    await repositories.negativeCache.put(
      related,
      new Date("2026-08-04T11:59:59.000Z")
    );
    await repositories.suppressions.suppress(
      related,
      "expired",
      new Date("2026-08-04T11:59:59.000Z")
    );
    await repositories.suppressions.suppress(root, "permanent", null);

    await expect(service.cleanupExpired(now)).resolves.toEqual({
      rateLimits: 0,
      negativeCache: 1,
      suppressions: 1,
      fingerprintRequests: 0
    });
    await expect(repositories.suppressions.isActive(root, now)).resolves.toBe(
      true
    );
  });
});
