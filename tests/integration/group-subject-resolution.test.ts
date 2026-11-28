import type { Pool } from "pg";
import { groupMemberFacts, isFresh, type CharacterKey } from "@slashwho/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  observation,
  resetRepositoryTables,
  rootKey,
  altKey,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";
import { resolveSubjects } from "../../packages/application/src/dossier-subjects";

describe("group subject snapshot privacy", () => {
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
    key: CharacterKey,
    characters: ReturnType<typeof observation>[],
    at: Date,
    partial = false
  ) {
    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);
    await repositories.snapshots.create({
      runId: run.id,
      rootKey: key,
      state: partial ? "partial" : "complete",
      limitationCode: partial ? "privacy_hidden" : null,
      refreshedAt: at,
      characters
    });
    await pool.query(
      "UPDATE discovery_runs SET completed_at = $2 WHERE id = $1",
      [run.id, at]
    );
  }

  async function link() {
    await repositories.manualConnections.add(rootKey, altKey);
    const ids = (
      await pool.query<{ id: string }>("SELECT id FROM characters")
    ).rows.map((row) => row.id);
    await repositories.characterConnections!.recomputeGroupsOf(ids);
  }

  it("excludes a suppressed folded snapshot member from rows, research and freshness", async () => {
    const at = new Date();
    const old = new Date(at.getTime() - 48 * 3_600_000);
    await publish(
      rootKey,
      [
        observation(rootKey, "Ryii"),
        observation(altKey, "Suppressed", "claimed")
      ],
      old
    );
    await publish(altKey, [observation(altKey, "Suppressed")], at, true);
    await repositories.suppressions.suppress(altKey, "privacy", null);
    const resolved = await resolveSubjects(rootKey, repositories, {
      DOSSIER_CHARACTER_CEILING: 50
    });
    expect(resolved!.selected.map((row) => row.key)).toEqual([rootKey]);
    expect(resolved!.research).toEqual({
      state: "complete",
      message: "Linked-character research is complete."
    });
    const read = (await repositories.groupReads!.read(rootKey, at))!;
    const facts = groupMemberFacts(read, rootKey);
    expect(facts.runs.map((run) => run.rootKey)).toEqual([rootKey]);
    expect(
      isFresh(
        facts.runs.flatMap((run) => (run.completedAt ? [run.completedAt] : [])),
        at,
        24
      )
    ).toBe(false);
  });

  it("keeps an undiscovered origin root-only when its only snapshot root is suppressed", async () => {
    await publish(
      altKey,
      [
        observation(altKey, "Suppressed"),
        observation(rootKey, "Ryii", "claimed")
      ],
      new Date()
    );
    await link();
    const stored = (await repositories.snapshots.getCurrent(altKey))!;
    await repositories.suppressions.suppress(altKey, "privacy", null);
    expect(
      await resolveSubjects(rootKey, repositories, {
        DOSSIER_CHARACTER_CEILING: 50
      })
    ).toBeNull();
    const read = (await repositories.groupReads!.read(rootKey, new Date()))!;
    // The PostgreSQL loader currently filters suppressed publications itself.
    // Pin the resolver's boundary too when an adapter supplies stored snapshots.
    expect(
      await resolveSubjects(
        rootKey,
        {
          ...repositories,
          groupReads: { read: async () => ({ ...read, snapshots: [stored] }) }
        },
        { DOSSIER_CHARACTER_CEILING: 50 }
      )
    ).toBeNull();
  });

  it("never borrows guild facts from a suppressed snapshot root", async () => {
    const visible = { ...rootKey, name: "visible" };
    await publish(rootKey, [observation(rootKey, "Ryii")], new Date());
    await publish(
      altKey,
      [
        observation(altKey, "Suppressed"),
        {
          ...observation(visible, "Visible", "claimed"),
          guild: { name: "Hidden guild", realm: "silvermoon", region: "eu" }
        }
      ],
      new Date()
    );
    await repositories.manualConnections.add(rootKey, visible);
    await link();
    const stored = (await repositories.snapshots.getCurrent(altKey))!;
    await repositories.suppressions.suppress(altKey, "privacy", null);
    const resolved = await resolveSubjects(rootKey, repositories, {
      DOSSIER_CHARACTER_CEILING: 50
    });
    expect(
      resolved!.selected.find((row) => row.key.name === visible.name)!.guild
    ).toBeNull();
    const read = (await repositories.groupReads!.read(rootKey, new Date()))!;
    const originId = read.graph.idOf(rootKey)!;
    expect(read.graph.latestSnapshot.get(originId)!.refreshedAt).toEqual(
      read.ownSnapshot!.refreshedAt
    );
    const suppliedStoredSnapshot = await resolveSubjects(
      rootKey,
      {
        ...repositories,
        groupReads: {
          read: async () => ({
            ...read,
            snapshots: [...read.snapshots, stored]
          })
        }
      },
      { DOSSIER_CHARACTER_CEILING: 50 }
    );
    expect(
      suppliedStoredSnapshot!.selected.find(
        (row) => row.key.name === visible.name
      )!.guild
    ).toBeNull();
  });
});
