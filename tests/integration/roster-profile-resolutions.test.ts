import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createRosterProfileResolutionRepository,
  type RosterProfileResolutionRepository
} from "../../packages/database/src/roster-profile-resolutions";
import { startRepositoryDatabase } from "./repository-fixtures";

const locator = {
  region: "eu",
  realm: "draenor",
  name: "alfa-424242",
  historicId: 424242
};
const at = new Date("2026-10-03T12:00:00Z");
const later = (milliseconds: number) => new Date(at.getTime() + milliseconds);
const day = 24 * 60 * 60 * 1000;

describe("durable historic roster profile resolutions", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repository: RosterProfileResolutionRepository;

  beforeAll(async () => {
    ({ pool, stop } = await startRepositoryDatabase());
    repository = createRosterProfileResolutionRepository(pool);
  });
  afterAll(async () => {
    await stop?.();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE raiderio_roster_profile_resolutions");
  });

  it("shares parsed answers across repository instances and prevents overlapping dispatch", async () => {
    expect(await repository.load([locator])).toEqual([]);
    const otherSubject = createRosterProfileResolutionRepository(pool);
    const tokens = await Promise.all([
      repository.reserve(locator, at),
      otherSubject.reserve(locator, at)
    ]);
    expect(tokens.filter(Boolean)).toHaveLength(1);
    const token = tokens.find((value) => value !== null)!;
    expect(
      await repository.answer(
        locator,
        token,
        { resolvedId: 987654, limitationCode: null },
        later(1000)
      )
    ).toBe(true);
    expect(await otherSubject.load([locator, locator])).toEqual([
      {
        ...locator,
        resolvedId: 987654,
        limitationCode: null,
        answeredAt: later(1000),
        lastAttemptAt: at,
        retryNotBefore: null
      }
    ]);
    expect(await otherSubject.reserve(locator, later(day))).toBeNull();
    expect(
      await otherSubject.reserve(locator, later(30 * day + 1001))
    ).not.toBeNull();
  });

  it("retains attempt progress and Retry-After without caching a transient answer", async () => {
    const token = (await repository.reserve(locator, at))!;
    const retryNotBefore = later(2 * day);
    await repository.answer(
      locator,
      token,
      { resolvedId: null, limitationCode: "rate_limited", retryNotBefore },
      later(1000)
    );
    const restarted = createRosterProfileResolutionRepository(pool);
    expect((await restarted.load([locator]))[0]).toEqual({
      ...locator,
      resolvedId: null,
      limitationCode: "rate_limited",
      answeredAt: null,
      lastAttemptAt: at,
      retryNotBefore
    });
    expect(await restarted.reserve(locator, later(day))).toBeNull();
    expect(await restarted.reserve(locator, retryNotBefore)).not.toBeNull();
  });

  it.each(["not_found", "private", "schema_drift"])(
    "caches classified %s refusals for 30 days",
    async (limitationCode) => {
      const token = (await repository.reserve(locator, at))!;
      expect(
        await repository.answer(
          locator,
          token,
          { resolvedId: null, limitationCode },
          at
        )
      ).toBe(true);
      expect((await repository.load([locator]))[0]?.answeredAt).toEqual(at);
      expect(await repository.reserve(locator, later(29 * day))).toBeNull();
      expect(await repository.reserve(locator, later(30 * day))).not.toBeNull();
    }
  );

  it("rejects expired attempt answers while retaining the maximum cooldown and newer lease", async () => {
    const oldToken = (await repository.reserve(locator, at))!;
    const newToken = (await repository.reserve(locator, later(6 * 60 * 1000)))!;
    expect(newToken).not.toBe(oldToken);
    expect(
      await repository.answer(
        locator,
        oldToken,
        {
          resolvedId: 100,
          limitationCode: null,
          retryNotBefore: later(3 * day)
        },
        later(7 * 60 * 1000)
      )
    ).toBe(false);
    expect(
      await repository.answer(
        locator,
        newToken,
        { resolvedId: 200, limitationCode: null, retryNotBefore: later(day) },
        later(8 * 60 * 1000)
      )
    ).toBe(true);
    expect(
      await repository.answer(
        locator,
        oldToken,
        {
          resolvedId: 300,
          limitationCode: null,
          retryNotBefore: later(4 * day)
        },
        later(9 * 60 * 1000)
      )
    ).toBe(false);
    expect((await repository.load([locator]))[0]).toMatchObject({
      resolvedId: 200,
      retryNotBefore: later(4 * day),
      lastAttemptAt: later(6 * 60 * 1000)
    });
  });

  it("releases a finished lease and never moves attempt time backwards", async () => {
    const token = (await repository.reserve(locator, at))!;
    await repository.answer(
      locator,
      token,
      { resolvedId: null, limitationCode: "unavailable" },
      at
    );
    expect(await repository.reserve(locator, later(-1))).toBeNull();
    expect(await repository.reserve(locator, later(1))).not.toBeNull();
  });

  it.each([
    { ...locator, historicId: 0 },
    { ...locator, historicId: Number.MAX_SAFE_INTEGER + 1 },
    { ...locator, name: "alfa-999" },
    { ...locator, name: "alfa" },
    { ...locator, region: "cn" },
    { ...locator, realm: "../draenor" },
    { ...locator, name: "Alfa-424242" }
  ])(
    "rejects invalid locators before persisting an attempt: %j",
    async (invalid) => {
      await expect(repository.reserve(invalid, at)).rejects.toThrow(
        "invalid_roster_profile_locator"
      );
      expect(await repository.load([locator])).toEqual([]);
    }
  );

  it("rejects unsafe resolved IDs and ambiguous answer shapes", async () => {
    const token = (await repository.reserve(locator, at))!;
    for (const resolvedId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        repository.answer(
          locator,
          token,
          { resolvedId, limitationCode: null },
          at
        )
      ).rejects.toThrow("invalid_roster_profile_answer");
    }
    await expect(
      repository.answer(
        locator,
        token,
        { resolvedId: 100, limitationCode: "private" },
        at
      )
    ).rejects.toThrow("invalid_roster_profile_answer");
    await expect(
      repository.answer(
        locator,
        token,
        { resolvedId: null, limitationCode: null },
        at
      )
    ).rejects.toThrow("invalid_roster_profile_answer");
  });

  it("isolates resolver versions and historic locators", async () => {
    const token = (await repository.reserve(locator, at))!;
    await repository.answer(
      locator,
      token,
      { resolvedId: 987654, limitationCode: null },
      at
    );
    await pool.query(
      "UPDATE raiderio_roster_profile_resolutions SET resolver_version = 0"
    );
    expect(await repository.load([locator])).toEqual([]);
    expect(await repository.reserve(locator, at)).not.toBeNull();
    expect(
      await repository.load([{ ...locator, realm: "silvermoon" }])
    ).toEqual([]);
  });
});
