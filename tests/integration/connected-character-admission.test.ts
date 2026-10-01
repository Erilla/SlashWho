import type {} from "../../apps/web/next-env";
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
  createApplicantDossierService,
  createSearchService,
  type ApplicantDossierService,
  type SearchService
} from "../../packages/application/src";
import {
  rootKey,
  altKey,
  observation,
  seedCompleteSnapshot,
  resetRepositoryTables,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

let searches: SearchService;
let dossiers: ApplicantDossierService;
vi.mock("../../apps/web/src/server/container", () => ({
  getContainer: async () => ({ searches, dossiers })
}));
vi.mock("../../apps/web/src/server/logger", () => ({
  webLogger: { info() {} }
}));

import {
  PATCH,
  DELETE
} from "../../apps/web/src/app/api/dossiers/[region]/[realm]/[name]/connected-characters/route";

const config = applicationConfigSchema.parse({
  BOT_API_KEY: "bot-secret-that-is-at-least-32-characters",
  RATE_LIMIT_HASH_SECRET: "rate-secret-that-is-at-least-32-characters",
  ANONYMOUS_SEARCHES_PER_HOUR: 2
});
const at = new Date("2026-10-01T12:00:00.000Z");
const target = { region: "eu", realm: "silvermoon", name: "manual" } as const;
const characterUrl = "https://raider.io/characters/eu/silvermoon/manual";
const context = { params: Promise.resolve(rootKey) };

function request(method: "PATCH" | "DELETE", url = characterUrl): Request {
  return new Request(
    "https://slashwho.example/api/dossiers/eu/silvermoon/ryii/connected-characters",
    {
      method,
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.81"
      },
      body: JSON.stringify(
        method === "PATCH"
          ? { characterUrl: url, excluded: true }
          : { characterUrl: url }
      )
    }
  );
}

describe("connected-character route admission with PostgreSQL", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repositories: TestRepositories;

  beforeAll(async () => {
    ({ pool, stop, repositories } = await startRepositoryDatabase());
  });
  beforeEach(async () => {
    await resetRepositoryTables(pool);
    await seedCompleteSnapshot(repositories, {
      characters: [observation(rootKey, "Ryii"), observation(altKey, "Other")]
    });
    await repositories.manualConnections.add(rootKey, target);
    const unavailable = async (): Promise<never> => {
      throw new Error("upstream_not_expected");
    };
    searches = createSearchService({
      repositories,
      config,
      queue: { enqueue: unavailable },
      raiderio: { getCharacter: unavailable },
      now: () => at
    });
    dossiers = createApplicantDossierService({
      repositories,
      config,
      search: searches,
      queue: { enqueueCharacterEvidence: unavailable },
      blizzard: { getCompletedAchievements: unavailable },
      raiderio: {
        getCharacter: unavailable,
        getMythicBossRankings: unavailable
      },
      evidenceJobCredentialEncryptionKey: Buffer.alloc(32, "a")
    });
  });
  afterAll(async () => {
    await stop();
  });

  it("shares PATCH and DELETE allowance across dossiers and stores only HMAC buckets", async () => {
    await repositories.manualConnections.add(altKey, target);
    expect((await PATCH(request("PATCH"), context)).status).toBe(200);
    expect(
      (await repositories.manualConnections.list(rootKey))[0]?.excluded
    ).toBe(true);
    const include = new Request(request("PATCH"), {
      body: JSON.stringify({ characterUrl, excluded: false })
    });
    expect((await PATCH(include, context)).status).toBe(200);
    expect(
      (await repositories.manualConnections.list(rootKey))[0]?.excluded
    ).toBe(false);

    for (const root of [rootKey, altKey]) {
      const response = await DELETE(request("DELETE"), {
        params: Promise.resolve(root)
      });
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("3600");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        error: { code: "rate_limited" }
      });
      expect(await repositories.manualConnections.list(root)).toMatchObject([
        { key: target, excluded: false }
      ]);
    }
    const events = await pool.query<{ caller_bucket_hash: string }>(
      "SELECT caller_bucket_hash FROM rate_limit_events"
    );
    expect(events.rows).toHaveLength(2);
    expect(new Set(events.rows.map((row) => row.caller_bucket_hash)).size).toBe(
      1
    );
    expect(events.rows[0]?.caller_bucket_hash).toMatch(
      /^connection-mutation:[a-f0-9]{64}$/
    );
    expect(JSON.stringify(events.rows)).not.toContain("203.0.113.81");
  });

  it("admits only the configured number of concurrent mutations", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => PATCH(request("PATCH"), context))
    );
    expect(
      responses.filter((response) => response.status === 200)
    ).toHaveLength(2);
    expect(
      responses.filter((response) => response.status === 429)
    ).toHaveLength(6);
    expect(await repositories.manualConnections.list(rootKey)).toMatchObject([
      { key: target, excluded: true }
    ]);
    const events = await pool.query(
      "SELECT caller_bucket_hash FROM rate_limit_events"
    );
    expect(events.rows).toHaveLength(2);
  });

  it("removes an admitted manual connection", async () => {
    expect((await DELETE(request("DELETE"), context)).status).toBe(200);
    expect(await repositories.manualConnections.list(rootKey)).toEqual([]);
    const events = await pool.query(
      "SELECT caller_bucket_hash FROM rate_limit_events"
    );
    expect(events.rows).toHaveLength(1);
  });

  it.each(["PATCH", "DELETE"] as const)(
    "charges %s schema-valid non-Raider.IO URLs before returning 400",
    async (method) => {
      const handler = method === "PATCH" ? PATCH : DELETE;
      for (let i = 0; i < 2; i++) {
        const response = await handler(
          request(
            method,
            "https://example.com/characters/eu/silvermoon/manual"
          ),
          context
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: "invalid_character_url" }
        });
      }
      expect((await handler(request(method), context)).status).toBe(429);
      expect(await repositories.manualConnections.list(rootKey)).toMatchObject([
        { key: target, excluded: false }
      ]);
    }
  );

  it.each(["PATCH", "DELETE"] as const)(
    "charges %s missing connections before returning 404",
    async (method) => {
      const handler = method === "PATCH" ? PATCH : DELETE;
      for (let i = 0; i < 2; i++) {
        const response = await handler(
          request(method, "https://raider.io/characters/eu/silvermoon/absent"),
          context
        );
        expect(response.status).toBe(404);
      }
      expect((await handler(request(method), context)).status).toBe(429);
      expect(await repositories.manualConnections.list(rootKey)).toMatchObject([
        { key: target, excluded: false }
      ]);
    }
  );

  it.each(["PATCH", "DELETE"] as const)(
    "leaves persisted connections untouched when %s reservation fails",
    async (method) => {
      const handler = method === "PATCH" ? PATCH : DELETE;
      const reservation = vi
        .spyOn(repositories.rateLimits, "reserve")
        .mockRejectedValueOnce(new Error("private-reservation-error"));
      try {
        const response = await handler(request(method), context);
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body).toMatchObject({ error: { code: "search_failed" } });
        expect(JSON.stringify(body)).not.toContain("private-reservation-error");
        expect(
          await repositories.manualConnections.list(rootKey)
        ).toMatchObject([{ key: target, excluded: false }]);
      } finally {
        reservation.mockRestore();
      }
    }
  );
});
