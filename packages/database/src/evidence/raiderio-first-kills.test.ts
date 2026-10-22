import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { RaiderIoLoggedEncounterInput } from "../repositories";
import type { Queryable } from "../sql";
import {
  loadPublishedRaiderIoFirstKills,
  storeRaiderIoLoggedEncounters
} from "./raiderio-first-kills";

function recordingPool() {
  const writes: { statement: string; id: unknown }[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (values !== undefined) writes.push({ statement: text, id: values[0] });
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn()
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, writes };
}

// Synthetic identities throughout: this repository is public.
function encounter(loggedEncounterId: number): RaiderIoLoggedEncounterInput {
  return {
    loggedEncounterId,
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    pulledAt: "2026-07-20T17:17:29.977Z",
    defeatedAt: "2026-07-20T17:25:57.301Z",
    durationMs: 507_324,
    guild: {
      name: "Fixture Guild Alfa",
      realm: "twisting-nether",
      region: "eu"
    },
    itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
    deathCount: 2,
    vantusCount: 16,
    shareRaidUntil: null,
    rosterState: "available",
    members: [
      {
        raiderIoCharacterId: 424_242,
        name: "Alfa",
        realm: "draenor",
        region: "eu",
        className: "Demon Hunter",
        specName: "Havoc",
        role: "dps",
        itemLevel: null
      }
    ]
  };
}

/**
 * A read client for the publication path. It answers the first-kill query and
 * then the three roster queries, recording the statement order so a test can
 * prove the measured step covers exactly the roster and nothing else.
 */
function publishedRunClient(encounterState: "read" | "unavailable" = "read") {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM character_raiderio_first_kills")) {
        return {
          rows: [
            {
              raid_slug: "tier-mn-1",
              boss_slug: "midnight-falls",
              killed_at: new Date("2026-07-20T17:25:57.301Z"),
              guild_name: "Fixture Guild Alfa",
              guild_realm: "twisting-nether",
              guild_region: "eu",
              logged_encounter_id: encounterState === "read" ? "700001" : null,
              encounter_state: encounterState,
              encounter_limitation_code: null,
              historic_world_rank: null,
              historic_rank_checked_at: null,
              presence_checked: true
            }
          ],
          rowCount: 1
        };
      }
      if (text.includes("GROUP BY logged_encounter_id, role")) {
        return {
          rows: [{ logged_encounter_id: "700001", role: "dps", count: 1 }],
          rowCount: 1
        };
      }
      if (text.includes("FROM raiderio_logged_encounter_members member")) {
        return {
          rows: [
            {
              logged_encounter_id: "700001",
              raiderio_character_id: "424242",
              name: "Alfa",
              realm: "draenor",
              region: "eu",
              class_name: "Demon Hunter",
              spec_name: "Havoc",
              role: "dps",
              item_level: null
            }
          ],
          rowCount: 1
        };
      }
      if (text.includes("FROM raiderio_logged_encounters")) {
        return {
          rows: [
            {
              logged_encounter_id: "700001",
              unavailable_code: null,
              raid_slug: "tier-mn-1",
              boss_slug: "midnight-falls",
              pulled_at: new Date("2026-07-20T17:17:29.977Z"),
              defeated_at: new Date("2026-07-20T17:25:57.301Z"),
              duration_ms: 507_324,
              guild_name: "Fixture Guild Alfa",
              guild_realm: "twisting-nether",
              guild_region: "eu",
              item_level_average: 290.312,
              item_level_min: 284.938,
              item_level_max: 293.062,
              death_count: 2,
              vantus_count: 16,
              roster_state: "available",
              share_raid_until: null,
              read_at: new Date("2026-09-28T12:00:00.000Z")
            }
          ],
          rowCount: 1
        };
      }
      throw new Error(`unexpected_query:${text}`);
    }
  } as unknown as Queryable;
  return { client, queries };
}

describe("loadPublishedRaiderIoFirstKills", () => {
  it("times exactly the roster queries and leaves the result unchanged", async () => {
    const unobserved = publishedRunClient();
    const plain = await loadPublishedRaiderIoFirstKills(
      unobserved.client,
      "run-1"
    );

    const observed = publishedRunClient();
    const labels: string[] = [];
    let queriesBeforeRoster: number | undefined;
    let queriesInRoster: number | undefined;
    const measured = await loadPublishedRaiderIoFirstKills(
      observed.client,
      "run-1",
      async (label, work) => {
        labels.push(label);
        queriesBeforeRoster = observed.queries.length;
        const result = await work();
        queriesInRoster = observed.queries.length - queriesBeforeRoster;
        return result;
      }
    );

    expect(labels).toEqual(["evidence.raiderIoRoster"]);
    // The first-kill read has already happened; the measured step is exactly
    // the encounters, members and role-count reads that follow it.
    expect(queriesBeforeRoster).toBe(1);
    expect(queriesInRoster).toBe(3);
    expect(measured).toEqual(plain);
    expect(observed.queries).toEqual(unobserved.queries);
    expect(plain[0]?.encounter).toMatchObject({
      members: [{ name: "Alfa" }],
      roleCounts: { tank: 0, healer: 0, dps: 1 }
    });
  });

  it("records no roster step when no published kill names a read encounter", async () => {
    const client = publishedRunClient("unavailable");
    const labels: string[] = [];

    await loadPublishedRaiderIoFirstKills(
      client.client,
      "run-1",
      (label, work) => {
        labels.push(label);
        return work();
      }
    );

    expect(labels).toEqual([]);
    // Only the first-kill read happened; there was no roster work to time.
    expect(client.queries).toHaveLength(1);
  });
});

describe("storeRaiderIoLoggedEncounters", () => {
  it("writes every row in id order, whatever order the reads finished in", async () => {
    // Break caught: rows written in read-completion order, so two runs saving
    // overlapping encounters take their row locks in different orders and
    // PostgreSQL aborts one of them as a deadlock.
    const { pool, writes } = recordingPool();
    await storeRaiderIoLoggedEncounters(
      pool,
      {
        encounters: [encounter(700_003), encounter(700_001)],
        unavailable: [
          { loggedEncounterId: 700_004, code: "not_found" },
          { loggedEncounterId: 700_002, code: "not_found" }
        ]
      },
      new Date("2026-09-28T12:00:00.000Z")
    );
    const ids = (table: string) =>
      writes
        .filter(({ statement }) =>
          new RegExp(`^\\s*(INSERT INTO|UPDATE|DELETE FROM) ${table}\\b`).test(
            statement
          )
        )
        .map(({ id }) => id);
    expect(ids("raiderio_logged_encounters")).toEqual([
      700_001, 700_002, 700_003, 700_004
    ]);
    expect(ids("raiderio_logged_encounter_members")).toEqual([
      700_001, 700_001, 700_003, 700_003
    ]);
  });
});
