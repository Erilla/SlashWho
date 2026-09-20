import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CharacterKey } from "@slashwho/domain";
import { describe, expect, it, vi } from "vitest";

import { createRaiderIoClient } from "./index";
import recordedRankings from "./fixtures/queen-ansurek-rankings.json";

type FixtureName =
  | "character-visible-owner"
  | "character-private-owner"
  | "character-empty-discord"
  | "character-declared-main"
  | "character-declared-main-out-of-scope"
  | "character-renamed-root"
  | "character-guild"
  | "character-guild-null"
  | "character-guild-unsupported-region"
  | "profile-valid"
  | "profile-invalid"
  | "profile-forbidden"
  | "claimed-characters"
  | "claimed-characters-out-of-scope"
  | "missing-character"
  | "rate-limited"
  | "server-error"
  | "schema-drift"
  | "raid-progress-valid"
  | "raid-progress-rate-limited"
  | "raid-progress-schema-drift";

type Fixture = {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
};

const fixtureDirectory = fileURLToPath(
  new URL("../../../tests/fixtures/raiderio/", import.meta.url)
);

function fixtureFetch(name: FixtureName): typeof globalThis.fetch {
  const fixture = JSON.parse(
    readFileSync(resolve(fixtureDirectory, `${name}.json`), "utf8")
  ) as Fixture;

  return async (input) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    const expectsProfile =
      name === "profile-valid" ||
      name === "profile-invalid" ||
      name === "profile-forbidden" ||
      name === "claimed-characters" ||
      name === "claimed-characters-out-of-scope";
    const expectsRaidProgress = name.startsWith("raid-progress-");
    const expectedPath = expectsProfile
      ? "/api/user/view-characters"
      : expectsRaidProgress
        ? "/api/characters/eu/silvermoon/sentinel/raid-progress"
        : "/api/characters/eu/silvermoon/sentinel";

    if (url.pathname !== expectedPath) {
      throw new Error(`unexpected fixture path: ${url.pathname}`);
    }

    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: {
        "Content-Type": "application/json",
        ...fixture.headers
      }
    });
  };
}

function raidProgressFixtureFetch(): typeof globalThis.fetch {
  const fixture = JSON.parse(
    readFileSync(resolve(fixtureDirectory, "raid-progress-valid.json"), "utf8")
  ) as Fixture & { duplicateTierBody: unknown };

  return async (input) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    if (
      url.pathname !== "/api/characters/eu/silvermoon/sentinel/raid-progress"
    ) {
      throw new Error(`unexpected fixture path: ${url.pathname}`);
    }
    const body =
      url.searchParams.get("tier") === "31"
        ? fixture.duplicateTierBody
        : fixture.body;
    return new Response(JSON.stringify(body), {
      status: fixture.status,
      headers: { "Content-Type": "application/json", ...fixture.headers }
    });
  };
}

const sentinel: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "sentinel"
};

function clientFor(name: FixtureName) {
  return createRaiderIoClient({
    fetch: fixtureFetch(name),
    baseUrl: "https://fixtures.invalid",
    timeoutMs: 50
  });
}

describe("Raider.IO gateway", () => {
  it("attaches the configured access key only to official API requests", async () => {
    // Break caught: Raider.IO rejects access_key on the undocumented endpoints
    // that back its website, so attaching it indiscriminately makes every
    // discovery fail even though the same key is valid on /api/v1/*.
    const requestedUrls: URL[] = [];
    const fetchMock: typeof globalThis.fetch = async (input) => {
      requestedUrls.push(
        new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        )
      );
      return Response.json({});
    };
    const client = createRaiderIoClient({
      fetch: fetchMock,
      baseUrl: "https://raider.io",
      timeoutMs: 5_000,
      accessKey: "test-access-key"
    });

    await client.getCharacter(sentinel).catch(() => undefined);
    await client.getClaimedCharacters("Foo").catch(() => undefined);
    await client.resolveProfileGuess("Foo").catch(() => undefined);
    await client.getHistoricMythicKills(sentinel, { tierOrdinals: [30] });
    await client.getMythicBossRankings({
      raidSlug: "nerubar-palace",
      bossSlug: "queen-ansurek"
    });
    await client.getMythicBossRankings({
      raidSlug: "nerubar-palace",
      bossSlug: "queen-ansurek",
      guild: {
        region: "eu",
        realm: "tarren-mill",
        name: "Echo"
      }
    });

    expect(
      requestedUrls.map((url) => [
        url.pathname,
        url.searchParams.get("access_key")
      ])
    ).toEqual([
      ["/api/characters/eu/silvermoon/sentinel", null],
      ["/api/user/view-characters", null],
      ["/api/user/view-characters", null],
      ["/api/characters/eu/silvermoon/sentinel/raid-progress", null],
      ["/api/v1/raiding/boss-rankings", "test-access-key"],
      ["/api/guilds/raid-rankings", null],
      ["/api/v1/guilds/profile", "test-access-key"]
    ]);
  });

  it("sends no access_key parameter when no key is configured", async () => {
    // Break caught: an absent key could be forwarded as an empty access_key,
    // which is not the anonymous request Raider.IO expects — and anonymous
    // access has to keep working for local dev and contributors without a key.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          viewUserCharactersApi: {
            name: "Foo",
            characters: []
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );
    const client = createRaiderIoClient({
      fetch: fetchMock,
      baseUrl: "https://raider.io",
      timeoutMs: 5_000
    });

    await client.getClaimedCharacters("Foo");

    const requestedUrl = new URL(
      (fetchMock.mock.calls[0]![0] as URL).toString()
    );
    expect(requestedUrl.searchParams.has("access_key")).toBe(false);
  });

  it("normalizes a character and exposes its visible owner", async () => {
    await expect(
      clientFor("character-visible-owner").getCharacter(sentinel)
    ).resolves.toEqual({
      key: { region: "eu", realm: "silvermoon", name: "sentinel" },
      displayName: "Sentinel",
      className: "Mage",
      level: 80,
      ownerId: "owner-alpha",
      profileGuess: "public-alias",
      declaredMain: null,
      guild: null
    });
  });

  it("identifies itself on every request, because Raider.IO blocks what does not", async () => {
    // Break caught: #356. Cloudflare refuses an agent-less request with
    // "Error 1010: Access denied" -- a 403 the client reads as an ordinary
    // lookup failure, so discovery burned its whole retry chain in 16 seconds
    // and failed terminally. One dossier had been stuck since 2026-09-15 on
    // this, and a `raiderio / unavailable` limitation sitting on a character
    // all week turned out to be the same cause.
    //
    // The lesson had already been learned once, in
    // scripts/generate-raid-current-content-windows.mts, and never applied to
    // the client that actually runs. Asserted here so it cannot be lost again.
    const sent: Array<Record<string, string>> = [];
    const client = createRaiderIoClient({
      fetch: async (input, init) => {
        sent.push(Object.fromEntries(new Headers(init?.headers)));
        return fixtureFetch("character-guild")(input, init);
      },
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });

    await client.getCharacter(sentinel);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.["user-agent"]).toMatch(/SlashWho/);
  });

  it("normalizes a character's guild, which need not share its realm", async () => {
    const character = await clientFor("character-guild").getCharacter(sentinel);

    expect(character.guild).toEqual({
      name: "Rancour",
      region: "eu",
      realm: "draenor"
    });
  });

  it("represents an explicitly guildless character as null", async () => {
    const character = await clientFor("character-guild-null").getCharacter(
      sentinel
    );

    expect(character.guild).toBeNull();
  });

  it("treats a guild outside the key space as absent, not as schema drift", async () => {
    // A guild on an unsupported region cannot be canonicalized. Rejecting it
    // would raise non-retryable schema_drift and permanently fail the search,
    // so the character is kept and only its guild is dropped.
    const character = await clientFor(
      "character-guild-unsupported-region"
    ).getCharacter(sentinel);

    expect(character.guild).toBeNull();
    expect(character.displayName).toBe("Sentinel");
  });

  it("combines delivery cancellation with the request timeout", async () => {
    // Break caught: shutdown cancellation could be ignored until the HTTP timeout.
    const controller = new AbortController();
    const baseFetch = fixtureFetch("character-visible-owner");
    const fetch: typeof globalThis.fetch = async (input, init) => {
      await new Promise<void>((resolveDelay, reject) => {
        const timer = setTimeout(resolveDelay, 10);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          },
          { once: true }
        );
      });
      return baseFetch(input, init);
    };
    const client = createRaiderIoClient({
      fetch,
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 1_000
    });

    const request = client.getCharacter(sentinel, controller.signal);
    controller.abort(new DOMException("drain timeout", "AbortError"));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("preserves delivery cancellation while reading the response body", async () => {
    // Break caught: body-read cancellation could be mislabeled as schema drift.
    const controller = new AbortController();
    let bodyStarted!: () => void;
    const readingBody = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const bodyFetch: typeof globalThis.fetch = async (_input, init) =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise((_resolve, reject) => {
            bodyStarted();
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true }
            );
          })
      }) as Response;
    const client = createRaiderIoClient({
      fetch: bodyFetch,
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 1_000
    });
    const request = client.getCharacter(sentinel, controller.signal);
    await readingBody;
    controller.abort(new DOMException("drain timeout", "AbortError"));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("represents a privacy-hidden owner without inventing an identity", async () => {
    const character = await clientFor("character-private-owner").getCharacter(
      sentinel
    );

    expect(character.ownerId).toBeNull();
    expect(character.profileGuess).toBe("profile-candidate");
  });

  it("treats an empty customization field as absent, not as schema drift", async () => {
    // Break caught: Raider.IO sends "" for a customization a player never set.
    // Rejecting it raised non-retryable schema_drift, so every character with an
    // empty Discord field failed its search permanently.
    const character = await clientFor("character-empty-discord").getCharacter(
      sentinel
    );

    expect(character.profileGuess).toBeNull();
  });

  it("extracts and normalizes a declared-main character key", async () => {
    const character = await clientFor("character-declared-main").getCharacter(
      sentinel
    );

    expect(character.declaredMain).toEqual({
      region: "eu",
      realm: "tarren-mill",
      name: "mainkeeper"
    });
  });

  it("normalizes every character claimed by a visible owner", async () => {
    await expect(
      clientFor("claimed-characters").getClaimedCharacters("owner-alpha")
    ).resolves.toEqual({
      characters: [
        {
          key: { region: "eu", realm: "silvermoon", name: "firstalt" },
          displayName: "Firstalt",
          className: "Paladin",
          level: 80,
          ownerId: null,
          profileGuess: null,
          declaredMain: null,
          guild: null
        },
        {
          key: { region: "us", realm: "area-52", name: "secondalt" },
          displayName: "Secondalt",
          className: "Shaman",
          level: 76,
          ownerId: null,
          profileGuess: null,
          declaredMain: null,
          guild: null
        }
      ]
    });
  });

  it("skips claimed members outside the supported key space and flags the omission", async () => {
    // Break caught: one out-of-scope claimed character could turn every search for
    // that player into a permanent schema-drift failure.
    const profile = await clientFor(
      "claimed-characters-out-of-scope"
    ).getClaimedCharacters("owner-alpha");

    expect(profile.characters.map((item) => item.key)).toEqual([
      { region: "eu", realm: "silvermoon", name: "firstalt" },
      { region: "eu", realm: "silvermoon", name: "fledgling" }
    ]);
    expect(profile.omittedMembers).toBe(true);
  });

  it("preserves an upstream level of zero rather than rejecting the member", async () => {
    // Break caught: the accepted upstream range could diverge from the public schema
    // and commit an immutable snapshot no read can parse.
    const profile = await clientFor(
      "claimed-characters-out-of-scope"
    ).getClaimedCharacters("owner-alpha");

    expect(profile.characters.at(-1)?.level).toBe(0);
  });

  it("keeps the requested key when upstream reports a different realm or name", async () => {
    // Break caught: a realm alias or rename could produce a snapshot whose root row
    // never matches the requested key, rolling back every attempt.
    const character = await clientFor("character-renamed-root").getCharacter(
      sentinel
    );

    expect(character.key).toEqual(sentinel);
    expect(character.displayName).toBe("Sentinelle");
  });

  it("drops an out-of-scope declared main and flags the omission", async () => {
    // Break caught: an unsupported declared main could fail the whole search instead
    // of yielding a knowingly partial result.
    const character = await clientFor(
      "character-declared-main-out-of-scope"
    ).getCharacter(sentinel);

    expect(character.declaredMain).toBeNull();
    expect(character.omittedMembers).toBe(true);
  });

  it("accepts a profile guess only when the response independently names it", async () => {
    const profile =
      await clientFor("profile-valid").resolveProfileGuess("sensitive-value");

    expect(profile).toEqual({
      characters: [
        {
          key: { region: "eu", realm: "twisting-nether", name: "profilealt" },
          displayName: "Profilealt",
          className: "Priest",
          level: 78,
          ownerId: null,
          profileGuess: null,
          declaredMain: null,
          guild: null
        }
      ]
    });
    expect(JSON.stringify(profile)).not.toContain("sensitive-value");
  });

  it("rejects characters returned for a different profile", async () => {
    await expect(
      clientFor("profile-invalid").resolveProfileGuess("sensitive-value")
    ).resolves.toBeNull();
  });

  it("treats a private user profile as no profile, not an outage", async () => {
    // Break caught: Raider.IO answers 403 profile_is_private for a guessed user
    // name. Classifying that as transient retried a permanent answer and failed
    // the whole run as upstream_unavailable.
    await expect(
      clientFor("profile-forbidden").resolveProfileGuess("private-user")
    ).resolves.toBeNull();
  });

  it("classifies a missing character", async () => {
    await expect(
      clientFor("missing-character").getCharacter(sentinel)
    ).rejects.toMatchObject({
      kind: "not_found"
    });
  });

  it("classifies a 429 as retryable and preserves Retry-After", async () => {
    await expect(
      clientFor("rate-limited").getCharacter(sentinel)
    ).rejects.toMatchObject({
      kind: "transient",
      status: 429,
      retryAfterMs: 30_000
    });
  });

  it("reports a throttled response through onThrottle", async () => {
    const throttles: Array<{ retryAfterMs: number | undefined }> = [];
    const client = createRaiderIoClient({
      fetch: async () =>
        new Response("", { status: 429, headers: { "Retry-After": "5" } }),
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50,
      onThrottle: (event) => throttles.push(event)
    });

    await client.getCharacter(sentinel).catch(() => undefined);

    expect(throttles).toEqual([{ retryAfterMs: 5_000 }]);
  });

  it("keeps a throwing onThrottle from changing the thrown failure", async () => {
    // Break caught: an unguarded reporting callback could replace RaiderIoError
    // with whatever the logger threw, degrading a rate_limited limitation into
    // an unavailable upstream.
    const client = createRaiderIoClient({
      fetch: async () =>
        new Response("", { status: 429, headers: { "Retry-After": "5" } }),
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50,
      onThrottle: () => {
        throw new Error("logger-exploded-marker");
      }
    });

    const request = client.getCharacter(sentinel);
    await expect(request).rejects.toMatchObject({
      kind: "transient",
      status: 429,
      retryAfterMs: 5_000
    });
    await expect(request).rejects.not.toThrow(/logger-exploded-marker/);
  });

  it("does not report a private profile as throttling", async () => {
    // The 403 response carries Retry-After so the only thing preventing
    // onThrottle from firing is the 403 early-return running ahead of the
    // throttle check, not the absence of a header.
    const throttles: unknown[] = [];
    const client = createRaiderIoClient({
      fetch: async () =>
        new Response("", { status: 403, headers: { "Retry-After": "5" } }),
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50,
      onThrottle: () => throttles.push(true)
    });

    await client.getCharacter(sentinel).catch(() => undefined);

    expect(throttles).toEqual([]);
  });

  it("classifies a server error without exposing its body", async () => {
    const promise = clientFor("server-error").getCharacter(sentinel);

    await expect(promise).rejects.toMatchObject({
      kind: "transient",
      status: 503
    });
    await expect(promise).rejects.not.toThrow(/server-private-body-marker/);
  });

  it("classifies an unexpected success payload as schema drift", async () => {
    await expect(
      clientFor("schema-drift").getCharacter(sentinel)
    ).rejects.toMatchObject({
      kind: "schema_drift"
    });
  });

  it("replaces a tagged transport error without preserving its sensitive data", async () => {
    const marker = "private-transport-identity";
    const transportError = Object.assign(new Error(marker), {
      kind: "transient" as const,
      identity: marker
    });
    const taggedErrorFetch: typeof globalThis.fetch = async () => {
      throw transportError;
    };
    const client = createRaiderIoClient({
      fetch: taggedErrorFetch,
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });

    let failure: unknown;
    try {
      await client.resolveProfileGuess(marker);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ kind: "transient" });
    expect(failure).not.toBe(transportError);
    expect(failure).not.toHaveProperty("identity");
    expect((failure as Error).message).not.toContain(marker);
    expect(JSON.stringify(failure)).not.toContain(marker);
  });

  it("classifies a timeout as transient without exposing the request", async () => {
    const timeoutFetch: typeof globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          {
            once: true
          }
        );
      });
    const client = createRaiderIoClient({
      fetch: timeoutFetch,
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 1
    });

    await expect(
      client.resolveProfileGuess("private-timeout-value")
    ).rejects.toMatchObject({
      kind: "transient"
    });
    await expect(
      client.resolveProfileGuess("private-timeout-value")
    ).rejects.not.toThrow(/private-timeout-value/);
  });

  it("normalizes historic Mythic kills without retaining an upstream payload", async () => {
    // Break caught: a changed normalizer could turn dated, attributed Mythic
    // kills into anonymous raid-progress data or leak an upstream envelope.
    const client = createRaiderIoClient({
      fetch: fixtureFetch("raid-progress-valid"),
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });

    await expect(
      client.getHistoricMythicKills(sentinel, { tierOrdinals: [30] })
    ).resolves.toEqual({
      kind: "evidence",
      kills: [
        {
          raidId: "nerub-ar-palace",
          raidName: "Nerub-ar Palace",
          bossId: "queen-ansurek",
          bossName: "Queen Ansurek",
          bossOrder: 8,
          isFinalBoss: true,
          firstDefeated: "2025-02-04T17:59:00.000Z",
          guild: { name: "Example Guild", realm: "silvermoon" },
          historicWorldRank: 147
        },
        {
          raidId: "nerub-ar-palace",
          raidName: "Nerub-ar Palace",
          bossId: "the-silken-court",
          bossName: "The Silken Court",
          bossOrder: 7,
          isFinalBoss: false,
          firstDefeated: "2025-01-29T20:00:00.000Z",
          guild: null,
          historicWorldRank: null
        }
      ]
    });
  });

  it("keeps the earliest duplicate Mythic kill returned by overlapping tiers", async () => {
    // Break caught: overlapping tier responses could duplicate Queen Ansurek or
    // replace the first public kill with a later kill.
    const client = createRaiderIoClient({
      fetch: raidProgressFixtureFetch(),
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });

    const result = await client.getHistoricMythicKills(sentinel, {
      tierOrdinals: [30, 31]
    });

    expect(result).toEqual({
      kind: "evidence",
      kills: [
        expect.objectContaining({
          bossId: "queen-ansurek",
          firstDefeated: "2025-02-04T17:59:00.000Z"
        }),
        expect.objectContaining({ bossId: "the-silken-court" })
      ]
    });
  });

  it("returns a rate-limit limitation with Retry-After timing", async () => {
    await expect(
      clientFor("raid-progress-rate-limited").getHistoricMythicKills(sentinel, {
        tierOrdinals: [30]
      })
    ).resolves.toEqual({
      kind: "limitation",
      code: "rate_limited",
      retryAfterMs: 30_000
    });
  });

  it("stops at the historic-kill request cap before making another request", async () => {
    // Break caught: an exhausted evidence budget could still make an upstream
    // request, defeating the cap that protects the undocumented endpoint.
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const client = createRaiderIoClient({
      fetch,
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });

    await expect(
      client.getHistoricMythicKills(sentinel, {
        tierOrdinals: [30, 31],
        requestCap: 1
      })
    ).resolves.toEqual({ kind: "limitation", code: "request_cap" });
    expect(calls).toBe(0);
  });

  it("returns schema_drift for a malformed historic-kill payload", async () => {
    await expect(
      clientFor("raid-progress-schema-drift").getHistoricMythicKills(sentinel, {
        tierOrdinals: [30]
      })
    ).resolves.toEqual({ kind: "limitation", code: "schema_drift" });
  });

  it("preserves delivery cancellation while gathering historic Mythic kills", async () => {
    // Break caught: caller cancellation could be converted into a claim that
    // Raider.IO evidence was merely unavailable.
    const controller = new AbortController();
    let started!: () => void;
    const waitingForFetch = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch: typeof globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        started();
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          {
            once: true
          }
        );
      });
    const client = createRaiderIoClient({
      fetch,
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 1_000
    });

    const request = client.getHistoricMythicKills(sentinel, {
      tierOrdinals: [30],
      signal: controller.signal
    });
    await waitingForFetch;
    controller.abort(new DOMException("drain timeout", "AbortError"));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("normalizes published Mythic boss rankings without an unbounded gateway cache", async () => {
    // Break caught: callers could receive an unvalidated upstream leaderboard,
    // or repeated evidence enrichment could exceed Raider.IO's rate limits.
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      calls += 1;
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url
      );
      expect(url.pathname).toBe("/api/v1/raiding/boss-rankings");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        raid: "nerubar-palace",
        boss: "queen-ansurek",
        difficulty: "mythic",
        region: "world"
      });
      return new Response(
        JSON.stringify({
          bossRankings: [
            {
              rank: 2,
              guild: {
                name: "Echo",
                realm: { slug: "tarren-mill" },
                region: { slug: "eu" }
              },
              encountersDefeated: [
                {
                  slug: "queen-ansurek",
                  firstDefeated: "2025-01-14T20:30:00.000Z"
                }
              ]
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    const gateway = createRaiderIoClient({
      fetch,
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });

    await expect(
      gateway.getMythicBossRankings({
        raidSlug: "nerubar-palace",
        bossSlug: "queen-ansurek"
      })
    ).resolves.toEqual({
      kind: "rankings",
      rows: [
        {
          rank: 2,
          guildName: "Echo",
          guildRealm: "tarren-mill",
          guildRegion: "eu",
          firstDefeated: "2025-01-14T20:30:00.000Z"
        }
      ]
    });
    await gateway.getMythicBossRankings({
      raidSlug: "nerubar-palace",
      bossSlug: "queen-ansurek"
    });
    expect(calls).toBe(2);
  });

  it("uses the earliest exact-boss kill from recorded duplicate and later encounters", async () => {
    const payload = structuredClone(recordedRankings);
    payload.bossRankings[0]!.encountersDefeated.reverse();
    payload.bossRankings[0]!.encountersDefeated.unshift({
      slug: "other-boss",
      firstDefeated: "2020-01-01T00:00:00Z",
      lastDefeated: "2020-01-01T00:00:00Z"
    });
    const gateway = createRaiderIoClient({
      fetch: async () => Response.json(payload),
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });
    await expect(
      gateway.getMythicBossRankings({
        raidSlug: "nerubar-palace",
        bossSlug: "queen-ansurek"
      })
    ).resolves.toEqual({
      kind: "rankings",
      rows: [
        {
          rank: 1,
          guildName: "Liquid",
          guildRealm: "illidan",
          guildRegion: "us",
          firstDefeated: "2024-09-29T07:02:27Z"
        },
        {
          rank: 2,
          guildName: "Echo",
          guildRealm: "tarren-mill",
          guildRegion: "eu",
          firstDefeated: "2024-09-30T12:07:25Z"
        }
      ]
    });
    await expect(
      gateway.getMythicBossRankings({
        raidSlug: "nerubar-palace",
        bossSlug: "absent-boss"
      })
    ).resolves.toEqual({ kind: "rankings", rows: [] });
  });

  it("returns a rate-limit limitation for boss-ranking requests", async () => {
    const gateway = createRaiderIoClient({
      fetch: async () =>
        new Response(JSON.stringify({}), {
          status: 429,
          headers: { "Retry-After": "30" }
        }),
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });

    await expect(
      gateway.getMythicBossRankings({
        raidSlug: "nerubar-palace",
        bossSlug: "queen-ansurek"
      })
    ).resolves.toEqual({
      kind: "limitation",
      code: "rate_limited",
      retryAfterMs: 30_000
    });
  });

  it("returns schema_drift when a boss-ranking row is malformed", async () => {
    const gateway = createRaiderIoClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            bossRankings: [
              {
                rank: 0,
                guild: { name: "Echo", realm: { slug: "tarren-mill" } },
                encountersDefeated: {
                  firstDefeated: "2025-01-14T20:30:00.000Z"
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });

    await expect(
      gateway.getMythicBossRankings({
        raidSlug: "nerubar-palace",
        bossSlug: "queen-ansurek"
      })
    ).resolves.toEqual({ kind: "limitation", code: "schema_drift" });
  });
});
