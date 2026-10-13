import type { Pool } from "pg";
import type { CharacterKey } from "@slashwho/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  observation,
  resetRepositoryTables,
  rootKey,
  altKey,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";
import { pageMembers } from "../../packages/application/src/group-subjects";
import { loadGroupRead } from "../../packages/database/src/group-reads";
import {
  COUNTING_LINKS,
  COUNTING_LINKS_FROM
} from "../../packages/database/src/counting-links";
import { withConsistentRead } from "../../packages/database/src/sql";
import { resolveSubjects } from "../../packages/application/src/dossier-subjects";
import { createSearchService } from "../../packages/application/src/search-service";
import { applicationConfigSchema } from "../../packages/application/src/config";

const third = { region: "eu", realm: "silvermoon", name: "third" } as const;

describe("consistent group dossier projection", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repositories: TestRepositories;
  beforeAll(async () => {
    ({ pool, stop, repositories } = await startRepositoryDatabase());
  });
  beforeEach(async () => {
    await resetRepositoryTables(pool);
  });
  afterAll(async () => {
    await stop();
  });

  async function publish(
    key: CharacterKey = rootKey,
    members = [
      observation(rootKey, "Ryii"),
      observation(altKey, "Other", "claimed")
    ]
  ) {
    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);
    await repositories.snapshots.create({
      runId: run.id,
      rootKey: key,
      state: "complete",
      limitationCode: null,
      refreshedAt: new Date(),
      characters: members
    });
    return run.id;
  }

  it("folds in committed membership before any observation or recompute", async () => {
    await publish();
    const read = await repositories.groupReads?.read(rootKey, new Date());
    expect(read?.ownSnapshot?.characters.map((c) => c.key.name)).toEqual([
      "ryii",
      "other"
    ]);
    expect(read?.graph.characters.size).toBe(2);
    expect(read?.runs.some((run) => run.status === "complete")).toBe(true);
    const resolved = await resolveSubjects(rootKey, repositories, {
      DOSSIER_CHARACTER_CEILING: 50
    });
    expect(resolved?.selected.map((c) => [c.key.name, c.source])).toEqual([
      ["ryii", "input"],
      ["other", "claimed"]
    ]);
  });

  it("opens a discovered sibling without its own snapshot rooted at that sibling", async () => {
    const runId = await publish();
    await repositories.characterConnections!.writeObservations({
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" }]
        }
      ]
    });
    const ids = (
      await pool.query<{ id: string }>("SELECT id FROM characters")
    ).rows.map((row) => row.id);
    await repositories.characterConnections!.recomputeGroupsOf(ids);
    const resolved = await resolveSubjects(altKey, repositories, {
      DOSSIER_CHARACTER_CEILING: 50
    });
    expect(resolved?.snapshot).toBeNull();
    expect(resolved?.selected.map((c) => [c.key.name, c.source])).toEqual([
      ["other", "input"],
      ["ryii", "claimed"]
    ]);
    expect(resolved?.research?.state).toBe("partial");
    expect(resolved?.provisional).toBe(false);
  });

  async function grouped() {
    const runId = await publish();
    await repositories.characterConnections!.writeObservations({
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" }]
        }
      ]
    });
    const ids = (
      await pool.query<{ id: string }>("SELECT id FROM characters")
    ).rows.map((row) => row.id);
    await repositories.characterConnections!.recomputeGroupsOf(ids);
  }

  const reserve = (key: CharacterKey, freshnessCutoff: Date) =>
    repositories.searchReservations.reserve({
      key,
      callerClass: "anonymous",
      callerBucketHash: key.name,
      limit: 10,
      at: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      freshnessCutoff
    });

  it("reserves one run and one charge for concurrent stale sibling searches", async () => {
    await grouped();
    const results = await Promise.all([
      reserve(rootKey, new Date(Date.now() + 10_000)),
      reserve(altKey, new Date(Date.now() + 10_000))
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["active", "reserved"]);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM rate_limit_events"))
        .rows[0].n
    ).toBe(1);
  });

  it("freshness comes from a sibling's completed run even without an own snapshot", async () => {
    await grouped();
    expect(await reserve(altKey, new Date(Date.now() - 60_000))).toEqual({
      kind: "fresh"
    });
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM rate_limit_events"))
        .rows[0].n
    ).toBe(0);
  });

  it("a negatively cached fresh sibling returns group_ready without a provider read", async () => {
    await grouped();
    await repositories.negativeCache.put(altKey, new Date(Date.now() + 60_000));
    let providerReads = 0;
    const unavailable = async (): Promise<never> => {
      throw new Error("queue_not_expected");
    };
    const search = createSearchService({
      repositories,
      queue: { enqueue: unavailable },
      raiderio: {
        getCharacter: async () => {
          providerReads++;
          throw new Error("provider_not_expected");
        }
      },
      config: applicationConfigSchema.parse({
        BOT_API_KEY: "bot-secret-that-is-at-least-32-characters",
        RATE_LIMIT_HASH_SECRET: "rate-secret-that-is-at-least-32-characters"
      })
    });
    const result = await search.create({
      characterUrl: `https://raider.io/characters/${altKey.region}/${altKey.realm}/${altKey.name}`,
      headers: new Headers({ "x-real-ip": "203.0.113.90" })
    });
    expect(result).toEqual({ kind: "group_ready", key: altKey });
    expect(providerReads).toBe(0);
  });

  it("stale searches refused by the allowance make no provider read", async () => {
    await grouped();
    const config = applicationConfigSchema.parse({
      BOT_API_KEY: "bot-secret-that-is-at-least-32-characters",
      RATE_LIMIT_HASH_SECRET: "rate-secret-that-is-at-least-32-characters",
      ANONYMOUS_SEARCHES_PER_HOUR: 1
    });
    let providerReads = 0;
    const unavailable = async (): Promise<never> => {
      throw new Error("queue_not_expected");
    };
    const search = createSearchService({
      repositories,
      queue: { enqueue: unavailable },
      raiderio: {
        getCharacter: async () => {
          providerReads++;
          throw new Error("provider_not_expected");
        }
      },
      config
    });
    const command = {
      characterUrl: `https://raider.io/characters/${altKey.region}/${altKey.realm}/${altKey.name}`,
      headers: new Headers({ "x-real-ip": "203.0.113.90" })
    };
    // Charge exactly the search bucket the service will use; complete the old group well outside freshness.
    const { classifyCaller } =
      await import("../../packages/application/src/auth");
    const caller = classifyCaller(command.headers, config);
    await pool.query(
      "UPDATE discovery_runs SET completed_at = now() - interval '2 days' WHERE status = 'complete'"
    );
    await repositories.rateLimits.reserve(
      `search:${caller.bucketHash}`,
      1,
      new Date(Date.now() + 60_000),
      new Date()
    );
    expect(await search.create(command)).toMatchObject({
      kind: "rate_limited"
    });
    expect(providerReads).toBe(0);
  });

  it("Include and Remove clear suppressed makers across stored membership", async () => {
    await grouped();
    await repositories.manualConnections.add(altKey, rootKey);
    await repositories.manualConnections.setExcluded(altKey, rootKey, true);
    await repositories.suppressions.suppress(altKey, "privacy", null);
    expect(
      await repositories.manualConnections.setGroupExcluded?.(
        rootKey,
        [rootKey],
        false
      )
    ).toBe("updated");
    expect(
      (await pool.query("SELECT excluded_at FROM manual_dossier_connections"))
        .rows[0].excluded_at
    ).toBeNull();
    expect(
      await repositories.manualConnections.removeGroupConnection?.(
        rootKey,
        rootKey
      )
    ).toBe("removed");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM manual_dossier_connections"
        )
      ).rows[0].n
    ).toBe(0);
  });

  it("does not traverse a suppressed bridge to a fresh sibling", async () => {
    const runId = await publish();
    const otherRun = await publish(third, [observation(third, "Third")]);
    await repositories.characterConnections!.writeObservations({
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" }]
        }
      ]
    });
    await repositories.characterConnections!.writeObservations({
      runId: otherRun,
      observerKey: third,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" }]
        }
      ]
    });
    const ids = await pool.query<{ id: string }>("SELECT id FROM characters");
    await repositories.characterConnections!.recomputeGroupsOf(
      ids.rows.map((row) => row.id)
    );
    await repositories.suppressions.suppress(altKey, "privacy", null);
    const read = await repositories.groupReads?.read(rootKey, new Date());
    expect(read).toBeDefined();
    const members = pageMembers(read!.graph.idOf(rootKey)!, read!.graph);
    expect(
      [...members].map((id) => read!.graph.characters.get(id)!.key.name)
    ).toEqual(["ryii"]);
    expect(await repositories.groupReads?.read(altKey, new Date())).toBeNull();
  });

  it("reads the old snapshot consistently when publication commits mid-read", async () => {
    await publish();
    const read = await withConsistentRead(pool, async (client) => {
      // Establish the repeatable-read snapshot, then publish using another client.
      await client.query("SELECT count(*) FROM snapshots");
      await publish(rootKey, [
        observation(rootKey, "Ryii"),
        observation(third, "Third", "claimed")
      ]);
      return loadGroupRead(client, rootKey, new Date());
    });
    expect(read?.ownSnapshot?.characters.map((c) => c.key.name)).toEqual([
      "ryii",
      "other"
    ]);
    const after = await repositories.groupReads!.read(rootKey, new Date());
    expect(after?.ownSnapshot?.characters.map((c) => c.key.name)).toEqual([
      "ryii",
      "third"
    ]);
  });

  it("scoped and full counting links agree on observed and manual edges", async () => {
    const runId = await publish();
    await repositories.characterConnections!.writeObservations({
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" }]
        }
      ]
    });
    const ids = (
      await pool.query<{ id: string }>("SELECT id FROM characters")
    ).rows.map((row) => row.id);
    await repositories.manualConnections.add(rootKey, altKey);
    const full = (await pool.query(COUNTING_LINKS)).rows;
    const scoped = (await pool.query(COUNTING_LINKS_FROM, [ids])).rows;
    expect(scoped).toEqual(full);
    expect(
      new Set(full.map((row) => [row.a, row.b].sort().join(":"))).size
    ).toBe(1);
  });
});
