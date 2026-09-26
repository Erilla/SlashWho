import { dossierLimitationCodeSchema } from "@slashwho/contracts";
import { describe, expect, it } from "vitest";

import { collectionProgress } from "./collection-progress";
import {
  contractLimitation,
  contractLimitationCode
} from "./dossier-limitations";

const character = { region: "eu", realm: "silvermoon", name: "ryii" } as const;

describe("contractLimitationCode", () => {
  it("names every contract code as itself", () => {
    for (const code of dossierLimitationCodeSchema.options) {
      expect(contractLimitationCode(code)).toBe(code);
    }
  });

  it("reads the stored schema_drift spelling as schema_changed", () => {
    expect(contractLimitationCode("schema_drift")).toBe("schema_changed");
  });

  it("names no code the contract does not", () => {
    expect(contractLimitationCode("made_up_code")).toBeNull();
    // An inherited property is not a recorded code.
    expect(contractLimitationCode("toString")).toBeNull();
  });
});

describe("contractLimitation", () => {
  it("fails on an unknown code by name, before the dossier schema sees it", () => {
    expect(() =>
      contractLimitation({
        source: "warcraft_logs",
        character,
        code: "made_up_code"
      })
    ).toThrow("unknown_limitation_code:made_up_code");
  });

  it("maps a recorded code at the boundary", () => {
    expect(
      contractLimitation({
        source: "blizzard",
        character,
        code: "schema_drift",
        observedAt: "2026-09-26T00:00:00.000Z"
      })
    ).toMatchObject({
      code: "schema_changed",
      affects: "cutting_edge",
      recovery: "none"
    });
  });
});

describe("collectionProgress", () => {
  it("keeps a step whose code the contract does not name, without the code", () => {
    expect(
      collectionProgress([
        {
          id: "warcraft_logs_history",
          state: "limited",
          limitationCode: "made_up_code"
        }
      ] as Parameters<typeof collectionProgress>[0])
    ).toEqual([{ id: "warcraft_logs_history", state: "limited" }]);
  });
});
