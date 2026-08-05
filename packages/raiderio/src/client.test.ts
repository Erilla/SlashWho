import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CharacterKey } from "@slashwho/domain";
import { describe, expect, it } from "vitest";

import { createRaiderIoClient } from "./index";

type FixtureName =
  | "character-visible-owner"
  | "character-private-owner"
  | "character-declared-main"
  | "profile-valid"
  | "profile-invalid"
  | "claimed-characters"
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
      name === "claimed-characters";
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

  it("represents a privacy-hidden owner without inventing an identity", async () => {
    const character = await clientFor("character-private-owner").getCharacter(
      sentinel
    );

    expect(character.ownerId).toBeNull();
    expect(character.profileGuess).toBe("profile-candidate");
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
    ).resolves.toEqual([
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
    ]);
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
