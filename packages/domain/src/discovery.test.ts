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
    guild: null,
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
  it("uses the admitted root observation without reading it again", async () => {
    // Break caught: admission could validate one root response, then let the
    // worker immediately fetch a different response or fail on a duplicate read.
    let characterCalls = 0;
    const admitted = character(altKey, { ownerId: "fixture-owner" });
    const gateway: RaiderIoGateway = {
      async getCharacter() {
        characterCalls += 1;
        throw new Error("duplicate_root_read");
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
        rootCharacter: admitted
      })
    ).resolves.toMatchObject({
      kind: "snapshot",
      state: "complete",
      characters: [expect.objectContaining({ key: altKey, source: "input" })]
    });
    expect(characterCalls).toBe(0);
  });

  it("enriches a claimed character's guild, absent from the profile payload", async () => {
    // The profile list carries no guild at all, so a claimed character's guild
    // is only knowable from its own character payload.
    const guild = { name: "Rancour", region: "eu" as const, realm: "draenor" };
    const outcome = await discoverCharacter(
      altKey,
      scriptedGateway({
        characters: [
          [altKey, character(altKey, { ownerId: "owner", guild })],
          [secondAltKey, character(secondAltKey, { guild })]
        ],
        claimed: { owner: [character(altKey), character(secondAltKey)] }
      }),
      options
    );

    expect(outcome.kind).toBe("snapshot");
    if (outcome.kind !== "snapshot") return;
    expect(
      outcome.characters.map((item) => [item.key.name, item.guild?.name])
    ).toEqual([
      ["alt", "Rancour"],
      ["second-alt", "Rancour"]
    ]);
  });

  it("leaves a guild unresolved rather than downgrading a complete snapshot", async () => {
    // Break caught: spending the last of the budget on a guild could mark an
    // otherwise complete snapshot partial. A guild is display data; the
    // discovered relationship set is unaffected by failing to read one.
    const outcome = await discoverCharacter(
      altKey,
      scriptedGateway({
        characters: [
          [
            altKey,
            character(altKey, {
              ownerId: "owner",
              guild: { name: "Rancour", region: "eu", realm: "draenor" }
            })
          ]
        ],
        claimed: { owner: [character(altKey), character(secondAltKey)] }
      }),
      { ...options, requestCap: 2 }
    );

    expect(outcome.kind).toBe("snapshot");
    if (outcome.kind !== "snapshot") return;
    expect(outcome.state).toBe("complete");
    expect(
      outcome.characters.find((item) => item.key.name === "second-alt")?.guild
    ).toBeNull();
  });

  it("keeps the snapshot when a guild lookup fails outright", async () => {
    // A guild is cosmetic. An upstream failure while reading one must not fail
    // a snapshot whose relationships were already discovered successfully.
    const gateway = scriptedGateway({
      characters: [[altKey, character(altKey, { ownerId: "owner" })]],
      claimed: { owner: [character(altKey), character(secondAltKey)] }
    });
    gateway.getCharacter = async (key) =>
      key.name === "alt"
        ? character(altKey, { ownerId: "owner" })
        : Promise.reject(
            Object.assign(new Error("transient"), { kind: "transient" })
          );

    const outcome = await discoverCharacter(altKey, gateway, options);

    expect(outcome.kind).toBe("snapshot");
    if (outcome.kind !== "snapshot") return;
    expect(outcome.characters.map((item) => item.key.name)).toEqual([
      "alt",
      "second-alt"
    ]);
  });

  it("reads a guildless root and declared main once, even when they are claimed", async () => {
    // Break caught: a directly read character whose own payload reported no
    // guild was read again in the guild pass, spending a request from the cap
    // on an answer already in hand. The owner's claim list names both again,
    // and that later observation must not reintroduce the read.
    const reads = new Map<string, number>();
    const gateway = scriptedGateway({
      characters: [
        [
          altKey,
          character(altKey, { ownerId: "owner", declaredMain: mainKey })
        ],
        [mainKey, character(mainKey, { ownerId: "owner" })]
      ],
      claimed: { owner: [character(altKey), character(mainKey)] }
    });
    const read = gateway.getCharacter;
    gateway.getCharacter = (key, signal) => {
      reads.set(key.name, (reads.get(key.name) ?? 0) + 1);
      return read(key, signal);
    };

    const outcome = await discoverCharacter(altKey, gateway, options);

    expect(outcome).toMatchObject({
      kind: "snapshot",
      state: "complete",
      characters: [
        expect.objectContaining({ key: altKey, guild: null }),
        expect.objectContaining({ key: mainKey, guild: null })
      ]
    });
    expect(Object.fromEntries(reads)).toEqual({ alt: 1, main: 1 });
  });

  describe("guild read retry", () => {
    const guild = { name: "Rancour", region: "eu" as const, realm: "draenor" };

    function upstreamFailure(failure: object): Error {
      return Object.assign(new Error("upstream"), failure);
    }

    /**
     * The root claims one alt whose guild has to be read. The root's own
     * payload names its guild, so the alt's reads are the only guild reads.
     * `guildReads` answers each read of that alt in turn; the last repeats.
     */
    function guildReadGateway(
      guildReads: readonly (RaiderIoCharacter | Error)[]
    ): { gateway: RaiderIoGateway; altReads: () => number } {
      let altReads = 0;
      const gateway = scriptedGateway({
        characters: [[altKey, character(altKey, { ownerId: "owner" })]],
        claimed: { owner: [character(altKey), character(secondAltKey)] }
      });
      gateway.getCharacter = async (key) => {
        if (key.name === "alt") {
          return character(altKey, { ownerId: "owner", guild });
        }
        const answer = guildReads[Math.min(altReads, guildReads.length - 1)]!;
        altReads += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      };
      return { gateway, altReads: () => altReads };
    }

    function guildOf(
      outcome: Awaited<ReturnType<typeof discoverCharacter>>
    ): unknown {
      if (outcome.kind !== "snapshot") throw new Error("expected_snapshot");
      return outcome.characters.find((item) => item.key.name === "second-alt")
        ?.guild;
    }

    it("recovers a timed-out guild read with one retry", async () => {
      // Break caught: a read abandoned at the client timeout is completed and
      // cached upstream, so dropping it on the first failure published a
      // snapshot without a guild Raider.IO had (run ed908d81, #656).
      const { gateway, altReads } = guildReadGateway([
        upstreamFailure({ kind: "transient" }),
        character(secondAltKey, { guild })
      ]);

      const outcome = await discoverCharacter(altKey, gateway, options);

      expect(outcome).toMatchObject({
        kind: "snapshot",
        state: "complete",
        guildReadsDropped: 0
      });
      expect(guildOf(outcome)).toEqual(guild);
      expect(altReads()).toBe(2);
    });

    it("retries a 5xx exactly once, then counts the guild as dropped", async () => {
      const { gateway, altReads } = guildReadGateway([
        upstreamFailure({ kind: "transient", status: 502 })
      ]);

      const outcome = await discoverCharacter(altKey, gateway, options);

      expect(outcome).toMatchObject({
        kind: "snapshot",
        state: "complete",
        guildReadsDropped: 1
      });
      expect(guildOf(outcome)).toBeNull();
      expect(altReads()).toBe(2);
    });

    it.each([
      ["a 429", { kind: "transient", status: 429 }],
      [
        "a 503 carrying Retry-After",
        { kind: "transient", status: 503, retryAfterMs: 30_000 }
      ],
      ["a 403", { kind: "forbidden" }],
      ["a 404", { kind: "not_found" }],
      ["schema drift", { kind: "schema_drift" }],
      ["a 401", { kind: "transient", status: 401 }]
    ])(
      "does not retry %s, and counts the guild as dropped",
      async (_, failure) => {
        // Break caught: retrying a throttled or permanent answer spends budget on
        // a read that cannot succeed, and hammers an upstream asking us to wait.
        const { gateway, altReads } = guildReadGateway([
          upstreamFailure(failure),
          character(secondAltKey, { guild })
        ]);

        const outcome = await discoverCharacter(altKey, gateway, options);

        expect(outcome).toMatchObject({
          kind: "snapshot",
          state: "complete",
          guildReadsDropped: 1
        });
        expect(guildOf(outcome)).toBeNull();
        expect(altReads()).toBe(1);
      }
    );

    it("counts a guild answer that fails validation as dropped, without retrying", async () => {
      const { gateway, altReads } = guildReadGateway([
        { key: secondAltKey } as unknown as RaiderIoCharacter,
        character(secondAltKey, { guild })
      ]);

      const outcome = await discoverCharacter(altKey, gateway, options);

      expect(outcome).toMatchObject({ guildReadsDropped: 1 });
      expect(guildOf(outcome)).toBeNull();
      expect(altReads()).toBe(1);
    });

    it("charges the retry to the request cap, and skips it when the cap is spent", async () => {
      // Break caught: an uncharged retry lets a sweep exceed the request cap it
      // was sized against. Root, claimed list and one guild read use all three.
      const { gateway, altReads } = guildReadGateway([
        upstreamFailure({ kind: "transient" }),
        character(secondAltKey, { guild })
      ]);

      const outcome = await discoverCharacter(altKey, gateway, {
        ...options,
        requestCap: 3
      });

      expect(outcome).toMatchObject({
        kind: "snapshot",
        state: "complete",
        guildReadsDropped: 1
      });
      expect(guildOf(outcome)).toBeNull();
      expect(altReads()).toBe(1);
    });

    it("counts neither a guildless answer nor a read the cap never allowed", async () => {
      // Break caught: counting these would report upstream loss that never
      // happened, and the count exists to measure exactly that loss.
      const guildless = guildReadGateway([character(secondAltKey)]);
      await expect(
        discoverCharacter(altKey, guildless.gateway, options)
      ).resolves.toMatchObject({ guildReadsDropped: 0 });

      const uncharged = guildReadGateway([
        upstreamFailure({ kind: "transient" })
      ]);
      await expect(
        discoverCharacter(altKey, uncharged.gateway, {
          ...options,
          requestCap: 2
        })
      ).resolves.toMatchObject({ state: "complete", guildReadsDropped: 0 });
      expect(uncharged.altReads()).toBe(0);
    });

    it("retries each failed read once while the reads run concurrently", async () => {
      // Break caught: guild reads run four at a time, so a retry has to hold
      // its own worker's slot and land on its own character, and the shared
      // count has to see every worker's loss exactly once.
      const alts = ["alt-a", "alt-b", "alt-c", "alt-d", "alt-e", "alt-f"].map(
        (name): CharacterKey => ({ region: "eu", realm: "silvermoon", name })
      );
      const reads = new Map<string, number>();
      const gateway = scriptedGateway({
        characters: [[altKey, character(altKey, { ownerId: "owner", guild })]],
        claimed: { owner: alts.map((key) => character(key)) }
      });
      const readRoot = gateway.getCharacter;
      gateway.getCharacter = async (key, signal) => {
        if (key.name === "alt") return readRoot(key, signal);
        const count = (reads.get(key.name) ?? 0) + 1;
        reads.set(key.name, count);
        // Yield so the workers genuinely interleave.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (key.name === "alt-c") {
          throw upstreamFailure({ kind: "forbidden" });
        }
        if (count === 1) throw upstreamFailure({ kind: "transient" });
        return character(key, {
          guild: { ...guild, name: `Guild of ${key.name}` }
        });
      };

      const outcome = await discoverCharacter(altKey, gateway, {
        ...options,
        requestCap: 50
      });

      expect(outcome).toMatchObject({
        kind: "snapshot",
        state: "complete",
        guildReadsDropped: 1
      });
      if (outcome.kind !== "snapshot") return;
      expect(
        outcome.characters.map((item) => [item.key.name, item.guild?.name])
      ).toEqual([
        ["alt", "Rancour"],
        ["alt-a", "Guild of alt-a"],
        ["alt-b", "Guild of alt-b"],
        ["alt-c", undefined],
        ["alt-d", "Guild of alt-d"],
        ["alt-e", "Guild of alt-e"],
        ["alt-f", "Guild of alt-f"]
      ]);
      expect(Object.fromEntries(reads)).toEqual({
        "alt-a": 2,
        "alt-b": 2,
        "alt-c": 1,
        "alt-d": 2,
        "alt-e": 2,
        "alt-f": 2
      });
    });

    it("never retries a read the run itself aborted", async () => {
      const controller = new AbortController();
      const { gateway, altReads } = guildReadGateway([
        upstreamFailure({ kind: "transient" })
      ]);
      const read = gateway.getCharacter;
      gateway.getCharacter = async (key, signal) => {
        if (key.name === "second-alt") controller.abort();
        return read(key, signal);
      };

      await expect(
        discoverCharacter(altKey, gateway, {
          ...options,
          signal: controller.signal
        })
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(altReads()).toBe(1);
    });
  });

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

  it("includes a known reverse-declared character without reading it upstream", async () => {
    // Break caught: a main could discard a stored reverse declared-main edge,
    // or preserving that edge could spend another upstream character request.
    const requested: CharacterKey[] = [];
    const gateway: RaiderIoGateway = {
      async getCharacter(key) {
        requested.push(key);
        return character(key, {
          guild: { name: "Rancour", region: "eu", realm: "draenor" }
        });
      },
      async getClaimedCharacters() {
        return { characters: [] };
      },
      async resolveProfileGuess() {
        return null;
      }
    };

    const outcome = await discoverCharacter(mainKey, gateway, {
      ...options,
      knownReverseDeclaredCharacters: [
        {
          key: altKey,
          displayName: "Alt",
          className: "Mage",
          level: 80,
          guild: null,
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/alt",
          source: "declared_main"
        }
      ]
    });

    expect(requested).toEqual([mainKey]);
    expect(outcome).toMatchObject({
      kind: "snapshot",
      state: "partial",
      limitationCode: "privacy_hidden"
    });
    expect(
      outcome.kind === "snapshot" &&
        outcome.characters.map((item) => [item.key, item.source, item.guild])
    ).toEqual([
      [mainKey, "input", { name: "Rancour", region: "eu", realm: "draenor" }],
      [altKey, "declared_main", null]
    ]);
  });

  it("excludes a suppressed known reverse-declared character", async () => {
    // Break caught: stored relationship evidence must not resurrect a character
    // after a removal request has suppressed that key.
    const outcome = await discoverCharacter(
      mainKey,
      scriptedGateway({
        characters: [
          [
            mainKey,
            character(mainKey, {
              guild: { name: "Rancour", region: "eu", realm: "draenor" }
            })
          ]
        ]
      }),
      {
        ...options,
        isSuppressed: async (key) => keyId(key) === keyId(altKey),
        knownReverseDeclaredCharacters: [
          {
            key: altKey,
            displayName: "Alt",
            className: "Mage",
            level: 80,
            guild: null,
            raiderIoUrl: "https://raider.io/characters/eu/silvermoon/alt",
            source: "declared_main"
          }
        ]
      }
    );

    expect(
      outcome.kind === "snapshot" && outcome.characters.map((item) => item.key)
    ).toEqual([mainKey]);
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
          guild: null,
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/alt",
          source: "input"
        }
      ],
      guildReadsDropped: 0
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

  describe("guild reads", () => {
    // Seven claimed characters the profile list returns without a guild, so
    // each needs its own read after deduplication.
    const guildless = ["a", "b", "c", "d", "e", "f", "g"].map(
      (letter): CharacterKey => ({
        region: "eu",
        realm: "draenor",
        name: `alt-${letter}`
      })
    );
    const guild = { name: "Rancour", region: "eu" as const, realm: "draenor" };

    function deferredGuildGateway() {
      const started: CharacterKey[] = [];
      const waiting: Array<{ key: CharacterKey; release: () => void }> = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const gateway: RaiderIoGateway = {
        async getCharacter(key) {
          if (key.name === "alt")
            return character(altKey, { ownerId: "owner" });
          started.push(key);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) =>
            waiting.push({ key, release: resolve })
          );
          inFlight -= 1;
          return character(key, { guild: { ...guild, name: `g-${key.name}` } });
        },
        async getClaimedCharacters() {
          return {
            characters: [
              character(altKey),
              ...guildless.map((key) => character(key))
            ]
          };
        },
        async resolveProfileGuess() {
          return null;
        }
      };
      return {
        gateway,
        started,
        waiting,
        maxInFlight: () => maxInFlight
      };
    }

    async function settle(): Promise<void> {
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    }

    it("reads at most four guilds at a time, keeping the deduplicated order", async () => {
      // Break caught: serial reads made cycle 1 wait on the sum of heavy-tailed
      // latencies; unbounded reads would overrun Raider.IO. Out-of-order
      // completion must not reorder the snapshot.
      const fake = deferredGuildGateway();
      const run = discoverCharacter(altKey, fake.gateway, options);

      await settle();
      expect(fake.started).toHaveLength(4);
      // Release newest first, so completion order is the reverse of start order.
      while (fake.waiting.length > 0) {
        fake.waiting.pop()!.release();
        await settle();
      }
      const outcome = await run;

      expect(fake.maxInFlight()).toBe(4);
      expect(fake.started.map((key) => key.name)).toEqual(
        guildless.map((key) => key.name)
      );
      expect(outcome.kind).toBe("snapshot");
      if (outcome.kind !== "snapshot") return;
      expect(outcome.state).toBe("complete");
      expect(
        outcome.characters.map((item) => [item.key.name, item.guild?.name])
      ).toEqual([
        ["alt", undefined],
        ...guildless.map((key) => [key.name, `g-${key.name}`])
      ]);
    });

    it("never spends more than the request cap on concurrent guild reads", async () => {
      // Break caught: a reservation made after an await would let four
      // workers each see the last unit of budget and overspend the cap.
      let requests = 0;
      const gateway = scriptedGateway({
        characters: [
          [altKey, character(altKey, { ownerId: "owner", guild })],
          ...guildless.map((key) => [key, character(key, { guild })] as const)
        ],
        claimed: {
          owner: [character(altKey), ...guildless.map((key) => character(key))]
        }
      });
      const counted: RaiderIoGateway = {
        getCharacter: (...args) => {
          requests += 1;
          return gateway.getCharacter(...args);
        },
        getClaimedCharacters: (...args) => {
          requests += 1;
          return gateway.getClaimedCharacters(...args);
        },
        resolveProfileGuess: (...args) => {
          requests += 1;
          return gateway.resolveProfileGuess(...args);
        }
      };

      const outcome = await discoverCharacter(altKey, counted, {
        ...options,
        requestCap: 5
      });

      expect(requests).toBe(5);
      expect(outcome.kind).toBe("snapshot");
      if (outcome.kind !== "snapshot") return;
      expect(outcome.state).toBe("complete");
      expect(
        outcome.characters
          .filter((item) => item.guild !== null)
          .map((item) => item.key.name)
      ).toEqual(["alt", "alt-a", "alt-b", "alt-c"]);
      expect(outcome.characters.map((item) => item.key.name)).toEqual([
        "alt",
        ...guildless.map((key) => key.name)
      ]);
    });

    it("costs only that character's guild when one concurrent read fails", async () => {
      // Break caught: one rejected read in a pool could fail the whole batch.
      const gateway = scriptedGateway({
        characters: [
          [altKey, character(altKey, { ownerId: "owner" })],
          ...guildless
            .filter((key) => key.name !== "alt-b")
            .map((key) => [key, character(key, { guild })] as const)
        ],
        claimed: {
          owner: [character(altKey), ...guildless.map((key) => character(key))]
        }
      });

      const outcome = await discoverCharacter(altKey, gateway, options);

      expect(outcome.kind).toBe("snapshot");
      if (outcome.kind !== "snapshot") return;
      expect(
        outcome.characters.map((item) => [item.key.name, item.guild !== null])
      ).toEqual([
        ["alt", false],
        ...guildless.map((key) => [key.name, key.name !== "alt-b"])
      ]);
    });

    it("rejects on abort and starts no guild read after it", async () => {
      // Break caught: idle workers could keep pulling reads from the queue
      // after cancellation, spending requests on a run nobody will publish.
      const controller = new AbortController();
      const fake = deferredGuildGateway();
      const run = discoverCharacter(altKey, fake.gateway, {
        ...options,
        signal: controller.signal
      });
      const settled = run.catch((error: unknown) => error);

      await settle();
      expect(fake.started).toHaveLength(4);
      controller.abort(new DOMException("drain timeout", "AbortError"));
      while (fake.waiting.length > 0) {
        fake.waiting.shift()!.release();
        await settle();
      }

      await expect(settled).resolves.toMatchObject({ name: "AbortError" });
      expect(fake.started).toHaveLength(4);
    });
  });
});
