import { afterEach, describe, expect, it } from "vitest";

import { createBlizzardClient } from "./index";
import {
  createFingerprintParserPool,
  fingerprintFromBytes,
  type FingerprintParserPool
} from "./fingerprint-parser";
import { fixtureResponse } from "./test-fixtures";

const encode = (value: unknown): ArrayBuffer => {
  const bytes = new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value)
  );
  return bytes.buffer.slice(0);
};

// Break caught: a thread that reads an entry differently from the calling
// thread would change which characters match, and only under load.
const bodies: Record<string, unknown> = {
  "valid entries": {
    achievements: [
      { id: 1, completed_timestamp: 1_700_000_000_000 },
      { id: 2, completed_timestamp: 0 },
      { id: 3, completed_timestamp: -5 }
    ]
  },
  "entries missing a field or of the wrong type": {
    achievements: [
      { id: 1, completed_timestamp: 10 },
      { id: 2 },
      { completed_timestamp: 5 },
      { id: "3", completed_timestamp: 5 },
      { id: 4, completed_timestamp: null },
      null,
      7,
      [],
      { id: 5, completed_timestamp: 6 }
    ]
  },
  "a repeated id keeps the last": {
    achievements: [
      { id: 1, completed_timestamp: 10 },
      { id: 1, completed_timestamp: 20 }
    ]
  },
  "an empty list": { achievements: [] },
  "no achievements key": { other: [] },
  "achievements that is not a list": { achievements: {} },
  "a list at the top": [],
  "a scalar": 4,
  "a JSON null": null,
  "malformed JSON": "{ not json",
  "empty body": ""
};

describe("fingerprint parser pool", () => {
  let pool: FingerprintParserPool | undefined;
  afterEach(async () => {
    await pool?.close();
    pool = undefined;
  });

  it.each(Object.entries(bodies))(
    "reads %s exactly as the calling thread does",
    async (_name, body) => {
      pool = createFingerprintParserPool(2);
      await expect(pool.parse(encode(body))).resolves.toEqual(
        fingerprintFromBytes(encode(body))
      );
    }
  );

  it("keeps an available numeric zero distinct from a missing entry", async () => {
    pool = createFingerprintParserPool(1);
    const parsed = await pool.parse(
      encode({ achievements: [{ id: 2, completed_timestamp: 0 }] })
    );
    expect(parsed?.get(2)).toBe(0);
    expect(parsed?.has(3)).toBe(false);
  });

  it("answers many concurrent parses each with its own body", async () => {
    pool = createFingerprintParserPool(3);
    const parses = Array.from({ length: 40 }, (_, index) =>
      pool!.parse(
        encode({
          achievements: [{ id: index, completed_timestamp: index * 2 }]
        })
      )
    );
    const results = await Promise.all(parses);
    results.forEach((result, index) =>
      expect(result).toEqual(new Map([[index, index * 2]]))
    );
  });

  it("parses on the calling thread once closed", async () => {
    pool = createFingerprintParserPool(1);
    await pool.close();
    await expect(
      pool.parse(encode({ achievements: [{ id: 1, completed_timestamp: 2 }] }))
    ).resolves.toEqual(new Map([[1, 2]]));
  });

  it("gives a client the same fingerprint through the pool as without it", async () => {
    // Break caught: the pooled client path reading the body or the failure
    // classes differently from the default path.
    pool = createFingerprintParserPool(2);
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "sentinel"
    } as const;
    const make = (fingerprintParser?: typeof pool) =>
      createBlizzardClient({
        fetch: async (input: RequestInfo | URL) =>
          String(input).endsWith("/token")
            ? fixtureResponse("token-valid")
            : fixtureResponse("achievements-empty"),
        clientId: "id",
        clientSecret: "secret",
        baseUrl: "http://127.0.0.1:43101",
        ...(fingerprintParser ? { fingerprintParser } : {})
      });
    await expect(make(pool).getAchievementFingerprint(key)).resolves.toEqual(
      await make().getAchievementFingerprint(key)
    );

    const drifted = createBlizzardClient({
      fetch: async (input: RequestInfo | URL) =>
        String(input).endsWith("/token")
          ? fixtureResponse("token-valid")
          : new Response("{ not json"),
      clientId: "id",
      clientSecret: "secret",
      baseUrl: "http://127.0.0.1:43101",
      fingerprintParser: pool
    });
    await expect(drifted.getAchievementFingerprint(key)).rejects.toMatchObject({
      kind: "schema_drift"
    });
  });
});
