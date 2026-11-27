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
    ...overrides
  };
}

describe("collectKilledWithMarks", () => {
  it("draws nothing for a Raider.IO kill a Warcraft Logs kill matches", () => {
    expect(collectKilledWithMarks([warcraftLogs()], [raiderIo()])).toEqual([]);
  });

  it("matches across the Warcraft Logs combined Midnight zone", () => {
    expect(
      collectKilledWithMarks(
        [warcraftLogs({ raidName: "VS / DR / MQD" })],
        [raiderIo()]
      )
    ).toEqual([]);
  });

  it("matches a fight logged under a former name, attributed to the character", () => {
    // Warcraft Logs evidence for an alias is attributed to the dossier
    // character and only annotated with the logged name (#721).
    const alias = {
      ...warcraftLogs(),
      loggedAs: { ...eundariel, name: "eun" }
    };
    expect(collectKilledWithMarks([alias], [raiderIo()])).toEqual([]);
  });

  it("matches the character's canonical id, ignoring case", () => {
    expect(
      collectKilledWithMarks(
        [warcraftLogs({ character: { ...eundariel, name: "Eundariel" } })],
        [raiderIo()]
      )
    ).toEqual([]);
  });

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
            log: "read"
          }
        ]
      }
    ]);
  });

  it("marks a kill whose Warcraft Logs copy is on another UTC day", () => {
    const marks = collectKilledWithMarks(
      [warcraftLogs({ killedAt: "2026-07-21T00:05:00.000Z" })],
      [raiderIo({ killedAt: "2026-07-20T23:55:00.000Z" })]
    );
    expect(marks.map((mark) => mark.date)).toEqual(["2026-07-20"]);
  });

  it("marks a kill a different character's Warcraft Logs kill shares", () => {
    const marks = collectKilledWithMarks(
      [warcraftLogs({ character: ryii })],
      [raiderIo()]
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]!.kills[0]!.characters).toEqual([eundariel]);
  });

  it("marks a kill whose Warcraft Logs kill is another boss", () => {
    expect(
      collectKilledWithMarks(
        [
          warcraftLogs({
            raidName: "The Voidspire",
            bossName: "Vaelgor & Ezzorak"
          })
        ],
        [raiderIo()]
      )
    ).toHaveLength(1);
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
        log: "not_read"
      },
      {
        raidName: "March on Quel'Danas",
        bossName: "Midnight Falls",
        killedAt: "2026-07-20T20:59:00.000Z",
        guild: method,
        characters: [eundariel, ryii],
        log: "read"
      }
    ]);
  });

  it("keeps one boss credited to two guilds on one night apart", () => {
    const marks = collectKilledWithMarks(
      [],
      [
        raiderIo(),
        raiderIo({
          character: ryii,
          guild: casual,
          encounter: { state: "read", encounter: { guild: casual } }
        })
      ]
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]!.kills.map((kill) => kill.guild?.name).sort()).toEqual([
      "Method",
      "Seriously Casual"
    ]);
  });

  it("matches each character on its own within a shared night", () => {
    const marks = collectKilledWithMarks(
      [warcraftLogs()],
      [raiderIo(), raiderIo({ character: ryii })]
    );
    expect(marks[0]!.kills[0]!.characters).toEqual([ryii]);
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
