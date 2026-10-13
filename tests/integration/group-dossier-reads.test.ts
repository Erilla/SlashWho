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
