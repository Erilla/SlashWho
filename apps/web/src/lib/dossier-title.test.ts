import { describe, expect, it } from "vitest";

import { dossierTitle, formatRealmName } from "./dossier-title";

const key = { region: "eu", realm: "silvermoon", name: "ryii" } as const;

describe("formatRealmName", () => {
  it("renders a realm slug as its display name", () => {
    expect(formatRealmName("silvermoon")).toBe("Silvermoon");
  });

  it("renders a multi-word realm slug", () => {
    expect(formatRealmName("tarren-mill")).toBe("Tarren Mill");
  });
});

describe("dossierTitle", () => {
  it("names the character and realm when no guild is known", () => {
    expect(dossierTitle(key, null)).toBe("Ryii @ Silvermoon");
  });

  it("places the guild between the character and its realm", () => {
    expect(
      dossierTitle(key, { name: "Rancour", region: "eu", realm: "draenor" })
    ).toBe("Ryii <Rancour> @ Silvermoon");
  });

  it("names the character's realm, not the guild's", () => {
    // A guild need not sit on its members' realm, and the title is about the
    // character: showing Draenor here would misidentify who was searched.
    expect(
      dossierTitle(
        { region: "eu", realm: "tarren-mill", name: "ryii" },
        { name: "Rancour", region: "eu", realm: "draenor" }
      )
    ).toBe("Ryii <Rancour> @ Tarren Mill");
  });
});
