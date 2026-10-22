import type { Pool } from "pg";
import { createPostgresRepositories } from "../../packages/database/src";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  rootKey,
  altKey,
  observation,
  seedCompleteSnapshot,
  resetRepositoryTables,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

/**
 * Manual dossier connections, discovered-character exclusions and historic
 * aliases.
 *
 * Split from one file so each area runs in parallel with its own PostgreSQL;
 * the shared set-up is in `repository-fixtures.ts`.
 */
describe("PostgreSQL repositories: dossier connections", () => {
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

  describe("manual dossier connections", () => {
    const pendingKey = {
      region: "eu",
      realm: "silvermoon",
      name: "undiscovered"
    } as const;

    it("links a character that has not been discovered yet", async () => {
      // Break caught: the insert used to join `characters` twice, so a target
      // with no row yielded no rows and was reported as a duplicate. A
      // reviewer could not link a character before its discovery finished.
      await seedCompleteSnapshot(repositories);

      await expect(
        repositories.manualConnections.add(rootKey, pendingKey)
      ).resolves.toBe("added");

      const listed = await repositories.manualConnections.list(rootKey);
      expect(listed).toEqual([
        {
          key: pendingKey,
          displayName: "undiscovered",
          className: null,
          level: 0,
          raiderIoUrl:
            "https://raider.io/characters/eu/silvermoon/undiscovered",
          pending: true,
          origin: "dossier",
          excluded: false
        }
      ]);
    });

    it("keeps a reviewer's link when the worker adds the same one, and converts the worker's when a reviewer does", async () => {
      // Break caught: ON CONFLICT DO NOTHING left a reviewer's own add marked as
      // the applicant's, and DO UPDATE ... RETURNING reported a re-add as "added".
      const root = {
        region: "eu" as const,
        realm: "hyjal",
        name: "originroot"
      };
      const member = {
        region: "eu" as const,
        realm: "hyjal",
        name: "originmember"
      };
      const other = {
        region: "eu" as const,
        realm: "hyjal",
        name: "originother"
      };
      await pool.query(
        "INSERT INTO characters (region, realm_slug, normalized_name, display_name, class_name, level, raider_io_url) VALUES ('eu', 'hyjal', 'originroot', 'Originroot', 'Mage', 80, 'https://raider.io/characters/eu/hyjal/originroot')"
      );
      const application = await insertApplication(pool);

      expect(
        await repositories.manualConnections.add(root, member, {
          origin: "applicant_sheet",
          applicationId: application
        })
      ).toBe("added");
      await repositories.manualConnections.setExcluded(root, member, true);
      expect(await repositories.manualConnections.add(root, member)).toBe(
        "duplicate"
      );
      const converted = (await repositories.manualConnections.list(root)).find(
        (row) => row.key.name === "originmember"
      );
      expect(converted).toMatchObject({ origin: "dossier", excluded: true });
      expect(await repositories.manualConnections.add(root, member)).toBe(
        "duplicate"
      );

      expect(await repositories.manualConnections.add(root, other)).toBe(
        "added"
      );
      expect(
        await repositories.manualConnections.add(root, other, {
          origin: "applicant_sheet",
          applicationId: application
        })
      ).toBe("duplicate");
      expect(
        (await repositories.manualConnections.list(root)).find(
          (row) => row.key.name === "originother"
        )?.origin
      ).toBe("dossier");
    });

    it("never relabels an applicant or reviewer link when the bot adds it", async () => {
      const root = {
        region: "eu" as const,
        realm: "hyjal",
        name: "originroot"
      };
      const member = {
        region: "eu" as const,
        realm: "hyjal",
        name: "originmember"
      };
      const other = {
        region: "eu" as const,
        realm: "hyjal",
        name: "originother"
      };
      await pool.query(
        "INSERT INTO characters (region, realm_slug, normalized_name, display_name, class_name, level, raider_io_url) VALUES ('eu', 'hyjal', 'originroot', 'Originroot', 'Mage', 80, 'https://raider.io/characters/eu/hyjal/originroot')"
      );
      const application = await insertApplication(pool);

      await repositories.manualConnections.add(root, member, {
        origin: "applicant_sheet",
        applicationId: application
      });
      expect(
        await repositories.manualConnections.add(root, member, {
          origin: "bot"
        })
      ).toBe("duplicate");
      expect(
        (await repositories.manualConnections.list(root)).find(
          (row) => row.key.name === member.name
        )?.origin
      ).toBe("applicant_sheet");

      await repositories.manualConnections.add(root, other);
      expect(
        await repositories.manualConnections.add(root, other, {
          origin: "bot"
        })
      ).toBe("duplicate");
      expect(
        (await repositories.manualConnections.list(root)).find(
          (row) => row.key.name === other.name
        )?.origin
      ).toBe("dossier");
    });

    it("reports a repeated link as a duplicate rather than adding it twice", async () => {
      await seedCompleteSnapshot(repositories);
      await repositories.manualConnections.add(rootKey, pendingKey);

      await expect(
        repositories.manualConnections.add(rootKey, pendingKey)
      ).resolves.toBe("duplicate");
      expect(await repositories.manualConnections.list(rootKey)).toHaveLength(
        1
      );
    });

    it("resolves the character once discovery creates it", async () => {
      // Break caught: the link is stored by key, so it has to pick up the real
      // display name, class and level on its own as soon as the character
      // exists, with no second write and no backfill step.
      await seedCompleteSnapshot(repositories);
      await repositories.manualConnections.add(rootKey, altKey);

      expect(await repositories.manualConnections.list(rootKey)).toMatchObject([
        { pending: true, className: null, level: 0 }
      ]);

      const run = await repositories.runs.createOrReuse(altKey, "anonymous");
      await repositories.runs.markRunning(run.id);
      const snapshot = await repositories.snapshots.create({
        runId: run.id,
        rootKey: altKey,
        state: "complete",
        limitationCode: null,
        refreshedAt: new Date(),
        characters: [observation(altKey, "Other")]
      });
      await repositories.runs.complete(run.id, snapshot.id);

      expect(await repositories.manualConnections.list(rootKey)).toEqual([
        {
          key: altKey,
          displayName: "Other",
          className: "Mage",
          level: 80,
          raiderIoUrl: "https://raider.io/characters/us/area-52/other",
          pending: false,
          origin: "dossier",
          excluded: false
        }
      ]);
    });

    it("withholds a connection whose character has an active removal request", async () => {
      await seedCompleteSnapshot(repositories);
      await repositories.manualConnections.add(rootKey, pendingKey);
      await repositories.suppressions.suppress(pendingKey, "removal", null);

      expect(await repositories.manualConnections.list(rootKey)).toEqual([]);
    });

    it("marks a connection as excluded and restores it again", async () => {
      await seedCompleteSnapshot(repositories);
      await repositories.manualConnections.add(rootKey, pendingKey);

      await expect(
        repositories.manualConnections.setExcluded(rootKey, pendingKey, true)
      ).resolves.toBe("updated");
      expect(await repositories.manualConnections.list(rootKey)).toMatchObject([
        { excluded: true }
      ]);

      await expect(
        repositories.manualConnections.setExcluded(rootKey, pendingKey, false)
      ).resolves.toBe("updated");
      expect(await repositories.manualConnections.list(rootKey)).toMatchObject([
        { excluded: false }
      ]);
    });

    it("reports an exclusion of a character that is not linked as missing", async () => {
      // Two reviewers can hold the same dossier, so the second must be told
      // the link has gone rather than shown a change it did not make.
      await seedCompleteSnapshot(repositories);

      await expect(
        repositories.manualConnections.setExcluded(rootKey, pendingKey, true)
      ).resolves.toBe("missing");
    });

    it("unlinks a connection without touching the character or its snapshot", async () => {
      await seedCompleteSnapshot(repositories, {
        characters: [observation(rootKey, "Ryii"), observation(altKey, "Other")]
      });
      await repositories.manualConnections.add(rootKey, altKey);

      await expect(
        repositories.manualConnections.remove(rootKey, altKey)
      ).resolves.toBe("removed");

      expect(await repositories.manualConnections.list(rootKey)).toEqual([]);
      // #186: removal unlinks, it does not delete the discovered character or
      // the snapshot that found it.
      const snapshot = await repositories.snapshots.getCurrent(rootKey);
      expect(
        snapshot?.characters.map((character) => character.key.name)
      ).toContain(altKey.name);
    });

    it("reports a removal of a character that is not linked as missing", async () => {
      await seedCompleteSnapshot(repositories);

      await expect(
        repositories.manualConnections.remove(rootKey, pendingKey)
      ).resolves.toBe("missing");
    });

    it("keeps an exclusion scoped to the dossier it was made on", async () => {
      // A connection is stored per root, so excluding a character on one
      // applicant's dossier must say nothing about anyone else's.
      await seedCompleteSnapshot(repositories, {
        characters: [observation(rootKey, "Ryii"), observation(altKey, "Other")]
      });
      await repositories.manualConnections.add(rootKey, pendingKey);
      await repositories.manualConnections.add(altKey, pendingKey);

      await repositories.manualConnections.setExcluded(
        rootKey,
        pendingKey,
        true
      );

      expect(await repositories.manualConnections.list(altKey)).toMatchObject([
        { excluded: false }
      ]);
    });
  });

  it("persists historic aliases and invalidates only kill completion and scan cursors", async () => {
    await seedCompleteSnapshot(repositories);
    const alias = { region: "eu", realm: "neptulon", name: "erilla" } as const;
    const at = new Date("2026-09-20T12:00:00.000Z");
    await repositories.evidence.markTerminalTiers(
      rootKey,
      [
        { raidId: "42", domain: "kills" },
        { raidId: "42", domain: "parses" }
      ],
      at
    );
    const reservation = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: at,
      at
    });
    await repositories.evidence.publish(reservation.run.id, {
      state: "partial",
      limitationCode: "request_cap",
      parseLimitationCode: null,
      historyScanResumePage: 3,
      historyScanResumeBoundaryReportCode: "oldreport",
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: at
    });
    expect(
      (await repositories.evidence.storedEvidenceTiers(rootKey))
        .historyScanResumePage
    ).toBe(3);

    await expect(
      repositories.evidence.addHistoricAlias!(rootKey, alias)
    ).resolves.toBe("added");
    await expect(
      repositories.evidence.addHistoricAlias!(rootKey, alias)
    ).resolves.toBe("duplicate");
    await expect(
      createPostgresRepositories(pool).evidence.historicAliases!(rootKey)
    ).resolves.toEqual([alias]);
    await expect(repositories.evidence.terminalTiers(rootKey)).resolves.toEqual(
      [{ raidId: "42", domain: "parses" }]
    );
    expect(
      (await repositories.evidence.storedEvidenceTiers(rootKey))
        .historyScanResumePage
    ).toBeUndefined();

    const aliasRun = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: new Date("2026-09-20T12:01:00.000Z"),
      at: new Date("2026-09-20T12:02:00.000Z")
    });
    if (aliasRun.kind !== "reserved") throw new Error("alias_run_not_reserved");
    await repositories.evidence.publish(aliasRun.run.id, {
      state: "partial",
      limitationCode: "request_cap",
      parseLimitationCode: null,
      historicAliasProgress: [
        {
          key: alias,
          historyScanResumePage: 7,
          historyScanResumeBoundaryReportCode: "alias-boundary",
          historyComplete: false,
          parseWorkOutstanding: true
        }
      ],
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-09-20T12:03:00.000Z")
    });
    await expect(
      createPostgresRepositories(pool).evidence.storedEvidenceTiers(rootKey)
    ).resolves.toMatchObject({
      historicAliasProgress: [
        {
          key: alias,
          historyScanResumePage: 7,
          historyScanResumeBoundaryReportCode: "alias-boundary"
        }
      ]
    });

    await repositories.evidence.markTerminalTiers(
      rootKey,
      [{ raidId: "42", domain: "kills" }],
      at
    );
    await expect(
      repositories.evidence.removeHistoricAlias!(rootKey, alias)
    ).resolves.toBe("removed");
    await expect(
      repositories.evidence.removeHistoricAlias!(rootKey, alias)
    ).resolves.toBe("missing");
    await expect(
      repositories.evidence.historicAliases!(rootKey)
    ).resolves.toEqual([]);
    await expect(
      repositories.evidence.storedEvidenceTiers(rootKey)
    ).resolves.toMatchObject({ historicAliasProgress: [] });
    await expect(repositories.evidence.terminalTiers(rootKey)).resolves.toEqual(
      [{ raidId: "42", domain: "parses" }]
    );
  });

  it("persists discovered-character exclusions against the dossier root", async () => {
    await seedCompleteSnapshot(repositories);
    await expect(
      repositories.manualConnections.setDiscoveredExcluded!(
        rootKey,
        altKey,
        true
      )
    ).resolves.toBe("updated");
    await expect(
      createPostgresRepositories(pool).manualConnections
        .listDiscoveredExclusions!(rootKey)
    ).resolves.toEqual([altKey]);
    await expect(
      repositories.manualConnections.setDiscoveredExcluded!(
        rootKey,
        altKey,
        false
      )
    ).resolves.toBe("updated");
    await expect(
      repositories.manualConnections.listDiscoveredExclusions!(rootKey)
    ).resolves.toEqual([]);
  });

  it("reserves a fresh alias scan after a run that was active during the edit", async () => {
    await seedCompleteSnapshot(repositories);
    const alias = { region: "eu", realm: "neptulon", name: "former" } as const;
    const at = new Date("2026-09-20T12:00:00.000Z");
    const dueAt = new Date(Date.now() + 5_000);
    const active = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: at,
      at
    });
    expect(active.kind).toBe("reserved");
    await expect(
      repositories.evidence.addHistoricAlias!(rootKey, alias)
    ).resolves.toBe("added");
    await expect(
      repositories.evidence.listResumable(10, dueAt)
    ).resolves.toEqual([]);
    await repositories.evidence.publish(active.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: new Date()
    });
    await repositories.evidence.markTerminalTiers(
      rootKey,
      [{ raidId: "42", domain: "kills" }],
      new Date()
    );
    await expect(
      repositories.evidence.listResumable(10, dueAt)
    ).resolves.toEqual([rootKey]);
    const following = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: new Date("2020-01-01T00:00:00.000Z"),
      at: new Date()
    });
    expect(following.kind).toBe("reserved");
    expect(following.run.id).not.toBe(active.run.id);
    await expect(repositories.evidence.terminalTiers(rootKey)).resolves.toEqual(
      []
    );
    await expect(
      repositories.evidence.listResumable(10, dueAt)
    ).resolves.toEqual([]);
  });
});

async function insertApplication(pool: Pool): Promise<string> {
  await pool.query(
    "INSERT INTO applicant_source_state (source, initialized_at, last_polled_at, parser_version) VALUES ('applicant_sheet', now(), now(), 2) ON CONFLICT DO NOTHING"
  );
  const intent = await pool.query<{ sequence: string }>(
    'INSERT INTO applicant_source_intents (source, identity, observed_at) VALUES (\'applicant_sheet\', \'character:["eu","hyjal","originroot"]\', now()) RETURNING sequence'
  );
  const application = await pool.query<{ id: string }>(
    'INSERT INTO applicant_source_applications (source, root_intent_sequence, root_identity, submitted_serial) VALUES (\'applicant_sheet\', $1, \'character:["eu","hyjal","originroot"]\', 1) RETURNING id',
    [intent.rows[0]!.sequence]
  );
  return application.rows[0]!.id;
}
