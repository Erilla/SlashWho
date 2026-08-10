import type { CharacterKey } from "./character-key";
import { describe, expect, it } from "vitest";

import {
  discoverCharacter,
  type RaiderIoCharacter,
  type RaiderIoGateway
} from "./discovery";

const altKey: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "alt"
};
const mainKey: CharacterKey = {
  region: "eu",
  realm: "tarren-mill",
  name: "main"
};
const secondAltKey: CharacterKey = {
  region: "us",
  realm: "area-52",
  name: "second-alt"
};
const thirdAltKey: CharacterKey = {
  region: "eu",
  realm: "argent-dawn",
  name: "third-alt"
};

function keyId(key: CharacterKey): string {
  return `${key.region}/${key.realm}/${key.name}`;
}

function character(
  key: CharacterKey,
  overrides: Partial<RaiderIoCharacter> = {}
): RaiderIoCharacter {
  return {
    key,
    displayName: key.name,
    className: "Mage",
    level: 80,
    ownerId: null,
    profileGuess: null,
    declaredMain: null,
    ...overrides
  };
}

type Script = {
  characters?: readonly (readonly [CharacterKey, RaiderIoCharacter])[];
  claimed?: Readonly<Record<string, readonly RaiderIoCharacter[]>>;
  profiles?: Readonly<Record<string, readonly RaiderIoCharacter[] | null>>;
};

function scriptedGateway(script: Script): RaiderIoGateway {
  const characters = new Map(
    script.characters?.map(([key, value]) => [keyId(key), value])
  );

  return {
    async getCharacter(key) {
      const value = characters.get(keyId(key));
      if (!value)
        throw Object.assign(new Error("missing"), { kind: "not_found" });
      return value;
    },
    async getClaimedCharacters(ownerId) {
      return { characters: script.claimed?.[ownerId] ?? [] };
    },
    async resolveProfileGuess(value) {
      const characters = script.profiles?.[value];
      return characters === undefined || characters === null
        ? null
        : { characters };
    }
  };
}

function throwingGateway(kind: "transient" | "schema_drift"): RaiderIoGateway {
  const fail = async () => {
    throw Object.assign(new Error(kind), { kind });
  };
  return {
    getCharacter: fail,
    getClaimedCharacters: fail,
    resolveProfileGuess: fail
  };
}

const options = {
  requestCap: 12,
  isSuppressed: async () => false
};

describe("discoverCharacter", () => {
  it("records a visible owner and its claimed characters in canonical order", async () => {
    // Break caught: owner records could omit claims or depend on upstream array order.
    const outcome = await discoverCharacter(
      altKey,
      scriptedGateway({
        characters: [[altKey, character(altKey, { ownerId: "owner" })]],
        claimed: {
          owner: [character(secondAltKey), character(thirdAltKey)]
        }
      }),
      options
    );

    expect(outcome).toMatchObject({ kind: "snapshot", state: "complete" });
    expect(
      outcome.kind === "snapshot" && outcome.characters.map((item) => item.key)
    ).toEqual([altKey, thirdAltKey, secondAltKey]);
    expect(
      outcome.kind === "snapshot" &&
        outcome.characters.map((item) => item.source)
    ).toEqual(["input", "claimed", "claimed"]);
  });

  it("pivots through a declared main once and deduplicates the result", async () => {
    // Break caught: main pivots could loop or duplicate the main in the snapshot.
    const mainCharacter = character(mainKey, {
      ownerId: "owner",
      declaredMain: altKey
    });
    const outcome = await discoverCharacter(
      altKey,
      scriptedGateway({
        characters: [
          [altKey, character(altKey, { declaredMain: mainKey })],
          [mainKey, mainCharacter]
        ],
        claimed: {
          owner: [character(altKey), mainCharacter, character(secondAltKey)]
        }
      }),
      options
    );

    expect(outcome.kind).toBe("snapshot");
    expect(
      outcome.kind === "snapshot" && outcome.characters.map((item) => item.key)
    ).toEqual([altKey, mainKey, secondAltKey]);
    expect(
      outcome.kind === "snapshot" &&
        outcome.characters.map((item) => item.source)
    ).toEqual(["input", "declared_main", "claimed"]);
  });

  it("returns a privacy-limited snapshot when hidden ownership has no valid guess", async () => {
    // Break caught: a hidden owner could be reported as a complete relationship set.
    const outcome = await discoverCharacter(
      altKey,
      scriptedGateway({
        characters: [[altKey, character(altKey, { profileGuess: "alias" })]],
        profiles: { alias: null, alt: null }
      }),
      options
    );

    expect(outcome).toMatchObject({
      kind: "snapshot",
      state: "partial",
      limitationCode: "privacy_hidden"
    });
    expect(
      outcome.kind === "snapshot" && outcome.characters.map((item) => item.key)
    ).toEqual([altKey]);
  });

  it("adds independently accepted profile guesses when ownership is hidden", async () => {
    // Break caught: accepted profile results could be discarded with their private lookup value.
    const outcome = await discoverCharacter(
      altKey,
      scriptedGateway({
        characters: [[altKey, character(altKey, { profileGuess: "alias" })]],
        profiles: {
          alias: [character(secondAltKey)],
          alt: [character(thirdAltKey)]
        }
      }),
      options
    );

    expect(outcome).toMatchObject({
      kind: "snapshot",
      state: "partial",
      limitationCode: "privacy_hidden"
    });
    expect(
      outcome.kind === "snapshot" && outcome.characters.map((item) => item.key)
    ).toEqual([altKey, thirdAltKey, secondAltKey]);
    expect(
      outcome.kind === "snapshot" &&
        outcome.characters.map((item) => item.source)
    ).toEqual(["input", "profile_guess", "profile_guess"]);
  });

  it("excludes suppressed characters from a snapshot", async () => {
    // Break caught: removed characters could reappear through a claimed list.
    const outcome = await discoverCharacter(
      altKey,
      scriptedGateway({
        characters: [[altKey, character(altKey, { ownerId: "owner" })]],
        claimed: { owner: [character(secondAltKey), character(thirdAltKey)] }
      }),
      {
        ...options,
        isSuppressed: async (key) => keyId(key) === keyId(secondAltKey)
      }
    );

    expect(
      outcome.kind === "snapshot" && outcome.characters.map((item) => item.key)
    ).toEqual([altKey, thirdAltKey]);
  });

  it("returns a request-cap-limited snapshot without making an unbounded pivot", async () => {
    // Break caught: a configured budget could be ignored during declared-main traversal.
    const outcome = await discoverCharacter(
      altKey,
      scriptedGateway({
        characters: [
          [altKey, character(altKey, { declaredMain: mainKey })],
          [mainKey, character(mainKey, { ownerId: "owner" })]
        ],
        claimed: { owner: [character(secondAltKey)] }
      }),
      { ...options, requestCap: 1 }
    );

    expect(outcome).toMatchObject({
      kind: "snapshot",
      state: "partial",
      limitationCode: "request_cap"
    });
    expect(
      outcome.kind === "snapshot" && outcome.characters.map((item) => item.key)
    ).toEqual([altKey]);
  });

  it("retains a hidden-ownership signal when the request cap wins the limitation", async () => {
    // Break caught: a cap-first outcome could erase the sole privacy signal
    // needed to prevent later fingerprint-derived links for this root.
    const outcome = await discoverCharacter(
      altKey,
      scriptedGateway({
        characters: [[altKey, character(altKey, { profileGuess: "alias" })]],
        profiles: { alias: null, alt: null }
      }),
      { ...options, requestCap: 1 }
    );

    expect(outcome).toMatchObject({
      kind: "snapshot",
      state: "partial",
      limitationCode: "request_cap",
      privacyHiddenObserved: true
    });
  });

  it("treats a non-finite request cap as an exhausted budget", async () => {
    // Break caught: an invalid cap could silently permit an unbounded crawl, or
    // publish a rootless snapshot that no read can ever anchor.
    let characterCalls = 0;
    const gateway: RaiderIoGateway = {
      async getCharacter(key) {
        characterCalls += 1;
        return character(key);
      },
      async getClaimedCharacters() {
        return { characters: [character(secondAltKey)] };
      },
      async resolveProfileGuess() {
        return null;
      }
    };

    const outcome = await discoverCharacter(altKey, gateway, {
      ...options,
      requestCap: Number.NaN
    });

    expect(characterCalls).toBe(0);
    expect(outcome).toEqual({
      kind: "failure",
      code: "upstream_unavailable",
      retryable: true
    });
  });

  it("returns a schema failure when a gateway returns a null character", async () => {
    // Break caught: an invalid character payload could be mistaken for budget exhaustion.
    const invalidGateway = {
      ...scriptedGateway({}),
      getCharacter: async () => null
    } as unknown as RaiderIoGateway;

    await expect(
      discoverCharacter(altKey, invalidGateway, options)
    ).resolves.toEqual({
      kind: "failure",
      code: "upstream_schema_changed",
      retryable: false
    });
  });

  it("returns a schema failure when a gateway returns a null claimed list", async () => {
    // Break caught: an invalid claim payload could create a trustworthy partial result.
    const invalidGateway = {
      ...scriptedGateway({
        characters: [[altKey, character(altKey, { ownerId: "owner" })]]
      }),
      getClaimedCharacters: async () => null
    } as unknown as RaiderIoGateway;

    await expect(
      discoverCharacter(altKey, invalidGateway, options)
    ).resolves.toEqual({
      kind: "failure",
      code: "upstream_schema_changed",
      retryable: false
    });
  });

  it("treats a casing-variant declared main as an already visited character", async () => {
    // Break caught: non-canonical keys could evade the declared-main cycle guard.
    const casingVariant = {
      region: "EU",
      realm: "Silvermoon",
      name: "Alt"
    } as unknown as CharacterKey;
    const gateway: RaiderIoGateway = {
      getCharacter: async () =>
        character(altKey, { declaredMain: casingVariant }),
      getClaimedCharacters: async () => ({ characters: [] }),
      resolveProfileGuess: async () => null
    };

    await expect(
      discoverCharacter(altKey, gateway, { ...options, requestCap: 3 })
    ).resolves.toEqual({
      kind: "snapshot",
      state: "partial",
      limitationCode: "privacy_hidden",
      characters: [
        {
          key: altKey,
          displayName: "alt",
          className: "Mage",
          level: 80,
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/alt",
          source: "input"
        }
      ]
    });
  });

  it("reports a partial snapshot when a claimed member cannot be represented", async () => {
    // Break caught: an out-of-scope claimed member could be silently dropped from a
    // snapshot still advertised as a complete alt list.
    const gateway: RaiderIoGateway = {
      async getCharacter() {
        return character(altKey, { ownerId: "owner" });
      },
      async getClaimedCharacters() {
        return { characters: [character(secondAltKey)], omittedMembers: true };
      },
      async resolveProfileGuess() {
        return null;
      }
    };

    const outcome = await discoverCharacter(altKey, gateway, options);

    expect(outcome).toMatchObject({
      kind: "snapshot",
      state: "partial",
      limitationCode: "unsupported_member"
    });
    expect(
      outcome.kind === "snapshot" && outcome.characters.map((item) => item.key)
    ).toEqual([altKey, secondAltKey]);
  });

  it("reports a partial snapshot when an inspected character omits a relation", async () => {
    // Break caught: an unrepresentable declared main could vanish without marking the
    // snapshot incomplete.
    const gateway: RaiderIoGateway = {
      async getCharacter() {
        return character(altKey, { ownerId: "owner", omittedMembers: true });
      },
      async getClaimedCharacters() {
        return { characters: [] };
      },
      async resolveProfileGuess() {
        return null;
      }
    };

    await expect(
      discoverCharacter(altKey, gateway, options)
    ).resolves.toMatchObject({
      state: "partial",
      limitationCode: "unsupported_member"
    });
  });

  it("fails definitively when the input character is suppressed after reservation", async () => {
    // Break caught: suppression landing after reservation could publish a rootless
    // snapshot that no read can ever serve.
    let characterCalls = 0;
    const gateway: RaiderIoGateway = {
      async getCharacter() {
        characterCalls += 1;
        return character(altKey);
      },
      async getClaimedCharacters() {
        return { characters: [] };
      },
      async resolveProfileGuess() {
        return null;
      }
    };

    await expect(
      discoverCharacter(altKey, gateway, {
        ...options,
        isSuppressed: async (key) => keyId(key) === keyId(altKey)
      })
    ).resolves.toEqual({
      kind: "failure",
      code: "character_not_found",
      retryable: false
    });
    expect(characterCalls).toBe(0);
  });

  it("refuses to publish a snapshot whose root observation is absent", async () => {
    // Break caught: an upstream key that diverges from the requested key could produce
    // a snapshot the repository can never anchor to its root.
    const gateway: RaiderIoGateway = {
      async getCharacter() {
        return character(mainKey);
      },
      async getClaimedCharacters() {
        return { characters: [] };
      },
      async resolveProfileGuess() {
        return null;
      }
    };

    await expect(discoverCharacter(altKey, gateway, options)).resolves.toEqual({
      kind: "failure",
      code: "character_not_found",
      retryable: false
    });
  });

  it("returns a definitive absence when the input character is missing", async () => {
    // Break caught: a missing input could create an empty snapshot.
    const outcome = await discoverCharacter(
      altKey,
      scriptedGateway({}),
      options
    );

    expect(outcome).toEqual({
      kind: "failure",
      code: "character_not_found",
      retryable: false
    });
  });

  it.each([
    ["transient", "upstream_unavailable", true],
    ["schema_drift", "upstream_schema_changed", false]
  ] as const)(
    "returns failure rather than a partial snapshot on %s failure",
    async (kind, code, retryable) => {
      // Break caught: upstream failures could be mistaken for bounded partial results.
      const outcome = await discoverCharacter(
        altKey,
        throwingGateway(kind),
        options
      );

      expect(outcome).toEqual({ kind: "failure", code, retryable });
    }
  );

  it("preserves an upstream retry delay on transient failure", async () => {
    // Break caught: the worker could retry before a longer upstream Retry-After.
    const fail = async () => {
      throw Object.assign(new Error("transient"), {
        kind: "transient",
        retryAfterMs: 30_000
      });
    };

    await expect(
      discoverCharacter(
        altKey,
        {
          getCharacter: fail,
          getClaimedCharacters: fail,
          resolveProfileGuess: fail
        },
        options
      )
    ).resolves.toEqual({
      kind: "failure",
      code: "upstream_unavailable",
      retryable: true,
      retryAfterMs: 30_000
    });
  });

  it("propagates cancellation and stops at the next discovery checkpoint", async () => {
    // Break caught: an aborted delivery could continue traversal and later publish.
    const controller = new AbortController();
    let claimedCalls = 0;
    const gateway = {
      async getCharacter(_key: CharacterKey, signal?: AbortSignal) {
        expect(signal).toBe(controller.signal);
        controller.abort(new DOMException("drain timeout", "AbortError"));
        return character(altKey, { ownerId: "owner" });
      },
      async getClaimedCharacters() {
        claimedCalls += 1;
        return { characters: [] };
      },
      async resolveProfileGuess() {
        return null;
      }
    };

    await expect(
      discoverCharacter(altKey, gateway, {
        ...options,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(claimedCalls).toBe(0);
  });
});
