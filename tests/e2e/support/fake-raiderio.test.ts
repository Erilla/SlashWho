import { afterEach, describe, expect, it } from "vitest";

import { startFakeRaiderIo } from "./fake-raiderio";

describe("startFakeRaiderIo", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
  });

  it("serves Ryii's approved identity with its declared related characters", async () => {
    // Break caught: removing the account-backed fixture can also remove the
    // connected-character outcome users see in the demo.
    const fixture = await startFakeRaiderIo();
    close = fixture.close;
    await fetch(`${fixture.baseUrl}/__control/release`);

    const readCharacter = async (path: string) => {
      const response = await fetch(`${fixture.baseUrl}${path}`);
      const body = (await response.json()) as {
        characterDetails: {
          character: {
            name: string;
            level: number;
            class: { name: string };
            realm: { slug: string };
            region: { slug: string };
          };
          user?: unknown;
          characterCustomizations?: {
            main_character?: { name: string; path: string } | null;
          };
        };
      };
      return { response, details: body.characterDetails };
    };

    const ryii = await readCharacter("/api/characters/eu/silvermoon/ryii");
    const frostalt = await readCharacter(
      "/api/characters/eu/silvermoon/frostalt"
    );
    const nightalt = await readCharacter(
      "/api/characters/eu/tarren-mill/nightalt"
    );

    expect(ryii.response.ok).toBe(true);
    expect(ryii.details.character).toEqual({
      name: "Ryii",
      level: 90,
      class: { name: "Warrior" },
      realm: { slug: "Silvermoon" },
      region: { slug: "EU" }
    });
    expect(ryii.details.characterCustomizations?.main_character).toEqual({
      name: "Frostalt",
      path: "/characters/eu/silvermoon/Frostalt"
    });
    expect(frostalt.response.ok).toBe(true);
    expect(frostalt.details.characterCustomizations?.main_character).toEqual({
      name: "Nightalt",
      path: "/characters/eu/tarren-mill/Nightalt"
    });
    expect(nightalt.response.ok).toBe(true);
    for (const details of [ryii.details, frostalt.details, nightalt.details]) {
      expect(details.user).toBeUndefined();
    }
  });

  it("holds only the requested profile prefix and releases its pending reads", async () => {
    const fixture = await startFakeRaiderIo();
    close = fixture.close;
    await fetch(`${fixture.baseUrl}/__control/hold?profile=profilecoldsweep`);
    let answered = false;
    const heldRead = fetch(
      `${fixture.baseUrl}/api/characters/eu/silvermoon/profilecoldsweeproot`
    ).then((response) => {
      answered = true;
      return response;
    });
    try {
      await expect
        .poll(async () => {
          const response = await fetch(`${fixture.baseUrl}/__control/stats`);
          const stats = (await response.json()) as {
            characterRequests: Record<string, number>;
          };
          return (
            stats.characterRequests[
              "/api/characters/eu/silvermoon/profilecoldsweeproot"
            ] ?? 0
          );
        })
        .toBe(1);
      expect(
        (
          await fetch(
            `${fixture.baseUrl}/api/characters/eu/silvermoon/profilecoldunrelated`
          )
        ).status
      ).toBe(200);
      expect(answered).toBe(false);
      // The targeted sweep cannot hold another spec's Frostalt fixture.
      expect(
        (
          await fetch(
            `${fixture.baseUrl}/api/characters/eu/silvermoon/frostalt`
          )
        ).status
      ).toBe(200);
    } finally {
      await fetch(`${fixture.baseUrl}/__control/release`);
    }
    expect((await heldRead).status).toBe(200);
    expect(answered).toBe(true);
    expect(
      (
        await fetch(
          `${fixture.baseUrl}/api/characters/eu/silvermoon/profilecoldsweepalt`
        )
      ).status
    ).toBe(200);
  });
  it("does not expose an account profile responder", async () => {
    // Break caught: the deterministic source can retain an account-identity
    // endpoint even after its character payload stops returning that identity.
    const fixture = await startFakeRaiderIo();
    close = fixture.close;
    await fetch(`${fixture.baseUrl}/__control/release`);

    const response = await fetch(
      `${fixture.baseUrl}/api/user/view-characters?name=account-profile`
    );

    expect(response.status).toBe(404);
  });
});
