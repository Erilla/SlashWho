import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  applicationConfigSchema,
  botDossierStatusOf,
  createApplicantDossierService,
  createBotDossierService
} from "../../packages/application/src";
import { runMigrations } from "../../packages/database/src";
import { startPostgres } from "./postgres";
import {
  createTestRepositories,
  type TestRepositories
} from "./test-repositories";

const root: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryii" };
const alt: CharacterKey = { region: "eu", realm: "silvermoon", name: "alt" };
const third: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "third"
};
const config = applicationConfigSchema.parse({
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32)
});

function url(key: CharacterKey): string {
  return `https://raider.io/characters/${key.region}/${key.realm}/${key.name}`;
}

async function seedSnapshot(
  repositories: TestRepositories,
  key: CharacterKey
): Promise<string> {
  const run = await repositories.runs.createOrReuse(key, "bot");
  const snapshot = await repositories.snapshots.create({
    runId: run.id,
    rootKey: key,
    state: "complete",
    limitationCode: null,
    refreshedAt: new Date("2026-10-22T09:45:52.977Z"),
    characters: [
      {
        key,
        displayName: key.name,
        className: "Mage",
        level: 80,
        guild: null,
        raiderIoUrl: url(key),
        source: "input"
      }
    ]
  });
  await repositories.runs.complete(run.id, snapshot.id);
  return snapshot.id;
}

async function seedCompletedEvidence(
  pool: Pool,
  key: CharacterKey
): Promise<void> {
  await pool.query(
    `INSERT INTO character_evidence_runs
       (region, realm_slug, normalized_name, status, completed_at, evidence_version)
     VALUES ($1, $2, $3, 'complete', now(), 2)`,
    [key.region, key.realm, key.name]
  );
}

describe("bot dossier reads", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repositories: TestRepositories;
  let bot: ReturnType<typeof createBotDossierService>;

  beforeAll(async () => {
    ({ pool, stop } = await startPostgres());
    await runMigrations(pool);
  });

  afterAll(async () => {
    await stop();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE
      character_evidence_run_phases,
      character_evidence_runs,
      snapshot_characters,
      snapshots,
      manual_dossier_connections,
      discovery_runs,
      characters,
      suppressed_characters,
      rate_limit_events
      CASCADE`);
    repositories = createTestRepositories(pool);
    const dossiers = createApplicantDossierService({
      repositories,
      search: {
        create: vi.fn(),
        scheduleConnectedCharacterSweep: vi.fn()
      },
      queue: {
        enqueueCharacterEvidence: vi.fn(),
        promoteCharacterEvidence: vi.fn()
      },
      blizzard: { getCompletedAchievements: vi.fn() },
      raiderio: { getCharacter: vi.fn(), getMythicBossRankings: vi.fn() },
      config,
      evidenceJobCredentialEncryptionKey: Buffer.alloc(32, "a")
    });
    bot = createBotDossierService({
      repositories,
      search: { create: vi.fn() },
      dossiers,
      config
    });
  });

  it("keeps collecting while a declared character has no terminal run", async () => {
    await repositories.characters.ensure({
      key: root,
      displayName: "Ryii",
      className: "Mage",
      level: 80,
      raiderIoUrl: url(root)
    });
    await seedSnapshot(repositories, root);
    await seedCompletedEvidence(pool, root);
    await repositories.manualConnections.add(root, alt, { origin: "bot" });
    await repositories.manualConnections.add(root, third, { origin: "bot" });

    const statusRead = await bot.status(root);
    if (statusRead.kind !== "ok") throw new Error("expected status");
    const status = botDossierStatusOf(statusRead);
    if (status === null) throw new Error("expected status body");
    expect(status.snapshotId).not.toBeNull();
    expect(status.state).toBe("collecting");
    expect(statusRead.evidence).toHaveLength(3);
    expect(
      statusRead.evidence.find((item) => item.key.name === alt.name)
    ).toMatchObject({
      evidenceState: "waiting",
      completedAt: null
    });

    const summary = await bot.summary(root);
    expect(summary.kind).toBe("ready");
    if (summary.kind !== "ready") throw new Error("expected summary");
    expect(summary.subjects.map((subject) => subject.key.name)).toContain(
      alt.name
    );
    const altCharacter = summary.dossier.characters.find(
      (character) => character.key.name === alt.name
    );
    expect(altCharacter).toMatchObject({
      className: null,
      guild: null,
      source: "manually_added"
    });
  });

  it("becomes ready once every declared character settles", async () => {
    await repositories.characters.ensure({
      key: root,
      displayName: "Ryii",
      className: "Mage",
      level: 80,
      raiderIoUrl: url(root)
    });
    await seedSnapshot(repositories, root);
    await seedCompletedEvidence(pool, root);
    await repositories.manualConnections.add(root, alt, { origin: "bot" });
    await repositories.manualConnections.add(root, third, { origin: "bot" });
    await seedCompletedEvidence(pool, alt);
    await seedCompletedEvidence(pool, third);

    const statusRead = await bot.status(root);
    if (statusRead.kind !== "ok") throw new Error("expected status");
    const status = botDossierStatusOf(statusRead);
    if (status === null) throw new Error("expected status body");
    const summary = await bot.summary(root);
    if (summary.kind !== "ready") throw new Error("expected summary");
    expect(status.state).toBe("ready");
    expect(summary.dossier.root).toEqual(root);
    expect(
      summary.evidence.every((item) => item.evidenceState === "complete")
    ).toBe(true);
  });

  it("omits a suppressed declared character and refuses a suppressed root", async () => {
    await repositories.characters.ensure({
      key: root,
      displayName: "Ryii",
      className: "Mage",
      level: 80,
      raiderIoUrl: url(root)
    });
    await seedSnapshot(repositories, root);
    await seedCompletedEvidence(pool, root);
    await repositories.manualConnections.add(root, alt, { origin: "bot" });
    await repositories.suppressions.suppress(alt, "removal", null);

    const status = await bot.status(root);
    if (status.kind !== "ok") throw new Error("expected status");
    expect(status.evidence.map((item) => item.key.name)).not.toContain(
      alt.name
    );
    const summary = await bot.summary(root);
    if (summary.kind !== "ready") throw new Error("expected summary");
    expect(summary.subjects.map((subject) => subject.key.name)).not.toContain(
      alt.name
    );

    await repositories.suppressions.suppress(root, "removal", null);
    expect(await bot.status(root)).toEqual({ kind: "not_found" });
    expect(await bot.summary(root)).toEqual({ kind: "not_found" });
  });

  it("does not lower a class or level the snapshot wrote", async () => {
    await repositories.characters.ensure({
      key: root,
      displayName: "Ryii",
      className: "Mage",
      level: 80,
      raiderIoUrl: url(root)
    });
    await repositories.characters.ensure({
      key: root,
      displayName: "Ryii",
      className: "Warrior",
      level: 1,
      raiderIoUrl: url(root)
    });
    const row = await pool.query<{ class_name: string; level: number }>(
      `SELECT class_name, level FROM characters
        WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
      [root.region, root.realm, root.name]
    );
    expect(row.rows[0]).toMatchObject({ class_name: "Mage", level: 80 });
  });

  it("survives a snapshot publishing after a link was written", async () => {
    await repositories.characters.ensure({
      key: root,
      displayName: "Ryii",
      className: "Mage",
      level: 80,
      raiderIoUrl: url(root)
    });
    await repositories.manualConnections.add(root, alt, { origin: "bot" });
    await seedSnapshot(repositories, root);
    const link = (await repositories.manualConnections.list(root)).find(
      (connection) => connection.key.name === alt.name
    );
    expect(link).toMatchObject({ origin: "bot", pending: true });
  });
});
