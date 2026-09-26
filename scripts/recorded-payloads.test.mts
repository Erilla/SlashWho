import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isEndpoint,
  leakedIdentities,
  PlaceholderBook,
  recordPayload,
  RecordingRefused,
  syntheticTimestampBase,
  unobservedShape,
  verifyRecording,
  type Endpoint,
  type Recording
} from "./recorded-payloads.mts";

const fixturesRoot = resolve(import.meta.dirname, "../tests/fixtures");
const recordedRoot = resolve(fixturesRoot, "recorded");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name));
}

const recordingFiles = filesUnder(recordedRoot).filter((file) =>
  file.endsWith(".json")
);
const recordings = recordingFiles.map((file) => readJson(file) as Recording);

const isSuccess = (status: number) => status >= 200 && status < 300;

function record(
  body: unknown,
  endpoint: Endpoint,
  options: { status?: number; book?: PlaceholderBook } = {}
): Recording {
  return recordPayload(body, {
    endpoint,
    status: options.status ?? 200,
    recordedOn: "2026-09-26",
    book: options.book ?? new PlaceholderBook()
  });
}

describe("committed recordings", () => {
  it("exist", () => {
    expect(recordingFiles.length).toBeGreaterThan(0);
  });

  it("hold only README.md and recordings named <endpoint>-<label>.json", () => {
    // A stray raw dump or notes file beside the recordings would escape the
    // verifier entirely, so nothing but verified JSON may live here.
    const unexpected = filesUnder(recordedRoot)
      .map((file) => relative(recordedRoot, file).replaceAll("\\", "/"))
      .filter((file) => file !== "README.md")
      .filter((file) => {
        const recording = readJson(resolve(recordedRoot, file)) as {
          endpoint?: unknown;
        };
        if (!isEndpoint(recording.endpoint)) return true;
        const [provider, endpoint] = recording.endpoint.split(".");
        return !new RegExp(`^${provider}/${endpoint}-[a-z0-9-]+\\.json$`).test(
          file
        );
      });
    expect(unexpected).toEqual([]);
  });

  it.each(recordingFiles.map((file) => [basename(file), file]))(
    "%s carries only allow-listed, redacted values",
    (_name, file) => {
      expect(verifyRecording(readJson(file))).toEqual([]);
    }
  );
});

describe("verifyRecording", () => {
  const valid = (): Recording =>
    record(
      {
        characterDetails: {
          character: {
            name: "Realname",
            level: 90,
            class: { name: "Mage" },
            realm: { slug: "silvermoon" },
            region: { slug: "eu" }
          },
          user: { name: "realowner" }
        }
      },
      "raiderio.character"
    );

  type CharacterBody = {
    characterDetails: {
      character: { name: string; realm: { slug: string } };
      user: { name: string };
      characterCustomizations?: unknown;
    };
  };

  function withBody(mutate: (body: CharacterBody) => void): Recording {
    const recording = structuredClone(valid()) as Recording & {
      body: CharacterBody;
    };
    mutate(recording.body);
    return recording;
  }

  it("accepts a recording the recorder produced", () => {
    expect(verifyRecording(valid())).toEqual([]);
  });

  it("refuses a real name at an identity path", () => {
    const recording = withBody((body) => {
      body.characterDetails.character.name = "Realname";
    });
    expect(verifyRecording(recording)).toEqual([
      {
        path: "body.characterDetails.character.name",
        problem: "identity is not a character placeholder"
      }
    ]);
  });

  it("refuses a field the allow-list does not name", () => {
    const recording = withBody((body) => {
      body.characterDetails.characterCustomizations = {
        biography: "find me on discord"
      };
    });
    expect(verifyRecording(recording)).toContainEqual({
      path: "body.characterDetails.characterCustomizations.biography",
      problem: "path is not on the allow-list"
    });
  });

  it("refuses a URL or BattleTag wherever it appears", () => {
    const recording = withBody((body) => {
      body.characterDetails.character.realm.slug = "https://raider.io/x";
      body.characterDetails.user.name = "Someone#12345";
    });
    const problems = verifyRecording(recording).map((v) => v.problem);
    expect(problems).toContain("string looks like a url");
    expect(problems).toContain("string looks like a battletag");
  });

  it("refuses an error message the allow-list has not reviewed", () => {
    const recording = {
      ...record(
        { statusCode: 400, error: "Bad Request" },
        "raiderio.character",
        { status: 400 }
      ),
      body: {
        statusCode: 400,
        error: "Bad Request",
        message: "Could not find Realname-Silvermoon"
      }
    };
    expect(verifyRecording(recording)).toEqual([
      { path: "body.message", problem: "value is not in the enumerated set" }
    ]);
  });

  it("refuses a real achievement timestamp", () => {
    const recording = {
      ...record({ achievements: [] }, "blizzard.character-achievements"),
      body: {
        achievements: [{ id: 6, completed_timestamp: 1_600_000_123_456 }]
      }
    };
    expect(verifyRecording(recording)).toEqual([
      {
        path: "body.achievements[].completed_timestamp",
        problem: "timestamp is not synthetic"
      }
    ]);
  });

  it("refuses an unknown envelope field or endpoint", () => {
    expect(
      verifyRecording({ ...valid(), url: "https://raider.io" })
    ).toContainEqual({ path: "url", problem: "unknown envelope field" });
    expect(verifyRecording({ ...valid(), endpoint: "raiderio.raw" })).toEqual([
      { path: "endpoint", problem: "unknown endpoint" }
    ]);
  });
});

describe("recordPayload", () => {
  it("drops every field the allow-list does not name", () => {
    const recording = record(
      {
        characterDetails: {
          character: {
            id: 123_456,
            name: "Realname",
            level: 90,
            class: { id: 8, name: "Mage" },
            realm: { slug: "silvermoon", name: "Silvermoon" },
            region: { slug: "eu" },
            items: { item_level_equipped: 700 }
          },
          characterCustomizations: {
            biography: "discord me",
            discord_profile: "real#1234"
          }
        },
        mythicPlusScores: { all: 3_000 }
      },
      "raiderio.character"
    );
    expect(recording.body).toEqual({
      characterDetails: {
        character: {
          name: "Alfa",
          level: 90,
          class: { name: "Mage" },
          realm: { slug: "silvermoon" },
          region: { slug: "eu" }
        },
        characterCustomizations: { discord_profile: "fixture-discord-alfa" }
      }
    });
  });

  it("keeps an empty or null identity as shape, not as a placeholder", () => {
    // #35: an empty discord_profile is a value upstream really sends; replacing
    // it with a placeholder would erase exactly the case that broke.
    const recording = record(
      {
        characterDetails: {
          user: null,
          characterCustomizations: { discord_profile: "" }
        }
      },
      "raiderio.character"
    );
    expect(recording.body).toEqual({
      characterDetails: {
        user: null,
        characterCustomizations: { discord_profile: "" }
      }
    });
  });

  it("maps one real value to one placeholder across a session, keeping case", () => {
    const book = new PlaceholderBook();
    const character = record(
      { characterDetails: { user: { name: "RealOwner" } } },
      "raiderio.character",
      { book }
    );
    const profile = record(
      { viewUserCharactersApi: { name: "realowner", characters: [] } },
      "raiderio.view-characters",
      { book }
    );
    expect(character.body).toEqual({
      characterDetails: { user: { name: "fixture-owner" } }
    });
    expect(profile.body).toEqual({
      viewUserCharactersApi: { name: "fixture-owner", characters: [] }
    });
  });

  it("rewrites the name inside a declared main's path", () => {
    const recording = record(
      {
        characterDetails: {
          characterCustomizations: {
            main_character: {
              name: "Realmain",
              path: "/characters/EU/Argent-Dawn/Realmain"
            }
          }
        }
      },
      "raiderio.character"
    );
    expect(recording.body).toEqual({
      characterDetails: {
        characterCustomizations: {
          main_character: {
            name: "Alfa",
            path: "/characters/eu/argent-dawn/Alfa"
          }
        }
      }
    });
  });

  it("replaces achievement timestamps and truncates long arrays", () => {
    const achievements = Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      completed_timestamp: 1_600_000_000_000 + index * 7_777
    }));
    const recording = record(
      { achievements },
      "blizzard.character-achievements"
    );
    const body = recording.body as {
      achievements: { id: number; completed_timestamp: number }[];
    };
    expect(body.achievements).toHaveLength(25);
    expect(body.achievements[0]).toEqual({
      id: 1,
      completed_timestamp: syntheticTimestampBase + 86_400_000
    });
    expect(verifyRecording(recording)).toEqual([]);
  });

  it("refuses a value it cannot classify rather than keeping it", () => {
    expect(() =>
      record(
        { statusCode: 400, message: "Could not find Realname" },
        "raiderio.character",
        { status: 400 }
      )
    ).toThrow(RecordingRefused);
    expect(() =>
      record(
        { characterDetails: { character: { class: { name: "Tinker" } } } },
        "raiderio.character"
      )
    ).toThrow("unrecognised_value at characterDetails.character.class.name");
  });

  it("reads only what is present and skips the rest", () => {
    // The leniency kept from the #39 prototype: an absent field is absent in
    // the recording, not a refusal, so one sparse member cannot stop a run.
    const recording = record(
      { members: [{ character: { name: "Realname", level: 80 } }] },
      "blizzard.guild-roster"
    );
    expect(recording.body).toEqual({
      members: [{ character: { name: "Alfa", level: 80 } }]
    });
  });

  it("lets the recorder detect a real identity that survived", () => {
    const book = new PlaceholderBook();
    record(
      { characterDetails: { character: { name: "Realname" } } },
      "raiderio.character",
      { book }
    );
    expect(leakedIdentities('{"note":"REALNAME was here"}', book)).toEqual([
      "Realname"
    ]);
    expect(leakedIdentities('{"name":"Alfa"}', book)).toEqual([]);
  });
});

/**
 * Every hand-built provider fixture, and what it claims to be. `upstream`
 * fixtures are checked against the recordings: any field, or any null or empty
 * string, that no recording of the same endpoint has shown must be listed in
 * `unobserved` with where its shape comes from. That list is the visible
 * register of guesses; the #38 fixture would have had to write
 * `playable_class.name` into it with no source to give.
 */
type Registration =
  | {
      conformance: "upstream";
      endpoint: Endpoint;
      unobserved?: Readonly<Record<string, string>>;
    }
  | { conformance: "synthetic"; reason: string };

const notYetRecorded =
  "discord_profile: null is accepted by the parser but not yet recorded";

const handBuiltFixtures: Readonly<Record<string, Registration>> = {
  "raiderio/character-declared-main-out-of-scope.json": {
    conformance: "upstream",
    endpoint: "raiderio.character",
    unobserved: {
      "characterDetails.characterCustomizations.discord_profile: null":
        notYetRecorded
    }
  },
  "raiderio/character-declared-main.json": {
    conformance: "upstream",
    endpoint: "raiderio.character",
    unobserved: {
      "characterDetails.characterCustomizations.discord_profile: null":
        notYetRecorded
    }
  },
  "raiderio/character-empty-discord.json": {
    conformance: "upstream",
    endpoint: "raiderio.character",
    unobserved: {
      "characterDetails.characterCustomizations.discord_profile: empty-string":
        "observed in production, #35"
    }
  },
  "raiderio/character-guild-null.json": {
    conformance: "upstream",
    endpoint: "raiderio.character",
    unobserved: {
      "characterDetails.character.guild: null":
        "a guildless character; packages/raiderio/src/normalize.ts, not yet recorded"
    }
  },
  "raiderio/character-guild-unsupported-region.json": {
    conformance: "upstream",
    endpoint: "raiderio.character"
  },
  "raiderio/character-guild.json": {
    conformance: "upstream",
    endpoint: "raiderio.character"
  },
  "raiderio/character-private-owner.json": {
    conformance: "upstream",
    endpoint: "raiderio.character"
  },
  "raiderio/character-renamed-root.json": {
    conformance: "upstream",
    endpoint: "raiderio.character",
    unobserved: {
      "characterDetails.characterCustomizations.discord_profile: null":
        notYetRecorded
    }
  },
  "raiderio/character-visible-owner.json": {
    conformance: "upstream",
    endpoint: "raiderio.character"
  },
  "raiderio/claimed-characters-out-of-scope.json": {
    conformance: "upstream",
    endpoint: "raiderio.view-characters"
  },
  "raiderio/claimed-characters.json": {
    conformance: "upstream",
    endpoint: "raiderio.view-characters"
  },
  "raiderio/profile-forbidden.json": {
    conformance: "upstream",
    endpoint: "raiderio.view-characters",
    unobserved: {
      "errorCode: string": "profile_is_private, observed in production, #36"
    }
  },
  "raiderio/profile-invalid.json": {
    conformance: "upstream",
    endpoint: "raiderio.view-characters"
  },
  "raiderio/profile-valid.json": {
    conformance: "upstream",
    endpoint: "raiderio.view-characters"
  },
  "raiderio/missing-character.json": {
    conformance: "synthetic",
    reason:
      "404 with a placeholder body; Raider.IO was recorded answering an unknown character with 400 (recorded/raiderio/character-unknown-name.json)"
  },
  "raiderio/raid-progress-rate-limited.json": {
    conformance: "synthetic",
    reason: "raid-progress is not yet a recorded endpoint"
  },
  "raiderio/raid-progress-schema-drift.json": {
    conformance: "synthetic",
    reason: "deliberately off-shape: schema drift"
  },
  "raiderio/raid-progress-valid.json": {
    conformance: "synthetic",
    reason: "raid-progress is not yet a recorded endpoint"
  },
  "raiderio/rate-limited.json": {
    conformance: "synthetic",
    reason: "a 429 has not been recorded; body is a placeholder marker"
  },
  "raiderio/schema-drift.json": {
    conformance: "synthetic",
    reason: "deliberately off-shape: schema drift"
  },
  "raiderio/server-error.json": {
    conformance: "synthetic",
    reason: "a 5xx has not been recorded; body is a placeholder marker"
  }
};

// Blizzard joins this list once its fixtures move to files (#597).
const handBuiltDirectories = ["raiderio", "blizzard"];

describe("hand-built fixtures", () => {
  it("are each registered as upstream-shaped or synthetic", () => {
    const present = handBuiltDirectories
      .filter((directory) => existsSync(resolve(fixturesRoot, directory)))
      .flatMap((directory) =>
        readdirSync(resolve(fixturesRoot, directory))
          .filter((file) => file.endsWith(".json"))
          .map((file) => `${directory}/${file}`)
      )
      .sort();
    expect(present).toEqual(Object.keys(handBuiltFixtures).sort());
  });

  it.each(
    Object.entries(handBuiltFixtures).filter(
      ([, registration]) => registration.conformance === "upstream"
    )
  )("%s asserts only shapes a recording has shown", (file, registration) => {
    if (registration.conformance !== "upstream") return;
    const fixture = readJson(resolve(fixturesRoot, file)) as {
      status: number;
      body: unknown;
    };
    const comparable = recordings.filter(
      (recording) =>
        recording.endpoint === registration.endpoint &&
        isSuccess(recording.status) === isSuccess(fixture.status)
    );
    expect(comparable.length).toBeGreaterThan(0);
    // Exact, not a subset: an entry the recordings have since observed must
    // come off the list, so the register of guesses only ever shrinks honestly.
    expect(unobservedShape(fixture.body, comparable)).toEqual(
      Object.keys(registration.unobserved ?? {}).sort()
    );
  });
});

describe("unobservedShape", () => {
  it("names a field a fixture invents that the upstream never sends (#38)", () => {
    // Blizzard's roster member carries playable_class { id } only; the #38
    // fixture added a name. Both bodies here are inline test inputs, not
    // recordings.
    const observed = record(
      {
        members: [
          {
            character: {
              name: "Realname",
              level: 80,
              realm: { slug: "draenor" },
              playable_class: { id: 8 }
            }
          }
        ]
      },
      "blizzard.guild-roster"
    );
    const invented = {
      members: [
        {
          character: {
            name: "Alfa",
            level: 80,
            realm: { slug: "draenor" },
            playable_class: { id: 8, name: "Mage" }
          }
        }
      ]
    };
    expect(unobservedShape(invented, [observed])).toEqual([
      "members[].character.playable_class.name: string"
    ]);
  });

  it("names a null or empty string no recording has shown", () => {
    const observed = record(
      { characterDetails: { user: { name: "Realowner" } } },
      "raiderio.character"
    );
    expect(
      unobservedShape({ characterDetails: { user: null } }, [observed])
    ).toEqual(["characterDetails.user: null"]);
    expect(
      unobservedShape({ characterDetails: { user: { name: "" } } }, [observed])
    ).toEqual(["characterDetails.user.name: empty-string"]);
  });
});
