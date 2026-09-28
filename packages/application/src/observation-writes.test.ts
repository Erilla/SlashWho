import { describe, expect, it } from "vitest";
import {
  canonicalCharacterId,
  type CharacterKey,
  type DiscoveredCharacter
} from "@slashwho/domain";
import {
  continuationCycleWrite,
  firstSweepCycleWrite,
  liveSweepCompletionWrite,
  raiderIoPublicationWrite
} from "./observation-writes";

const rootKey = { region: "eu", realm: "draenor", name: "root" } as const;
const altKey = { region: "eu", realm: "draenor", name: "alt" } as const;
const fpKey = { region: "eu", realm: "draenor", name: "fp" } as const;
const character = (
  key: CharacterKey,
  source: DiscoveredCharacter["source"]
): DiscoveredCharacter => ({
  key,
  displayName: key.name,
  className: "Mage",
  level: 80,
  guild: null,
  raiderIoUrl: "https://raider.io/x",
  source
});

describe("observation writes", () => {
  it("records a Raider.IO publication without the root, replacing only when unlimited", () => {
    const write = raiderIoPublicationWrite({
      runId: "run",
      rootKey,
      limitationCode: null,
      characters: [character(rootKey, "input"), character(altKey, "claimed")]
    });
    expect(write.families).toEqual([
      {
        family: "raiderio",
        decision: "replaced",
        reason: "raiderio_complete",
        sweepReservationId: null,
        observed: [{ key: altKey, source: "claimed" }]
      }
    ]);
    expect(
      raiderIoPublicationWrite({
        runId: "run",
        rootKey,
        limitationCode: "privacy_hidden",
        characters: []
      }).families[0]
    ).toMatchObject({ decision: "added_only", reason: "privacy_hidden" });
  });

  it("records both families on a first cycle, before de-duplication and after the tournament filter", () => {
    const write = firstSweepCycleWrite({
      runId: "run",
      rootKey,
      reservationId: "res",
      raiderIoLimitation: null,
      raiderIoCharacters: [
        character(rootKey, "input"),
        character(altKey, "claimed")
      ],
      sweep: {
        kind: "matched",
        characters: [
          character(altKey, "fingerprint"),
          character(fpKey, "fingerprint")
        ]
      },
      excludedTournamentIds: new Set([canonicalCharacterId(fpKey)])
    });
    expect(write.families).toEqual([
      {
        family: "raiderio",
        decision: "replaced",
        reason: "raiderio_complete",
        sweepReservationId: null,
        observed: [{ key: altKey, source: "claimed" }]
      },
      {
        family: "fingerprint",
        decision: "replaced",
        reason: "matched",
        sweepReservationId: "res",
        observed: [{ key: altKey, source: "fingerprint" }]
      }
    ]);
  });

  it("never touches the Raider.IO family on a continuation", () => {
    const write = continuationCycleWrite({
      runId: "run",
      rootKey,
      reservationId: "res",
      sweep: { kind: "capped", characters: [character(fpKey, "fingerprint")] }
    });
    expect(write.families.map((family) => family.family)).toEqual([
      "fingerprint"
    ]);
    expect(write.families[0]).toMatchObject({
      decision: "added_only",
      reason: "capped",
      sweepReservationId: "res"
    });
  });

  it("only adds on a live-sweep completion", () => {
    const write = liveSweepCompletionWrite({
      runId: "run",
      rootKey,
      characters: [character(rootKey, "input"), character(altKey, "claimed")]
    });
    expect(write.families).toEqual([
      {
        family: "raiderio",
        decision: "added_only",
        reason: "live_sweep_completion",
        sweepReservationId: null,
        observed: [{ key: altKey, source: "claimed" }]
      }
    ]);
  });
});
