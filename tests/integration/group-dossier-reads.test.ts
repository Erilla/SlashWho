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
import {
  lockGroups,
  lockRebuildExclusive
} from "../../packages/database/src/character-connections";
import { resolveSubjects } from "../../packages/application/src/dossier-subjects";
import { createSearchService } from "../../packages/application/src/search-service";
import { applicationConfigSchema } from "../../packages/application/src/config";
import { createApplicantDossierService } from "../../packages/application/src/applicant-dossier-service";

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
    await pool.query("TRUNCATE fingerprint_sweep_states CASCADE");
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
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await lockGroups(holder);
    const reservations = [
      reserve(rootKey, new Date(Date.now() + 10_000)),
      reserve(altKey, new Date(Date.now() + 10_000))
    ];
    try {
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'"
              )
            ).rows[0].n
        )
        .toBe(2);
    } finally {
      await holder.query("COMMIT");
      holder.release();
    }
    const results = await Promise.all(reservations);
    expect(results.map((r) => r.kind).sort()).toEqual(["active", "reserved"]);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM rate_limit_events"))
        .rows[0].n
    ).toBe(1);
  });

  it("does not reserve or charge after a sibling completes while its row lock waits", async () => {
    await grouped();
    await pool.query(
      "UPDATE discovery_runs SET completed_at = now() - interval '2 days' WHERE status = 'complete'"
    );
    const active = await repositories.runs.createOrReuse(altKey, "anonymous");
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query(
      "SELECT id FROM discovery_runs WHERE id = $1 FOR UPDATE",
      [active.id]
    );
    const reservation = reserve(rootKey, new Date(Date.now() - 60_000));
    try {
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT * FROM discovery_runs WHERE id =%'"
              )
            ).rows[0].n
        )
        .toBe(1);
      await holder.query(
        "UPDATE discovery_runs SET status = 'complete', completed_at = now() WHERE id = $1",
        [active.id]
      );
    } finally {
      await holder.query("COMMIT");
      holder.release();
    }
    expect(await reservation).toEqual({ kind: "fresh" });
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM rate_limit_events"))
        .rows[0].n
    ).toBe(0);
  });

  const sweepReserve = (key: CharacterKey) =>
    repositories.searchReservations.reserve({
      key,
      callerClass: "anonymous",
      callerBucketHash: `sweep:${key.name}`,
      limit: 10,
      at: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      freshnessCutoff: new Date(Date.now() + 60_000),
      ignoreFreshness: true,
      sweepDue: {
        cadenceCutoff: new Date(Date.now() - 86_400_000),
        maxFailures: 5
      }
    });

  it.each(["recent", "live", "active"] as const)(
    "refuses a sweep when a sibling has a %s sweep fact",
    async (kind) => {
      await grouped();
      if (kind === "active")
        await repositories.runs.createOrReuse(altKey, "anonymous");
      else
        await pool.query(
          `INSERT INTO fingerprint_sweep_states (region, realm_slug, normalized_name, last_published_at, resume_after)
       VALUES ($1, $2, $3, $4, $5)`,
          [
            altKey.region,
            altKey.realm,
            altKey.name,
            kind === "recent" ? new Date() : null,
            kind === "live" ? "cursor" : null
          ]
        );
      expect(await sweepReserve(rootKey)).toEqual({ kind: "not_due" });
      expect(
        (await pool.query("SELECT count(*)::int AS n FROM rate_limit_events"))
          .rows[0].n
      ).toBe(0);
    }
  );

  it("permits a sweep when a sibling's cursor has reached its abandonment threshold", async () => {
    await grouped();
    await pool.query(
      `INSERT INTO fingerprint_sweep_states (region, realm_slug, normalized_name, resume_after, continuation_failures)
       VALUES ($1, $2, $3, 'cursor', 5)`,
      [altKey.region, altKey.realm, altKey.name]
    );
    expect(await sweepReserve(rootKey)).toMatchObject({ kind: "reserved" });
  });

  it("rechecks a sweep published between the cheap check and the groups lock", async () => {
    await grouped();
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await lockGroups(holder);
    const reservation = sweepReserve(rootKey);
    try {
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'"
              )
            ).rows[0].n
        )
        .toBe(1);
      await holder.query(
        `INSERT INTO fingerprint_sweep_states (region, realm_slug, normalized_name, last_published_at) VALUES ($1, $2, $3, now())`,
        [altKey.region, altKey.realm, altKey.name]
      );
    } finally {
      await holder.query("COMMIT");
      holder.release();
    }
    expect(await reservation).toEqual({ kind: "not_due" });
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM rate_limit_events"))
        .rows[0].n
    ).toBe(0);
  });

  it("reserves only one sweep for concurrent sibling visits", async () => {
    await grouped();
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await lockGroups(holder);
    const reservations = [sweepReserve(rootKey), sweepReserve(altKey)];
    try {
      // One visitor holds the sweep lock and queues on groups; the other queues
      // on that sweep lock. Both must be blocked before the group is released.
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'"
              )
            ).rows[0].n
        )
        .toBe(2);
    } finally {
      await holder.query("COMMIT");
      holder.release();
    }
    expect(
      (await Promise.all(reservations)).map((result) => result.kind).sort()
    ).toEqual(["not_due", "reserved"]);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM rate_limit_events"))
        .rows[0].n
    ).toBe(1);
  });

  it("queues one sweep through the group-aware service for concurrent sibling visits", async () => {
    await grouped();
    const enqueued: string[] = [];
    const search = createSearchService({
      repositories,
      queue: {
        enqueue: async (job) => {
          enqueued.push(job.runId);
          return job.runId;
        }
      },
      raiderio: {
        getCharacter: async () => {
          throw new Error("provider_not_expected");
        }
      },
      config: applicationConfigSchema.parse({
        BOT_API_KEY: "bot-secret-that-is-at-least-32-characters",
        RATE_LIMIT_HASH_SECRET: "rate-secret-that-is-at-least-32-characters"
      })
    });
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await lockGroups(holder);
    const visits = [
      search.scheduleConnectedCharacterSweep!(rootKey),
      search.scheduleConnectedCharacterSweep!(altKey)
    ];
    try {
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'"
              )
            ).rows[0].n
        )
        .toBe(2);
    } finally {
      await holder.query("COMMIT");
      holder.release();
    }
    await Promise.all(visits);
    expect(enqueued).toHaveLength(1);
    expect(await repositories.runs.find(enqueued[0]!)).toMatchObject({
      status: "queued",
      queueJobId: enqueued[0]
    });
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM rate_limit_events"))
        .rows[0].n
    ).toBe(1);
  });

  it("bounds reservation and edit lock waits during a rebuild without changing durable state", async () => {
    await grouped();
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await lockRebuildExclusive(holder);
    try {
      await Promise.all([
        expect(
          reserve(rootKey, new Date(Date.now() + 60_000))
        ).rejects.toMatchObject({ code: "55P03" }),
        expect(
          repositories.manualConnections.addGroupConnection!(rootKey, third)
        ).rejects.toMatchObject({ code: "55P03" })
      ]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM rate_limit_events"))
        .rows[0].n
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM manual_dossier_connections"
        )
      ).rows[0].n
    ).toBe(0);
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

  it("a sibling provider 404 leaves the concurrent caller's queued run and charge intact", async () => {
    await grouped();
    await pool.query(
      "UPDATE discovery_runs SET completed_at = now() - interval '2 days' WHERE status = 'complete'"
    );
    let entered!: () => void;
    let failSibling!: () => void;
    const siblingEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const siblingResponse = new Promise<void>((resolve) => {
      failSibling = resolve;
    });
    const enqueued: string[] = [];
    const search = createSearchService({
      repositories,
      queue: {
        enqueue: async (job) => {
          enqueued.push(job.runId);
          return job.runId;
        }
      },
      raiderio: {
        getCharacter: async (key) => {
          if (key.name === altKey.name) {
            entered();
            await siblingResponse;
            throw Object.assign(new Error("raiderio_not_found"), {
              kind: "not_found",
              status: 404
            });
          }
          return {
            key,
            displayName: "Ryii",
            className: "Mage",
            level: 80,
            guild: null,
            ownerId: "owner",
            profileGuess: null,
            declaredMain: null
          };
        }
      },
      config: applicationConfigSchema.parse({
        BOT_API_KEY: "bot-secret-that-is-at-least-32-characters",
        RATE_LIMIT_HASH_SECRET: "rate-secret-that-is-at-least-32-characters"
      })
    });
    const sibling = search.create({
      characterUrl: `https://raider.io/characters/${altKey.region}/${altKey.realm}/${altKey.name}`,
      headers: new Headers({ "x-real-ip": "203.0.113.91" })
    });
    await siblingEntered;
    const first = await search.create({
      characterUrl: `https://raider.io/characters/${rootKey.region}/${rootKey.realm}/${rootKey.name}`,
      headers: new Headers({ "x-real-ip": "203.0.113.90" })
    });
    expect(first).toMatchObject({ kind: "job", joinedExistingRun: false });
    failSibling();
    expect(await sibling).toEqual({
      kind: "not_found",
      code: "character_not_found"
    });
    expect(enqueued).toHaveLength(1);
    expect(await repositories.runs.find(enqueued[0]!)).toMatchObject({
      status: "queued",
      rootKey,
      queueJobId: enqueued[0]
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM rate_limit_events WHERE discovery_run_id = $1",
          [enqueued[0]]
        )
      ).rows[0].n
    ).toBe(1);
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

  it("re-adding an existing manual row heals a pending group recompute", async () => {
    await publish(rootKey, [observation(rootKey, "Ryii")]);
    await publish(altKey, [observation(altKey, "Other")]);
    const ids = (
      await pool.query<{ id: string }>("SELECT id FROM characters")
    ).rows.map((row) => row.id);
    await repositories.characterConnections!.recomputeGroupsOf(ids);
    await repositories.manualConnections.add(rootKey, altKey);
    expect(
      await repositories.manualConnections.addGroupConnection!(rootKey, altKey)
    ).toBe("duplicate");
    const root = await repositories.groupReads!.read(rootKey, new Date());
    const alt = await repositories.groupReads!.read(altKey, new Date());
    expect(root!.groupId).toBe(alt!.groupId);
  });

  it("Include reports an unrelated target as missing", async () => {
    await grouped();
    expect(
      await repositories.manualConnections.setGroupExcluded!(
        rootKey,
        [third],
        false
      )
    ).toBe("missing");
  });

  it("reports manual-only merge metadata after the edit commits", async () => {
    const fourth = { ...third, name: "fourth" };
    for (const key of [rootKey, altKey, third, fourth])
      await publish(key, [observation(key, key.name)]);
    await repositories.manualConnections.add(rootKey, altKey);
    await repositories.manualConnections.add(third, fourth);
    const ids = (
      await pool.query<{ id: string }>("SELECT id FROM characters")
    ).rows.map((row) => row.id);
    await repositories.characterConnections!.recomputeGroupsOf(ids);
    const events: unknown[] = [];
    expect(
      await repositories.manualConnections.addGroupConnection!(
        rootKey,
        third,
        async (merges) => {
          const root = await repositories.groupReads!.read(rootKey, new Date());
          const other = await repositories.groupReads!.read(third, new Date());
          expect(root!.groupId).toBe(other!.groupId);
          events.push(...merges);
        }
      )
    ).toBe("added");
    expect(events).toEqual([
      { groupSizes: [2, 2], sources: [], throughObserved: false }
    ]);
  });

  async function rejectPair(a: CharacterKey, b: CharacterKey) {
    const ids = await pool.query<{ id: string }>(
      "SELECT id FROM characters WHERE (region, realm_slug, normalized_name) IN (($1, $2, $3), ($4, $5, $6)) ORDER BY id",
      [a.region, a.realm, a.name, b.region, b.realm, b.name]
    );
    await pool.query(
      `INSERT INTO character_connections (character_low_id, character_high_id, kind, rejection_id, rejected_from_character_id, observed_at)
       VALUES ($1, $2, 'rejected', gen_random_uuid(), $1, now())`,
      ids.rows.map((row) => row.id)
    );
  }

  it("refuses a manual add when any pair across the counting components was rejected", async () => {
    await grouped();
    const fourth = { ...third, name: "fourth" };
    await publish(third, [
      observation(third, "Third"),
      observation(fourth, "Fourth", "claimed")
    ]);
    await repositories.manualConnections.add(third, fourth);
    await rejectPair(altKey, fourth);
    expect(
      await repositories.manualConnections.canAddGroupConnection!(
        rootKey,
        third
      )
    ).toBe(false);
    expect(
      await repositories.manualConnections.addGroupConnection!(rootKey, third)
    ).toBe("rejected");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM manual_dossier_connections"
        )
      ).rows[0].n
    ).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM rate_limit_events"))
        .rows[0].n
    ).toBe(0);
  });

  it("rechecks rejection under the edit lock after an earlier add check allowed it", async () => {
    await grouped();
    await publish(third, [observation(third, "Third")]);
    expect(
      await repositories.manualConnections.canAddGroupConnection!(
        rootKey,
        third
      )
    ).toBe(true);
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await lockGroups(holder);
    const edit = repositories.manualConnections.addGroupConnection!(
      rootKey,
      third
    );
    try {
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'"
              )
            ).rows[0].n
        )
        .toBe(1);
      await rejectPair(altKey, third);
    } finally {
      await holder.query("COMMIT");
      holder.release();
    }
    expect(await edit).toBe("rejected");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM manual_dossier_connections"
        )
      ).rows[0].n
    ).toBe(0);
  });

  it("does not report a committed manual edit as failed when merge logging throws", async () => {
    const fourth = { ...third, name: "fourth" };
    for (const key of [rootKey, altKey, third, fourth])
      await publish(key, [observation(key, key.name)]);
    await repositories.manualConnections.add(rootKey, altKey);
    await repositories.manualConnections.add(third, fourth);
    await repositories.characterConnections!.recomputeGroupsOf(
      (await pool.query<{ id: string }>("SELECT id FROM characters")).rows.map(
        (row) => row.id
      )
    );
    let calls = 0;
    expect(
      await repositories.manualConnections.addGroupConnection!(
        rootKey,
        third,
        () => {
          calls++;
          throw new Error("logger_unavailable");
        }
      )
    ).toBe("added");
    expect(calls).toBe(1);
    const root = await repositories.groupReads!.read(rootKey, new Date());
    const other = await repositories.groupReads!.read(third, new Date());
    expect(root!.groupId).toBe(other!.groupId);
  });

  it("a suppressed opened character cannot bypass the historic-alias membership guard", async () => {
    await grouped();
    await repositories.suppressions.suppress(rootKey, "privacy", null);
    const unavailable = async (): Promise<never> => {
      throw new Error("provider_not_expected");
    };
    const dossiers = createApplicantDossierService({
      repositories,
      queue: {
        enqueueCharacterEvidence: unavailable,
        promoteCharacterEvidence: async () => undefined
      },
      search: { create: unavailable },
      blizzard: { getCompletedAchievements: unavailable },
      raiderio: {
        getCharacter: unavailable,
        getMythicBossRankings: unavailable
      },
      config: applicationConfigSchema.parse({
        BOT_API_KEY: "bot-secret-that-is-at-least-32-characters",
        RATE_LIMIT_HASH_SECRET: "rate-secret-that-is-at-least-32-characters"
      }),
      evidenceJobCredentialEncryptionKey: Buffer.alloc(32, "a")
    });
    expect(
      await dossiers.addHistoricAlias(rootKey, rootKey, {
        ...rootKey,
        name: "oldname"
      })
    ).toBe("missing");
  });

  it("keeps the opened snapshot's guild rather than an arbitrary containing snapshot", async () => {
    const guild = {
      name: "Opened guild",
      region: "eu",
      realm: "silvermoon"
    } as const;
    const otherGuild = { ...guild, name: "Other guild" };
    const runId = await publish(rootKey, [
      { ...observation(rootKey, "Ryii"), guild },
      observation(altKey, "Other", "claimed")
    ]);
    await publish(altKey, [
      observation(altKey, "Other"),
      { ...observation(rootKey, "Ryii", "claimed"), guild: otherGuild }
    ]);
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
    const group = (await repositories.groupReads!.read(rootKey, new Date()))!;
    const resolved = await resolveSubjects(
      rootKey,
      {
        ...repositories,
        groupReads: {
          read: async () => ({
            ...group,
            snapshots: [...group.snapshots].sort(
              (a, b) =>
                Number(a.rootKey.name === rootKey.name) -
                Number(b.rootKey.name === rootKey.name)
            )
          })
        }
      },
      { DOSSIER_CHARACTER_CEILING: 50 }
    );
    expect(resolved!.selected[0]!.guild).toEqual(guild);
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
    await repositories.runs.createOrReuse(altKey, "anonymous");
    await repositories.runs.createOrReuse(third, "anonymous");
    expect(await reserve(rootKey, new Date(Date.now() + 60_000))).toMatchObject(
      { kind: "reserved", run: { rootKey } }
    );
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
