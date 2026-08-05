import type {
  DiscoveryQueue,
  SnapshotCharacterInput
} from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applicationConfigSchema,
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
    await repositories.snapshots.create({
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
      suppressions: 1
    });
    await expect(repositories.suppressions.isActive(root, now)).resolves.toBe(
      true
    );
  });
});
