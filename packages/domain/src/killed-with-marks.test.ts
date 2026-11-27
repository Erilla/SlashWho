import { describe, expect, it } from "vitest";

import type { CharacterKey } from "./character-key";
import {
  collectKilledWithMarks,
  type KilledWithRaiderIoKill,
  type KilledWithWarcraftLogsKill
} from "./killed-with-marks";

const eundariel: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "eundariel"
};
const ryii: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryii" };
const method = { name: "Method", region: "eu", realm: "tarren-mill" } as const;
const casual = {
  name: "Seriously Casual",
  region: "eu",
  realm: "silvermoon"
} as const;

function raiderIo(
  overrides: Partial<KilledWithRaiderIoKill> = {}
): KilledWithRaiderIoKill {
  return {
    character: eundariel,
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    killedAt: "2026-07-20T17:25:57.000Z",
    guild: method,
    encounter: { state: "read", encounter: { guild: method } },
    ...overrides
  };
}

function warcraftLogs(
  overrides: Partial<KilledWithWarcraftLogsKill> = {}
): KilledWithWarcraftLogsKill {
  return {
    character: eundariel,
    killedAt: "2026-07-20T17:26:10.000Z",
    raidName: "March on Quel'Danas",
    bossName: "Midnight Falls",
    guild: method,
    ...overrides
  };
}

/** The characters each kill lists as already on a guild's night. */
function loggedNights(
  warcraftLogsKills: readonly KilledWithWarcraftLogsKill[],
  raiderIoKills: readonly KilledWithRaiderIoKill[] = [raiderIo()]
) {
  return collectKilledWithMarks(warcraftLogsKills, raiderIoKills).flatMap(
    (mark) => mark.kills.map((kill) => kill.loggedNights)
  );
}

describe("collectKilledWithMarks", () => {
  it("records the guild night a matching Warcraft Logs kill places it in", () => {
    expect(loggedNights([warcraftLogs()])).toEqual([
      [{ character: eundariel, guild: method }]
    ]);
  });

  it("keeps a matched kill, so the timeline decides if its night has a bar", () => {
    // One Warcraft Logs night in Method draws no bar, so the mark must still
    // be there for the timeline to draw (#924 review).
    const marks = collectKilledWithMarks([warcraftLogs()], [raiderIo()]);
    expect(marks.map((mark) => mark.date)).toEqual(["2026-07-20"]);
    expect(marks[0]!.kills[0]!.characters).toEqual([eundariel]);
  });

  it("places no night for a matching Warcraft Logs kill naming no guild", () => {
    expect(loggedNights([warcraftLogs({ guild: null })])).toEqual([[]]);
  });

  it("matches across the Warcraft Logs combined Midnight zone", () => {
    expect(loggedNights([warcraftLogs({ raidName: "VS / DR / MQD" })])).toEqual(
      [[{ character: eundariel, guild: method }]]
    );
  });

  it("matches a fight logged under a former name, attributed to the character", () => {
    // Warcraft Logs evidence for an alias is attributed to the dossier
    // character and only annotated with the logged name (#721).
    const alias = {
      ...warcraftLogs(),
      loggedAs: { ...eundariel, name: "eun" }
    };
    expect(loggedNights([alias])).toHaveLength(1);
    expect(loggedNights([alias])[0]).toHaveLength(1);
  });

  it("matches the character's canonical id, ignoring case", () => {
    expect(
      loggedNights([
        warcraftLogs({ character: { ...eundariel, name: "Eundariel" } })
      ])[0]
    ).toHaveLength(1);
  });

  it.each([
    ["another realm", { ...eundariel, realm: "draenor" }],
    ["another region", { ...eundariel, region: "us" as const }]
  ])(
    "does not match a same-named character on %s",
    (_where, elsewhere: CharacterKey) => {
      expect(loggedNights([warcraftLogs({ character: elsewhere })])).toEqual([
        []
      ]);
    }
  );

  it("marks an unmatched Raider.IO kill on its UTC night", () => {
    expect(collectKilledWithMarks([], [raiderIo()])).toEqual([
      {
        date: "2026-07-20",
        kills: [
          {
            raidName: "March on Quel'Danas",
            bossName: "Midnight Falls",
            killedAt: "2026-07-20T17:25:57.000Z",
            guild: method,
            characters: [eundariel],
            loggedNights: [],
            log: "read"
          }
        ]
      }
    ]);
  });

  it("does not match a Warcraft Logs kill on another UTC day", () => {
    const marks = collectKilledWithMarks(
      [warcraftLogs({ killedAt: "2026-07-21T00:05:00.000Z" })],
      [raiderIo({ killedAt: "2026-07-20T23:55:00.000Z" })]
    );
    expect(marks.map((mark) => mark.date)).toEqual(["2026-07-20"]);
    expect(marks[0]!.kills[0]!.loggedNights).toEqual([]);
  });

  it("does not match a different character's Warcraft Logs kill", () => {
    expect(loggedNights([warcraftLogs({ character: ryii })])).toEqual([[]]);
  });

  it("does not match a Warcraft Logs kill of another boss", () => {
    expect(
      loggedNights([
        warcraftLogs({
          raidName: "The Voidspire",
          bossName: "Vaelgor & Ezzorak"
        })
      ])
    ).toEqual([[]]);
  });

  it("keeps a kill Raider.IO names no guild for, with a null guild", () => {
    const marks = collectKilledWithMarks(
      [],
      [raiderIo({ guild: null, encounter: { state: "not_read" } })]
    );
    expect(marks[0]!.kills[0]).toMatchObject({ guild: null, log: "not_read" });
  });

  it("credits the guild on a read log over the kill list's", () => {
    const marks = collectKilledWithMarks(
      [],
      [
        raiderIo({
          guild: casual,
          encounter: { state: "read", encounter: { guild: method } }
        })
      ]
    );
    expect(marks[0]!.kills[0]!.guild).toEqual(method);
  });

  it("keeps a kill with no Raider.IO log, credited from its kill list", () => {
    const marks = collectKilledWithMarks(
      [],
      [raiderIo({ guild: casual, encounter: { state: "none" } })]
    );
    expect(marks[0]!.kills[0]).toMatchObject({ guild: casual, log: "none" });
  });

  it("stacks one night's kills into one mark, listing each boss and guild", () => {
    const marks = collectKilledWithMarks(
      [],
      [
        raiderIo({ killedAt: "2026-07-20T21:00:00.000Z" }),
        raiderIo({ character: ryii, killedAt: "2026-07-20T20:59:00.000Z" }),
        raiderIo({
          bossSlug: "vaelgor-ezzorak",
          killedAt: "2026-07-20T19:00:00.000Z",
          guild: casual,
          encounter: { state: "not_read" }
        }),
        raiderIo({ killedAt: "2026-07-27T20:00:00.000Z", character: ryii })
      ]
    );
    expect(marks.map((mark) => mark.date)).toEqual([
      "2026-07-20",
      "2026-07-27"
    ]);
    expect(marks[0]!.kills).toEqual([
      {
        raidName: "The Voidspire",
        bossName: "Vaelgor & Ezzorak",
        killedAt: "2026-07-20T19:00:00.000Z",
        guild: casual,
        characters: [eundariel],
        loggedNights: [],
        log: "not_read"
      },
      {
        raidName: "March on Quel'Danas",
        bossName: "Midnight Falls",
        killedAt: "2026-07-20T20:59:00.000Z",
        guild: method,
        characters: [eundariel, ryii],
        loggedNights: [],
        log: "read"
      }
    ]);
  });

  it("keeps one boss credited to two guilds on one night apart, in a fixed order", () => {
    const kills = [
      raiderIo(),
      raiderIo({
        character: ryii,
        guild: casual,
        encounter: { state: "read", encounter: { guild: casual } }
      })
    ];
    const forward = collectKilledWithMarks([], kills);
    expect(forward).toHaveLength(1);
    // Same time and boss, so ordered by guild identity: region, then realm.
    expect(forward[0]!.kills.map((kill) => kill.guild?.name)).toEqual([
      "Seriously Casual",
      "Method"
    ]);
    expect(collectKilledWithMarks([], [...kills].reverse())).toEqual(forward);
  });

  it("records each character's logged night on its own within a shared kill", () => {
    const marks = collectKilledWithMarks(
      [warcraftLogs()],
      [raiderIo(), raiderIo({ character: ryii })]
    );
    expect(marks[0]!.kills[0]).toMatchObject({
      characters: [eundariel, ryii],
      loggedNights: [{ character: eundariel, guild: method }]
    });
  });

  it("leaves out a boss the catalogue cannot place, and invalid times", () => {
    expect(
      collectKilledWithMarks(
        [],
        [
          raiderIo({ bossSlug: "not-a-boss" }),
          raiderIo({ killedAt: "not a time" })
        ]
      )
    ).toEqual([]);
  });
});
