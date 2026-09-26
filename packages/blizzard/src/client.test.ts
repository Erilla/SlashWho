import type { CharacterKey } from "@slashwho/domain";
import { describe, expect, it, vi } from "vitest";

import { createBlizzardClient } from "./index";
import {
  fixtureResponse,
  readFixture,
  type FixtureName
} from "./test-fixtures";

type Endpoint = "token" | "profile" | "classIndex" | "roster" | "achievements";

function endpointOf(url: URL): Endpoint {
  if (url.hostname === "oauth.battle.net" || url.pathname === "/token")
    return "token";
  if (url.pathname === "/data/wow/playable-class/index") return "classIndex";
  if (url.pathname.startsWith("/data/wow/guild/")) return "roster";
  if (url.pathname.endsWith("/achievements")) return "achievements";
  if (url.pathname.startsWith("/profile/wow/character/")) return "profile";
  throw new Error(`unexpected endpoint: ${url.pathname}`);
}

type Route = FixtureName | ((url: URL) => FixtureName | Response);
type Routes = Partial<Record<Endpoint, Route>>;

/** Answers each endpoint from its routed fixture; the token defaults to valid. */
function fixtureResponder(routes: Routes): (url: URL) => Response {
  return (url) => {
    const endpoint = endpointOf(url);
    const route =
      routes[endpoint] ?? (endpoint === "token" ? "token-valid" : undefined);
    if (route === undefined) throw new Error(`unrouted endpoint: ${endpoint}`);
    const answer = typeof route === "function" ? route(url) : route;
    return typeof answer === "string" ? fixtureResponse(answer) : answer;
  };
}

const key: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "sentinel"
};

const aGuild = { name: "A Guild", region: "eu", realm: "silvermoon" } as const;

function clientFor(
  responder: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  options: {
    onThrottle?(event: { retryAfterMs: number | undefined }): void;
  } = {}
) {
  const fetchSpy = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      responder(
        new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        ),
        init
      )
  );
  return {
    fetchSpy,
    gateway: createBlizzardClient({
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "secret",
      ...options
    })
  };
}

function fixtureClient(
  routes: Routes,
  options: Parameters<typeof clientFor>[1] = {}
) {
  return clientFor(fixtureResponder(routes), options);
}

const guildedRoster: Routes = {
  profile: "profile-guild",
  classIndex: "playable-class-index",
  roster: "guild-roster"
};

const alt = {
  key: { region: "eu", realm: "silvermoon", name: "alt" },
  displayName: "Alt",
  className: "Mage",
  level: 80,
  guild: aGuild
};

const keeper = {
  key: { region: "eu", realm: "silvermoon", name: "keeper" },
  displayName: "Keeper",
  className: "Paladin",
  level: 70,
  guild: aGuild
};

describe("Blizzard gateway", () => {
  it("shares OAuth refresh across concurrent character reads", async () => {
    let tokens = 0;
    const { gateway } = fixtureClient({
      token: () => {
        tokens++;
        return "token-valid";
      },
      achievements: "achievements-empty"
    });
    await Promise.all([
      gateway.getCompletedAchievements(key),
      gateway.getCompletedAchievements({ ...key, name: "alt" })
    ]);
    expect(tokens).toBe(1);
    expect(await gateway.getCompletedAchievements(key)).toEqual([]);
    expect(tokens).toBe(1);
  });
  it("uses an explicitly configured endpoint for local integration fixtures", async () => {
    // Break caught: e2e sweeps could send test credentials to the public
    // Blizzard endpoints even when the test suite provides a local fixture.
    const endpoints: string[] = [];
    const respond = fixtureResponder({ achievements: "achievements-empty" });
    const gateway = createBlizzardClient({
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        endpoints.push(url.toString());
        return respond(url);
      }) as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "secret",
      baseUrl: "http://127.0.0.1:43101"
    });

    await expect(gateway.getAchievementFingerprint(key)).resolves.toEqual(
      new Map()
    );
    expect(endpoints).toEqual([
      "http://127.0.0.1:43101/token",
      "http://127.0.0.1:43101/profile/wow/character/silvermoon/sentinel/achievements?namespace=profile-eu&locale=en_GB"
    ]);
  });

  it("uses the root region profile API and normalizes the current guild roster", async () => {
    // Break caught: roster requests could cross regions or leak upstream member
    // shapes into discovery snapshots.
    const { gateway } = fixtureClient({
      profile: (url) => {
        expect(url.pathname).toBe("/profile/wow/character/silvermoon/sentinel");
        return "profile-guild";
      },
      classIndex: "playable-class-index",
      roster: (url) => {
        expect(url.pathname).toBe("/data/wow/guild/silvermoon/a-guild/roster");
        return "guild-roster";
      }
    });

    const onProfileRequest = vi.fn();
    await expect(
      gateway.getGuildRoster(key, undefined, onProfileRequest)
    ).resolves.toEqual([alt, keeper]);
    expect(onProfileRequest).toHaveBeenCalledTimes(3);
  });

  it("keeps normalized playable-class names isolated by region and accounts for each initial read", async () => {
    const usKey: CharacterKey = { ...key, region: "us", realm: "illidan" };
    const classIndexReads: string[] = [];
    const { gateway } = fixtureClient({
      ...guildedRoster,
      classIndex: (url) => {
        const namespace = url.searchParams.get("namespace") ?? "";
        classIndexReads.push(namespace);
        return namespace === "static-eu"
          ? "playable-class-index"
          : "playable-class-index-renamed";
      }
    });
    const observed = vi.fn();

    await expect(
      gateway.getGuildRoster(key, undefined, observed)
    ).resolves.toMatchObject([{ className: "Mage" }, { className: "Paladin" }]);
    await expect(
      gateway.getGuildRoster(usKey, undefined, observed)
    ).resolves.toMatchObject([
      { className: "Magus" },
      { className: "Paladin" }
    ]);
    await gateway.getGuildRoster(key, undefined, observed);

    expect(classIndexReads).toEqual(["static-eu", "static-us"]);
    // Profile, static class index, roster; then the other region; then the
    // warm EU profile and roster. The first static read in each region counts.
    expect(observed).toHaveBeenCalledTimes(8);
  });

  it("refreshes a region's static class names after the patch-bounded lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00.000Z"));
    let classIndexReads = 0;
    const { gateway } = fixtureClient({
      ...guildedRoster,
      classIndex: () =>
        ++classIndexReads === 1
          ? "playable-class-index"
          : "playable-class-index-renamed"
    });

    await expect(gateway.getGuildRoster(key)).resolves.toMatchObject([
      { className: "Mage" },
      { className: "Paladin" }
    ]);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    await expect(gateway.getGuildRoster(key)).resolves.toMatchObject([
      { className: "Magus" },
      { className: "Paladin" }
    ]);

    expect(classIndexReads).toBe(2);
    vi.useRealTimers();
  });

  it.each([
    ["an empty character name", "guild-roster-member-empty-name"],
    ["an empty realm slug", "guild-roster-member-empty-realm-slug"],
    ["no playable_class object", "guild-roster-member-without-playable-class"]
  ] as const)(
    "skips a roster member with %s instead of failing the sweep",
    async (_description, roster) => {
      // Break caught: one member the key space cannot represent made every
      // member null, which raised schema_drift and abandoned the whole sweep.
      const { gateway } = fixtureClient({ ...guildedRoster, roster });

      await expect(gateway.getGuildRoster(key)).resolves.toEqual([keeper]);
    }
  );

  it("skips a roster member whose class the static index names with an empty string", async () => {
    const { gateway } = fixtureClient({
      ...guildedRoster,
      classIndex: "playable-class-index-empty-name"
    });

    await expect(gateway.getGuildRoster(key)).resolves.toEqual([keeper]);
  });

  it("reports a roster without a members array as schema drift", async () => {
    const { gateway } = fixtureClient({
      ...guildedRoster,
      roster: "guild-roster-without-members"
    });

    await expect(gateway.getGuildRoster(key)).rejects.toMatchObject({
      kind: "schema_drift"
    });
  });

  it("names the guild each roster member was read from", async () => {
    // The roster is fetched for one guild, so every member is in it. The guild
    // is already read to build the roster URL; carrying it costs no request.
    const { gateway } = fixtureClient({
      ...guildedRoster,
      // A guild need not sit on its members' realm.
      profile: "profile-guild-other-realm",
      roster: (url) => {
        expect(url.pathname).toBe("/data/wow/guild/draenor/rancour/roster");
        return "guild-roster";
      }
    });

    const roster = await gateway.getGuildRoster(key);

    expect(roster[0]?.guild).toEqual({
      name: "Rancour",
      region: "eu",
      realm: "draenor"
    });
  });

  it("reads a known historical guild directly without first resolving a member profile", async () => {
    // Historical WCL observations already carry a guild identity. Requiring a
    // current member profile would make an old or departed guild undiscoverable.
    const rancour = {
      name: "Rancour",
      region: "eu",
      realm: "draenor"
    } as const;
    const { gateway } = fixtureClient({
      classIndex: "playable-class-index",
      roster: (url) => {
        expect(url.pathname).toBe("/data/wow/guild/draenor/rancour/roster");
        return "guild-roster";
      }
    });

    await expect(gateway.getGuildRosterByIdentity(rancour)).resolves.toEqual([
      { ...alt, guild: rancour },
      { ...keeper, guild: rancour }
    ]);
  });

  it("returns an empty roster when the root has no guild", async () => {
    const { fetchSpy, gateway } = fixtureClient({
      profile: "profile-without-guild"
    });

    await expect(gateway.getGuildRoster(key)).resolves.toEqual([]);
    // Token and profile only: no class index or roster read for no guild.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an empty guild name", "profile-guild-empty-name"],
    ["an empty guild realm slug", "profile-guild-empty-realm-slug"]
  ] as const)(
    "reports a root profile with %s as schema drift",
    async (_description, profile) => {
      const { fetchSpy, gateway } = fixtureClient({ profile });

      await expect(gateway.getGuildRoster(key)).rejects.toMatchObject({
        kind: "schema_drift"
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    }
  );

  it("extracts only numeric achievement pairs and caches the process token", async () => {
    // Break caught: malformed achievement entries could reach comparison, or a
    // token request could be made per character.
    const { fetchSpy, gateway } = fixtureClient({
      achievements: "achievements-non-numeric-pairs"
    });

    await expect(gateway.getAchievementFingerprint(key)).resolves.toEqual(
      new Map([[1, 100]])
    );
    await expect(gateway.getAchievementFingerprint(key)).resolves.toEqual(
      new Map([[1, 100]])
    );
    expect(
      fetchSpy.mock.calls.filter(
        ([input]) => new URL(String(input)).hostname === "oauth.battle.net"
      )
    ).toHaveLength(1);
  });

  it("returns completed achievements from timestamps without consulting criteria", async () => {
    const { gateway } = fixtureClient({
      achievements: "achievements-completed"
    });

    await expect(gateway.getCompletedAchievements(key)).resolves.toEqual([
      {
        achievementId: "40254",
        completedAt: "2025-01-18T20:30:00.000Z"
      }
    ]);
  });

  it("keeps completed achievements when other achievements are unfinished", async () => {
    const { gateway } = fixtureClient({
      achievements: "achievements-with-unfinished"
    });

    await expect(gateway.getCompletedAchievements(key)).resolves.toEqual([
      {
        achievementId: "40254",
        completedAt: "2025-01-18T20:30:00.000Z"
      }
    ]);
  });

  it("reports schema drift when any completed achievement row is malformed", async () => {
    const { gateway } = fixtureClient({
      achievements: "achievements-malformed-timestamp"
    });

    await expect(gateway.getCompletedAchievements(key)).rejects.toMatchObject({
      kind: "schema_drift"
    });
  });

  it.each([
    ["zero achievement ID", { id: 0 }],
    ["negative achievement ID", { id: -1 }],
    ["zero completion timestamp", { completed_timestamp: 0 }],
    ["negative completion timestamp", { completed_timestamp: -1 }],
    ["fractional completion timestamp", { completed_timestamp: 1.5 }]
  ])("reports schema drift for a %s", async (_description, override) => {
    // A value variant of the recorded-shape entry: no field is added.
    const completed = readFixture("achievements-completed").body as {
      achievements: Record<string, unknown>[];
    };
    const { gateway } = fixtureClient({
      achievements: () =>
        Response.json({
          achievements: [{ ...completed.achievements[0], ...override }]
        })
    });

    await expect(gateway.getCompletedAchievements(key)).rejects.toMatchObject({
      kind: "schema_drift"
    });
  });

  it.each(["getAchievementFingerprint", "getCompletedAchievements"] as const)(
    "reports an achievements payload without an achievements array as schema drift from %s",
    async (method) => {
      const { gateway } = fixtureClient({
        achievements: "achievements-without-achievements"
      });

      await expect(gateway[method](key)).rejects.toMatchObject({
        kind: "schema_drift"
      });
    }
  );

  it("reports a token response with an empty access token as schema drift", async () => {
    const { gateway } = fixtureClient({
      token: "token-empty-access-token",
      achievements: "achievements-empty"
    });

    await expect(gateway.getAchievementFingerprint(key)).rejects.toMatchObject({
      kind: "schema_drift"
    });
  });

  describe("403 responses are currently classified as transient", () => {
    // Pinned, not endorsed: a 403 is retried as if Blizzard were down, the
    // same class of fault as #36 on the Raider.IO side. Changing it must be a
    // deliberate decision that updates these tests.
    it.each(["getAchievementFingerprint", "getCompletedAchievements"] as const)(
      "from the token endpoint via %s",
      async (method) => {
        const { gateway } = fixtureClient({
          token: "token-forbidden",
          achievements: "achievements-empty"
        });

        await expect(gateway[method](key)).rejects.toMatchObject({
          kind: "transient",
          status: 403
        });
      }
    );

    it.each(["getAchievementFingerprint", "getCompletedAchievements"] as const)(
      "from character achievements via %s",
      async (method) => {
        const { gateway } = fixtureClient({
          achievements: "achievements-forbidden"
        });

        await expect(gateway[method](key)).rejects.toMatchObject({
          kind: "transient",
          status: 403
        });
      }
    );

    it.each([
      ["the character profile", { profile: "profile-forbidden" }],
      [
        "the playable-class index",
        { classIndex: "playable-class-index-forbidden" }
      ],
      ["the guild roster", { roster: "guild-roster-forbidden" }]
    ] as const)("from %s", async (_description, override) => {
      const { gateway } = fixtureClient({ ...guildedRoster, ...override });

      await expect(gateway.getGuildRoster(key)).rejects.toMatchObject({
        kind: "transient",
        status: 403
      });
    });
  });

  describe("a 404 partway through a roster sweep", () => {
    it("fails only the missing member's achievements read", async () => {
      // Break caught: one member's 404 poisoning the shared token or the
      // siblings' reads, as #32 did on the Raider.IO side.
      const { fetchSpy, gateway } = fixtureClient({
        ...guildedRoster,
        achievements: (url) =>
          url.pathname.includes("/character/silvermoon/alt/")
            ? "achievements-missing"
            : "achievements-completed"
      });

      const members = await gateway.getGuildRoster(key);
      const reads = await Promise.allSettled(
        members.map((member) => gateway.getAchievementFingerprint(member.key))
      );

      expect(reads).toEqual([
        {
          status: "rejected",
          reason: expect.objectContaining({ kind: "not_found" })
        },
        {
          status: "fulfilled",
          value: new Map([[40254, 1_737_232_200_000]])
        }
      ]);
      expect(
        fetchSpy.mock.calls.filter(
          ([input]) => new URL(String(input)).hostname === "oauth.battle.net"
        )
      ).toHaveLength(1);
    });

    it("fails only the missing member's profile read", async () => {
      const { gateway } = fixtureClient({
        ...guildedRoster,
        profile: (url) =>
          url.pathname.endsWith("/character/silvermoon/alt")
            ? "profile-missing"
            : "profile-guild"
      });

      const members = await gateway.getGuildRoster(key);
      const reads = await Promise.allSettled(
        members.map((member) => gateway.getGuildRoster(member.key))
      );

      expect(reads).toEqual([
        {
          status: "rejected",
          reason: expect.objectContaining({ kind: "not_found" })
        },
        { status: "fulfilled", value: [alt, keeper] }
      ]);
    });

    it("classifies a missing guild roster as not found", async () => {
      const { gateway } = fixtureClient({
        classIndex: "playable-class-index",
        roster: "guild-roster-missing"
      });

      await expect(
        gateway.getGuildRosterByIdentity(aGuild)
      ).rejects.toMatchObject({ kind: "not_found" });
    });
  });

  it("reports a token endpoint that never responds as a transient failure", async () => {
    // Break caught: the token request's own timeout escaped as a raw
    // TimeoutError, which callers switching on BlizzardError.kind mishandle.
    const tokenDeadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(tokenDeadline.signal);
    try {
      const { gateway } = clientFor((url, init) => {
        if (url.hostname !== "oauth.battle.net")
          return fixtureResponse("achievements-empty");
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason)
          );
          tokenDeadline.abort(
            new DOMException("Token deadline", "TimeoutError")
          );
        });
      });

      await expect(gateway.getAchievementFingerprint(key)).rejects.toEqual(
        expect.objectContaining({ kind: "transient" })
      );
    } finally {
      timeout.mockRestore();
    }
  });

  it("passes the abort signal and never includes an upstream body in its error", async () => {
    // Break caught: cancellation could be omitted, or an upstream error body
    // could enter a typed failure and be logged later.
    const controller = new AbortController();
    const { fetchSpy, gateway } = fixtureClient({
      achievements: () =>
        fixtureResponse("achievements-rate-limited", {
          bodyText: "upstream-private-body-marker"
        })
    });

    const request = gateway.getAchievementFingerprint(key, controller.signal);
    await expect(request).rejects.toMatchObject({
      kind: "transient",
      retryAfterMs: 60_000
    });
    await expect(request).rejects.not.toThrow(/upstream-private-body-marker/);
    expect(
      JSON.stringify(await request.catch((error: unknown) => error))
    ).not.toContain("upstream-private-body-marker");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("classifies missing Blizzard resources without exposing their body", async () => {
    const { gateway } = fixtureClient({
      achievements: () =>
        fixtureResponse("achievements-missing", {
          bodyText: "missing-private-body-marker"
        })
    });

    const request = gateway.getAchievementFingerprint(key);
    await expect(request).rejects.toMatchObject({ kind: "not_found" });
    await expect(request).rejects.not.toThrow(/missing-private-body-marker/);
  });

  it("reports a throttled response through onThrottle", async () => {
    const throttles: Array<{ retryAfterMs: number | undefined }> = [];
    const { gateway } = fixtureClient(
      { achievements: "achievements-rate-limited" },
      { onThrottle: (event) => throttles.push(event) }
    );

    await gateway
      .getCompletedAchievements(key, AbortSignal.timeout(1_000))
      .catch(() => undefined);

    expect(throttles).toEqual([{ retryAfterMs: 60_000 }]);
  });

  it("keeps a throwing onThrottle from changing the thrown failure", async () => {
    // Break caught: an unguarded reporting callback could replace BlizzardError
    // with whatever the logger threw, turning a genuine rate limit into an
    // unrecognisable failure. A reporting callback must never be able to change
    // what the client returns.
    const { gateway } = fixtureClient(
      { achievements: "achievements-rate-limited" },
      {
        onThrottle: () => {
          throw new Error("logger-exploded-marker");
        }
      }
    );

    const request = gateway.getCompletedAchievements(
      key,
      AbortSignal.timeout(1_000)
    );
    await expect(request).rejects.toMatchObject({
      kind: "transient",
      status: 429,
      retryAfterMs: 60_000
    });
    await expect(request).rejects.not.toThrow(/logger-exploded-marker/);
  });

  it("does not require onThrottle", async () => {
    const { gateway } = fixtureClient({
      achievements: "achievements-rate-limited-no-retry-after"
    });

    await expect(
      gateway.getCompletedAchievements(key, AbortSignal.timeout(1_000))
    ).rejects.toMatchObject({ kind: "transient", status: 429 });
  });

  it("rejects regions outside the supported same-region profile boundary", async () => {
    // Break caught: a forged key could send fingerprint data to the unsupported
    // China API rather than keeping every request in the domain's region set.
    const { fetchSpy, gateway } = fixtureClient({});
    const unsupportedKey = { ...key, region: "cn" } as unknown as CharacterKey;

    await expect(
      gateway.getAchievementFingerprint(unsupportedKey)
    ).rejects.toThrow("invalid_character_key");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
