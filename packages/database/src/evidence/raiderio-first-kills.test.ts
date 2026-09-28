import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { RaiderIoLoggedEncounterInput } from "../repositories";
import { storeRaiderIoLoggedEncounters } from "./raiderio-first-kills";

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
