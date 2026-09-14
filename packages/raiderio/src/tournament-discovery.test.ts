import { readFileSync } from "node:fs";

import { discoverCharacter, type CharacterKey } from "@slashwho/domain";
import { describe, expect, it } from "vitest";

import { createRaiderIoClient } from "./index";

const recorded = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/raiderio/tournament-recorded.json",
      import.meta.url
    ),
    "utf8"
  )
) as {
  retail: CharacterBody;
  tournament: CharacterBody;
  profile: {
    viewUserCharactersApi: {
      name: string;
      characters: { character: UpstreamCharacter }[];
    };
  };
};

type UpstreamCharacter = {
  name: string;
  level: number;
  class: { name: string };
  realm: { slug: string; realmType?: string };
  region: { slug: string };
};
type CharacterBody = {
  characterDetails: {
    character: UpstreamCharacter;
    isTournamentProfile?: boolean;
    user: { name: string } | null;
    characterCustomizations?: {
      discord_profile?: string;
      main_character?: { name: string; path: string };
    };
  };
};

const retail: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "retail"
};
const tournament: CharacterKey = {
  region: "eu",
  realm: "eu-mythic-dungeons",
  name: "tournament"
};
const options = { requestCap: 12, isSuppressed: async () => false };

function gateway(
  retailBody: unknown = recorded.retail,
  tournamentBody: unknown = recorded.tournament,
  profileBody: unknown = recorded.profile
) {
  return createRaiderIoClient({
    baseUrl: "https://fixtures.invalid",
    timeoutMs: 1_000,
    fetch: async (input) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url
      );
      const body =
        url.pathname === "/api/characters/eu/silvermoon/retail"
          ? retailBody
          : url.pathname === "/api/characters/eu/eu-mythic-dungeons/tournament"
            ? tournamentBody
            : url.pathname === "/api/user/view-characters" &&
                url.searchParams.get("name") === "fixture-owner"
              ? profileBody
              : null;
      return new Response(JSON.stringify(body), {
        status: body === null ? 404 : 200
      });
    }
  });
}

describe("tournament profile discovery", () => {
  it("refuses to publish a snapshot anchored to a recorded tournament root", async () => {
    expect(await discoverCharacter(tournament, gateway(), options)).toEqual({
      kind: "failure",
      code: "character_not_found",
      retryable: false
    });
  });

  it.each(["claimed", "profile_guess"])(
    "omits tournament members from %s results and discloses a partial snapshot",
    async (source) => {
      const root = structuredClone(recorded.retail);
      if (source === "profile_guess") {
        root.characterDetails.user = null;
        root.characterDetails.characterCustomizations = {
          discord_profile: "fixture-owner"
        };
      }
      const outcome = await discoverCharacter(retail, gateway(root), options);
      expect(outcome).toMatchObject({
        kind: "snapshot",
        state: "partial",
        limitationCode:
          source === "claimed" ? "unsupported_member" : "privacy_hidden"
      });
      expect(
        outcome.kind === "snapshot" &&
          outcome.characters.map((item) => item.key)
      ).toEqual([retail]);
    }
  );

  it("keeps a retail-only recorded profile complete", async () => {
    const profile = structuredClone(recorded.profile);
    profile.viewUserCharactersApi.characters =
      profile.viewUserCharactersApi.characters.slice(1);
    const outcome = await discoverCharacter(
      retail,
      gateway(recorded.retail, recorded.tournament, profile),
      options
    );
    expect(outcome).toMatchObject({ kind: "snapshot", state: "complete" });
    expect(
      outcome.kind === "snapshot" && outcome.characters.map((item) => item.key)
    ).toEqual([retail]);
  });

  it("does not reintroduce an excluded declared main through a less informative profile list", async () => {
    const root = structuredClone(recorded.retail);
    root.characterDetails.characterCustomizations = {
      main_character: {
        name: "Tournament",
        path: "/characters/eu/eu-mythic-dungeons/tournament"
      }
    };
    const profile = structuredClone(recorded.profile);
    delete profile.viewUserCharactersApi.characters[0]!.character.realm
      .realmType;
    const outcome = await discoverCharacter(
      retail,
      gateway(root, recorded.tournament, profile),
      options
    );
    expect(outcome).toMatchObject({
      kind: "snapshot",
      state: "partial",
      limitationCode: "unsupported_member"
    });
    expect(
      outcome.kind === "snapshot" && outcome.characters.map((item) => item.key)
    ).toEqual([retail]);
  });

  it("uses the explicit detail flag independently of the realm name and type", async () => {
    const root = structuredClone(recorded.retail);
    root.characterDetails.isTournamentProfile = true;
    expect(await discoverCharacter(retail, gateway(root), options)).toEqual({
      kind: "failure",
      code: "character_not_found",
      retryable: false
    });
  });

  it("uses the profile realm type independently of its slug", async () => {
    const profile = structuredClone(recorded.profile);
    profile.viewUserCharactersApi.characters[0]!.character.realm.slug =
      "ordinary-realm";
    const outcome = await discoverCharacter(
      retail,
      gateway(recorded.retail, recorded.tournament, profile),
      options
    );
    expect(outcome).toMatchObject({
      kind: "snapshot",
      state: "partial",
      limitationCode: "unsupported_member"
    });
    expect(
      outcome.kind === "snapshot" && outcome.characters.map((item) => item.key)
    ).toEqual([retail]);
  });

  it("rejects malformed tournament flags instead of publishing unchecked characters", async () => {
    const root = {
      characterDetails: {
        ...recorded.retail.characterDetails,
        isTournamentProfile: "true"
      }
    };
    expect(await discoverCharacter(retail, gateway(root), options)).toEqual({
      kind: "failure",
      code: "upstream_schema_changed",
      retryable: false
    });
  });
});
