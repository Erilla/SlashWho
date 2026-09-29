import { describe, expect, it } from "vitest";

import { replayConfig } from "./character-groups-replay.mts";

describe("character groups replay config", () => {
  // Break caught: the ceiling was hard-coded to 50, so a deployment with a
  // lower ceiling was replayed against pages the web never builds.
  it("reads the web's ceiling with the web's default and bounds, needing nothing else", () => {
    expect(replayConfig({})).toEqual({ DOSSIER_CHARACTER_CEILING: 50 });
    expect(replayConfig({ DOSSIER_CHARACTER_CEILING: "12" })).toEqual({
      DOSSIER_CHARACTER_CEILING: 12
    });
    expect(() => replayConfig({ DOSSIER_CHARACTER_CEILING: "51" })).toThrow(
      "invalid_dossier_character_ceiling"
    );
    expect(() => replayConfig({ DOSSIER_CHARACTER_CEILING: "0" })).toThrow(
      "invalid_dossier_character_ceiling"
    );
  });
});
