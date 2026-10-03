import type {
  RaiderIoLoggedEncounterInput,
  RosterProfileResolutionRepository,
  StoredRosterProfileResolution
} from "@slashwho/database";
import type {
  RosterProfileLocator,
  RosterProfileResolutionResult
} from "@slashwho/raiderio";
import { describe, expect, it, vi } from "vitest";
import { resolveRosterPresence } from "./roster-profile-presence";

const start = new Date("2026-10-01T00:00:00Z");
const key = (locator: RosterProfileLocator) =>
  `${locator.region}/${locator.realm}/${locator.name}`;
function store() {
  const rows = new Map<string, StoredRosterProfileResolution>();
  let tokenCount = 0;
  const repository: RosterProfileResolutionRepository = {
    load: async (locators) =>
      locators.flatMap((locator) =>
        rows.has(key(locator)) ? [rows.get(key(locator))!] : []
      ),
    reserve: async (locator, at) => {
      const old = rows.get(key(locator));
      if (old?.retryNotBefore && old.retryNotBefore > at) return null;
      rows.set(key(locator), {
        ...locator,
        resolvedId: old?.resolvedId ?? null,
        limitationCode: old?.limitationCode ?? null,
        answeredAt: old?.answeredAt ?? null,
        lastAttemptAt: at,
        retryNotBefore: old?.retryNotBefore ?? null
      });
      return `token-${++tokenCount}`;
    },
    answer: async (locator, _token, answer, at) => {
      const permanent =
        answer.resolvedId !== null ||
        ["private", "not_found", "schema_drift"].includes(
          answer.limitationCode ?? ""
        );
      rows.set(key(locator), {
        ...locator,
        ...answer,
        answeredAt: permanent ? at : null,
        lastAttemptAt: at,
        retryNotBefore: answer.retryNotBefore ?? null
      });
      return true;
    }
  };
  return { repository, rows };
}
function encounter(id: number, historicId = id): RaiderIoLoggedEncounterInput {
  return {
    loggedEncounterId: id,
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    pulledAt: start.toISOString(),
    defeatedAt: start.toISOString(),
    durationMs: 0,
    guild: null,
    itemLevel: { average: 1, min: 1, max: 1 },
    deathCount: 0,
    vantusCount: null,
    shareRaidUntil: null,
    rosterState: "available",
    members: [
      {
        raiderIoCharacterId: historicId,
        name: `Fixture-${historicId}`,
        realm: "nemesis",
        region: "eu",
        className: "Warlock",
        specName: "Affliction",
        role: "dps",
        itemLevel: 1
      }
    ]
  };
}
function run(
  encounters: RaiderIoLoggedEncounterInput[],
  repository: RosterProfileResolutionRepository,
  resolve: (
    locator: RosterProfileLocator
  ) => Promise<RosterProfileResolutionResult>,
  at = start
) {
  return resolveRosterPresence({
    encounters,
    repository,
    resolve,
    subjectId: 999999,
    subjectClass: "Warlock",
    signal: new AbortController().signal,
    now: () => at
  });
}

describe("historic roster presence", () => {
  it("reuses a fresh saved identity even when an older response extended its dispatch cooldown", async () => {
    const memory = store();
    const locator = {
      region: "eu",
      realm: "nemesis",
      name: "fixture-1",
      historicId: 1
    };
    memory.rows.set(key(locator), {
      ...locator,
      resolvedId: 999999,
      limitationCode: null,
      answeredAt: start,
      lastAttemptAt: start,
      retryNotBefore: new Date(start.getTime() + 3600000)
    });
    const resolve = vi.fn(async () => ({
      kind: "resolved" as const,
      characterId: 123
    }));
    const result = await run([encounter(1)], memory.repository, resolve);
    expect(result.presence.get(1)).toBe("present");
    expect(result.limitation).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
  it("makes durable progress through three ordinary runs instead of repeating the first fifty", async () => {
    const memory = store();
    const encounters = Array.from({ length: 121 }, (_, index) =>
      encounter(index + 1, 100000 + index + 1)
    );
    const resolve = vi.fn(async (locator: RosterProfileLocator) => ({
      kind: "resolved" as const,
      characterId: locator.historicId === 100121 ? 999999 : locator.historicId
    }));
    const first = await run(encounters, memory.repository, resolve);
    expect(resolve).toHaveBeenCalledTimes(50);
    expect(first.presence.get(121)).toBe("unknown");
    const second = await run(
      encounters,
      memory.repository,
      resolve,
      new Date(start.getTime() + 7 * 86400000)
    );
    expect(resolve).toHaveBeenCalledTimes(100);
    expect(second.presence.get(121)).toBe("unknown");
    const third = await run(
      encounters,
      memory.repository,
      resolve,
      new Date(start.getTime() + 14 * 86400000)
    );
    expect(resolve).toHaveBeenCalledTimes(121);
    expect(third.presence.get(121)).toBe("present");
    expect(third.limitation).toBeNull();
    expect(
      new Set(resolve.mock.calls.map(([locator]) => key(locator))).size
    ).toBe(121);
  });
  it("prioritises never-attempted locators even when earlier answers have expired", async () => {
    const memory = store();
    const encounters = Array.from({ length: 51 }, (_, index) =>
      encounter(index + 1, 100000 + index + 1)
    );
    const resolve = vi.fn(async (locator: RosterProfileLocator) => ({
      kind: "resolved" as const,
      characterId: locator.historicId === 100051 ? 999999 : locator.historicId
    }));
    await run(encounters, memory.repository, resolve);
    resolve.mockClear();
    const second = await run(
      encounters,
      memory.repository,
      resolve,
      new Date(start.getTime() + 31 * 86400000)
    );
    expect(resolve.mock.calls[0]?.[0].historicId).toBe(100051);
    expect(second.presence.get(51)).toBe("present");
    expect(resolve.mock.calls.length).toBeLessThanOrEqual(50);
  });
  it("deduplicates a locator across encounters and keeps concurrency at four", async () => {
    const memory = store();
    let active = 0;
    let peak = 0;
    const resolve = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((done) => setTimeout(done, 1));
      active--;
      return { kind: "resolved" as const, characterId: 999999 };
    });
    const result = await run(
      Array.from({ length: 15 }, (_, index) =>
        encounter(index + 1, (index % 5) + 1)
      ),
      memory.repository,
      resolve
    );
    expect(resolve).toHaveBeenCalledTimes(5);
    expect(peak).toBeLessThanOrEqual(4);
    expect(
      [...result.presence.values()].every((value) => value === "present")
    ).toBe(true);
  });
  it.each(["private", "not_found", "schema_drift"] as const)(
    "keeps %s identity unknown and remembers its refusal",
    async (code) => {
      const memory = store();
      const resolve = vi.fn(async () => ({
        kind: "limitation" as const,
        code
      }));
      expect(
        (await run([encounter(1)], memory.repository, resolve)).presence.get(1)
      ).toBe("unknown");
      const again = await run([encounter(1)], memory.repository, resolve);
      expect(again.limitation).toBe(code);
      expect(resolve).toHaveBeenCalledTimes(1);
      await run(
        [encounter(1)],
        memory.repository,
        resolve,
        new Date(start.getTime() + 31 * 86400000)
      );
      expect(resolve).toHaveBeenCalledTimes(2);
    }
  );
  it("persists Retry-After and respects it on another ordinary/manual invocation", async () => {
    const memory = store();
    const resolve = vi.fn(async () => ({
      kind: "limitation" as const,
      code: "rate_limited" as const,
      retryAfterMs: 3600000
    }));
    const first = await run([encounter(1)], memory.repository, resolve);
    expect(first.limitation).toBe("rate_limited");
    await run(
      [encounter(1)],
      memory.repository,
      resolve,
      new Date(start.getTime() + 1000)
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect([...memory.rows.values()][0]?.retryNotBefore?.getTime()).toBe(
      start.getTime() + 3600000
    );
  });
  it("advances past attempted transient failures on the next ordinary run", async () => {
    const memory = store();
    const resolve = vi.fn(async (locator: RosterProfileLocator) =>
      locator.historicId <= 4
        ? { kind: "limitation" as const, code: "unavailable" as const }
        : { kind: "resolved" as const, characterId: 999999 }
    );
    await run(
      Array.from({ length: 8 }, (_, index) => encounter(index + 1)),
      memory.repository,
      resolve
    );
    resolve.mockClear();
    const again = await run(
      Array.from({ length: 8 }, (_, index) => encounter(index + 1)),
      memory.repository,
      resolve,
      new Date(start.getTime() + 7 * 86400000)
    );
    expect(resolve.mock.calls[0]?.[0].historicId).toBe(5);
    expect(again.presence.get(5)).toBe("present");
  });
  it.each(["load", "reserve", "answer"] as const)(
    "a %s persistence failure supplies no identity proof",
    async (method) => {
      const memory = store();
      memory.repository[method] = vi.fn(async () => {
        throw new Error("database unavailable");
      });
      const result = await run([encounter(1)], memory.repository, async () => ({
        kind: "resolved",
        characterId: 999999
      }));
      expect(result.presence.get(1)).toBe("unknown");
      expect(result.limitation).toBe("unavailable");
    }
  );
  it("does not accept a different ID or a matching unsuffixed name as proof", async () => {
    const memory = store();
    const ordinary = encounter(2);
    ordinary.members = [{ ...ordinary.members[0]!, name: "Fixture" }];
    const result = await run(
      [encounter(1), ordinary],
      memory.repository,
      async () => ({ kind: "resolved", characterId: 123 })
    );
    expect([...result.presence.values()]).toEqual(["absent", "absent"]);
    expect(result.limitation).toBeNull();
  });
  it("sends no request for a malformed tombstone and keeps identity unknown", async () => {
    const memory = store();
    const invalid = encounter(1);
    invalid.members = [{ ...invalid.members[0]!, name: "Fixture-2" }];
    const resolve = vi.fn(async () => ({
      kind: "resolved" as const,
      characterId: 999999
    }));
    const result = await run([invalid], memory.repository, resolve);
    expect(resolve).not.toHaveBeenCalled();
    expect(result.presence.get(1)).toBe("unknown");
    expect(result.limitation).toBe("schema_drift");
  });
});
