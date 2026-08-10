import { describe, expect, it } from "vitest";

import type { CharacterKey } from "./character-key";
import {
  discoverFingerprintMatches,
  type FingerprintCandidate,
  type FingerprintGateway
} from ".";

const root: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "root"
};

const matchingKey: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "matching"
};

function fingerprint(
  common: number,
  identical: number = common
): ReadonlyMap<number, number> {
  return new Map(
    Array.from({ length: common }, (_, id) => [id, id < identical ? 1 : 2])
  );
}

function candidate(key: CharacterKey): FingerprintCandidate {
  return {
    key,
    displayName: key.name,
    className: "Mage",
    level: 80
  };
}

function keyId(key: CharacterKey): string {
  return `${key.region}/${key.realm}/${key.name}`;
}

function gatewayFor(
  roster: readonly FingerprintCandidate[],
  fingerprints: Readonly<Record<string, ReadonlyMap<number, number>>>
): FingerprintGateway {
  return {
    async getGuildRoster() {
      return roster;
    },
    async getAchievementFingerprint(key) {
      const value = fingerprints[keyId(key)];
      if (!value)
        throw Object.assign(new Error("missing"), { kind: "not_found" });
      return value;
    }
  };
}

const options = {
  requestCap: 3,
  minimumCommon: 200,
  minimumIdenticalPercent: 20,
  isSuppressed: async (key: CharacterKey) => key.name === "a-suppressed",
  isPrivacyHidden: async (key: CharacterKey) => key.name === "b-hidden"
};

describe("discoverFingerprintMatches", () => {
  it("fetches the root once, skips suppressed, privacy-hidden, and cross-region candidates, and stops at its cap", async () => {
    // Break caught: roster order or excluded candidates could consume the sweep
    // budget, preventing an otherwise matching same-region character from being
    // admitted before the cap.
    const outcome = await discoverFingerprintMatches(
      root,
      gatewayFor(
        [
          candidate({ region: "eu", realm: "silvermoon", name: "z-last" }),
          candidate(matchingKey),
          candidate({ region: "eu", realm: "silvermoon", name: "b-hidden" }),
          candidate({
            region: "eu",
            realm: "silvermoon",
            name: "a-suppressed"
          }),
          candidate({ region: "us", realm: "area-52", name: "other-region" }),
          candidate(root)
        ],
        {
          [keyId(root)]: fingerprint(200),
          [keyId(matchingKey)]: fingerprint(200),
          "eu/silvermoon/z-last": fingerprint(200, 0)
        }
      ),
      options
    );

    expect(outcome).toEqual({
      kind: "capped",
      requestsUsed: 3,
      characters: [
        {
          key: matchingKey,
          displayName: "matching",
          className: "Mage",
          level: 80,
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/matching",
          source: "fingerprint"
        }
      ]
    });
  });

  it("enforces the non-configurable matching floors", async () => {
    // Break caught: lower caller-provided thresholds could admit a weak
    // fingerprint-derived relationship.
    const outcome = await discoverFingerprintMatches(
      root,
      gatewayFor([candidate(matchingKey)], {
        [keyId(root)]: fingerprint(199),
        [keyId(matchingKey)]: fingerprint(199)
      }),
      {
        ...options,
        requestCap: 3,
        minimumCommon: 1,
        minimumIdenticalPercent: 0,
        isSuppressed: async () => false,
        isPrivacyHidden: async () => false
      }
    );

    expect(outcome).toEqual({
      kind: "matched",
      requestsUsed: 3,
      characters: []
    });
  });

  it("does not report a cap when the roster is exhausted exactly at the budget", async () => {
    // Break caught: consuming the final allowed request could be mistaken for a
    // measured cap stop despite there being no further work to perform.
    await expect(
      discoverFingerprintMatches(
        root,
        gatewayFor(
          [candidate({ region: "us", realm: "area-52", name: "other-region" })],
          { [keyId(root)]: fingerprint(200) }
        ),
        { ...options, requestCap: 2 }
      )
    ).resolves.toEqual({
      kind: "matched",
      requestsUsed: 2,
      characters: []
    });
  });

  it("rechecks privacy immediately before admitting a matched candidate", async () => {
    // Break caught: a privacy-hidden designation that lands while the candidate
    // fingerprint is being fetched could still be retained in the result.
    let privacyChecks = 0;
    const outcome = await discoverFingerprintMatches(
      root,
      gatewayFor([candidate(matchingKey)], {
        [keyId(root)]: fingerprint(200),
        [keyId(matchingKey)]: fingerprint(200)
      }),
      {
        ...options,
        isSuppressed: async () => false,
        isPrivacyHidden: async () => {
          privacyChecks += 1;
          return privacyChecks > 1;
        }
      }
    );

    expect(outcome).toEqual({
      kind: "matched",
      requestsUsed: 3,
      characters: []
    });
  });

  it("rechecks suppression immediately before admitting a matched candidate", async () => {
    // Break caught: a removal that lands while the candidate fingerprint is
    // being fetched could still be retained in the result.
    let suppressionChecks = 0;
    const outcome = await discoverFingerprintMatches(
      root,
      gatewayFor([candidate(matchingKey)], {
        [keyId(root)]: fingerprint(200),
        [keyId(matchingKey)]: fingerprint(200)
      }),
      {
        ...options,
        isSuppressed: async () => {
          suppressionChecks += 1;
          return suppressionChecks > 1;
        },
        isPrivacyHidden: async () => false
      }
    );

    expect(outcome).toEqual({
      kind: "matched",
      requestsUsed: 3,
      characters: []
    });
  });

  it("returns a retryable failure for a 429", async () => {
    // Break caught: rate limiting could publish a partial match set instead of
    // restarting the atomic sweep through the worker retry path.
    const rateLimited = Object.assign(new Error("rate limited"), {
      kind: "transient",
      status: 429,
      retryAfterMs: 30_000
    });
    const gateway = gatewayFor([], { [keyId(root)]: fingerprint(200) });
    gateway.getAchievementFingerprint = async () => {
      throw rateLimited;
    };

    await expect(
      discoverFingerprintMatches(root, gateway, options)
    ).resolves.toEqual({
      kind: "failure",
      code: "upstream_unavailable",
      retryable: true,
      retryAfterMs: 30_000
    });
  });

  it("throws the abort reason without returning a partial result", async () => {
    // Break caught: cancellation after an upstream response could continue the
    // sweep and expose observations from an abandoned atomic run.
    const aborted = new AbortController();
    const gateway = gatewayFor([], { [keyId(root)]: fingerprint(200) });
    gateway.getGuildRoster = async () => {
      aborted.abort(new DOMException("drain timeout", "AbortError"));
      return [];
    };

    await expect(
      discoverFingerprintMatches(root, gateway, {
        ...options,
        signal: aborted.signal
      })
    ).rejects.toBe(aborted.signal.reason);
  });
});
