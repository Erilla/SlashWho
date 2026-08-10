import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CharacterKey } from "@slashwho/domain";
import { describe, expect, it } from "vitest";

import { createRaiderIoClient } from "./index";

type FixtureName =
  | "character-visible-owner"
  | "character-private-owner"
  | "character-empty-discord"
  | "character-declared-main"
  | "character-declared-main-out-of-scope"
  | "character-renamed-root"
  | "profile-valid"
  | "profile-invalid"
  | "claimed-characters"
  | "claimed-characters-out-of-scope"
  | "missing-character"
  | "rate-limited"
  | "server-error"
  | "schema-drift";

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
      name === "claimed-characters" ||
      name === "claimed-characters-out-of-scope";
    const expectedPath = expectsProfile
      ? "/api/user/view-characters"
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
      declaredMain: null
    });
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
          declaredMain: null
        },
        {
          key: { region: "us", realm: "area-52", name: "secondalt" },
          displayName: "Secondalt",
          className: "Shaman",
          level: 76,
          ownerId: null,
          profileGuess: null,
          declaredMain: null
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
          declaredMain: null
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
});
