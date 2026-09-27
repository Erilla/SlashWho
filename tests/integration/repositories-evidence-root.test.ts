import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  altKey,
  resetRepositoryTables,
  rootKey,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

/**
 * The dossier root each evidence run serves: the character whose search
 * queued it, recorded once at reservation like `origin`, so the monitor can
 * link an alt's run back to the search that started it.
 */
describe("PostgreSQL repositories: evidence run root", () => {
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

  const otherRoot = {
    region: "eu",
    realm: "draenor",
    name: "other"
  } as const;

  it("keeps the reserving root when another dossier joins the run", async () => {
    const at = new Date("2026-09-27T12:00:00.000Z");
    const reserved = await repositories.evidence.reserve({
      key: altKey,
      origin: "dossier_read",
      root: rootKey,
      freshnessCutoff: at,
      at
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");

    // A second dossier that also lists the alt joins the run in flight. The
    // run still names the search that queued it, not the latest reader.
    const joined = await repositories.evidence.reserve({
      key: altKey,
      origin: "dossier_read",
      root: otherRoot,
      freshnessCutoff: at,
      at
    });
    expect(joined).toMatchObject({
      kind: "active",
      run: { id: reserved.run.id }
    });

    await expect(
      repositories.evidence.listForMonitor({ completedLimit: 10 })
    ).resolves.toEqual([
      expect.objectContaining({ key: altKey, root: rootKey })
    ]);
  });

  it("records no root for a caller without one, rather than the run's own key", async () => {
    const at = new Date("2026-09-27T12:00:00.000Z");
    await repositories.evidence.reserve({
      key: rootKey,
      origin: "resume_sweep",
      freshnessCutoff: at,
      at
    });
    await repositories.evidence.reserve({
      key: altKey,
      origin: "refresh",
      root: null,
      freshnessCutoff: at,
      at
    });

    const rows = await repositories.evidence.listForMonitor({
      completedLimit: 10
    });
    expect(rows.map((row) => row.root)).toEqual([null, null]);
  });

  it("records the dossier a tier search was pressed on", async () => {
    const at = new Date("2026-09-27T12:00:00.000Z");
    const ordinary = await repositories.evidence.reserve({
      key: altKey,
      origin: "dossier_read",
      root: rootKey,
      freshnessCutoff: at,
      at
    });
    if (ordinary.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.claim(ordinary.run.id, 1);
    await repositories.evidence.publish(ordinary.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: at
    });

    const search = await repositories.evidence.reserveTierSearch({
      key: altKey,
      root: otherRoot,
      raidId: "42",
      at: new Date("2026-09-27T12:05:00.000Z"),
      searchedSince: new Date("2026-09-27T11:05:00.000Z")
    });
    if (search.kind !== "reserved") throw new Error("tier_not_reserved");

    // Completed and in-flight runs each keep their own root.
    const rows = await repositories.evidence.listForMonitor({
      completedLimit: 10
    });
    expect(rows).toEqual([
      expect.objectContaining({ status: "queued", root: otherRoot }),
      expect.objectContaining({ status: "complete", root: rootKey })
    ]);
  });

  it("refuses a partly recorded root", async () => {
    // A root is a whole character key or nothing: a lone region could not be
    // linked, and would read as a root that is not there.
    await expect(
      pool.query(
        `INSERT INTO character_evidence_runs
           (region, realm_slug, normalized_name, root_region)
         VALUES ($1, $2, $3, 'eu')`,
        [altKey.region, altKey.realm, altKey.name]
      )
    ).rejects.toThrow(/character_evidence_runs_root_check/);
  });
});
