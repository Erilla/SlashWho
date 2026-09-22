import { afterEach, describe, expect, it } from "vitest";

import { startFakeRaiderIo } from "./fake-raiderio";

describe("startFakeRaiderIo", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
  });

  it("serves Ryii's approved public demo identity without account fields", async () => {
    // Break caught: the demo source can drift back to synthetic Mage data or
    // retain the public profile/account fields that must not enter fixtures.
    const fixture = await startFakeRaiderIo();
    close = fixture.close;
    await fetch(`${fixture.baseUrl}/__control/release`);

    const response = await fetch(
      `${fixture.baseUrl}/api/characters/eu/silvermoon/ryii`
    );
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
        characterCustomizations?: unknown;
      };
    };

    expect(response.ok).toBe(true);
    expect(body.characterDetails.character).toEqual({
      name: "Ryii",
      level: 90,
      class: { name: "Warrior" },
      realm: { slug: "Silvermoon" },
      region: { slug: "EU" }
    });
    expect(body.characterDetails.user).toBeUndefined();
    expect(body.characterDetails.characterCustomizations).toBeUndefined();
  });
});
