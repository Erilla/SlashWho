import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  botAddDossierCharacterResponseSchema,
  botCreateDossierRequestSchema,
  botCreateDossierResponseSchema,
  botDossierStatusSchema,
  botDossierSummarySchema,
  dossierRefreshResponseSchema,
  safeApiErrorSchema
} from "./index";

type FixtureEntry = { endpoint?: string; response: unknown };

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/contracts/bot-client-v1.json",
      import.meta.url
    ),
    "utf8"
  )
) as {
  version: string;
  create: FixtureEntry;
  status: FixtureEntry;
  summary: FixtureEntry;
  addCharacter: FixtureEntry;
  refresh: FixtureEntry;
  error: FixtureEntry;
};

describe("bot client v1 fixture", () => {
  it("describes only implemented routes, and every response parses", () => {
    expect(Object.keys(fixture).sort()).toEqual([
      "addCharacter",
      "create",
      "error",
      "refresh",
      "status",
      "summary",
      "version"
    ]);
    for (const entry of [
      fixture.create,
      fixture.status,
      fixture.summary,
      fixture.addCharacter,
      fixture.refresh
    ]) {
      expect(entry.endpoint).not.toMatch(/\/api\/v1\/(searches|characters)/);
    }
    expect(
      botCreateDossierResponseSchema.safeParse(fixture.create.response).success
    ).toBe(true);
    expect(
      botDossierStatusSchema.safeParse(fixture.status.response).success
    ).toBe(true);
    expect(
      botDossierSummarySchema.safeParse(fixture.summary.response).success
    ).toBe(true);
    expect(
      botAddDossierCharacterResponseSchema.safeParse(
        fixture.addCharacter.response
      ).success
    ).toBe(true);
    expect(
      dossierRefreshResponseSchema.safeParse(fixture.refresh.response).success
    ).toBe(true);
    expect(safeApiErrorSchema.safeParse(fixture.error.response).success).toBe(
      true
    );
  });
});

const key = { region: "eu", realm: "silvermoon", name: "ryii" };

function summary(overrides: Record<string, unknown> = {}) {
  return {
    root: key,
    state: "ready",
    snapshotId: null,
    lastCollectedAt: null,
    cuttingEdgesRestored: false,
    characters: [
      {
        key,
        displayName: "Ryii",
        className: null,
        guild: null,
        source: "manually_added",
        confidence: null,
        evidenceState: "waiting",
        pending: true
      }
    ],
    guildHistory: [],
    raids: [],
    raidsTruncated: false,
    cuttingEdges: [],
    limitations: [],
    ...overrides
  };
}

describe("bot dossier contracts", () => {
  it("accepts a pending character with null class, guild and confidence", () => {
    expect(botDossierSummarySchema.safeParse(summary()).success).toBe(true);
  });

  it("accepts region/realm/name identities in boss lists", () => {
    const raid = {
      raidName: "The Venomous Abyss",
      bosses: [
        {
          bossName: "Nymrissa Wavecaller",
          state: "kill",
          firstKilledAt: "2026-09-05T18:26:29.653Z",
          characters: ["eu/silvermoon/ryii"],
          worldRank: null,
          reportUrl: null
        }
      ]
    };
    expect(
      botDossierSummarySchema.safeParse(summary({ raids: [raid] })).success
    ).toBe(true);
  });

  it("accepts the bot-only privacy_hidden limitation", () => {
    expect(
      botDossierSummarySchema.safeParse(
        summary({
          state: "partial",
          limitations: [
            {
              code: "privacy_hidden",
              affects: "linked_characters",
              character: key
            }
          ]
        })
      ).success
    ).toBe(true);
  });

  it("requires the truncation marker", () => {
    const { raidsTruncated: _dropped, ...withoutMarker } = summary();
    void _dropped;
    expect(botDossierSummarySchema.safeParse(withoutMarker).success).toBe(
      false
    );
  });

  it("rejects more than ten declared characters", () => {
    const characters = Array.from(
      { length: 11 },
      (_, index) => `https://raider.io/characters/eu/silvermoon/alt${index}`
    );
    expect(
      botCreateDossierRequestSchema.safeParse({ characters }).success
    ).toBe(false);
    expect(
      botCreateDossierRequestSchema.safeParse({
        characters: characters.slice(0, 10)
      }).success
    ).toBe(true);
  });

  it("rejects a malformed character URL in a create", () => {
    expect(
      botCreateDossierRequestSchema.safeParse({
        characters: ["not a url"]
      }).success
    ).toBe(false);
  });

  it("rejects an unknown outcome", () => {
    expect(
      botCreateDossierResponseSchema.safeParse({
        root: key,
        state: "collecting",
        snapshotId: null,
        lastCollectedAt: null,
        evidenceRunIds: [],
        outcomes: [{ key, outcome: "joined" }]
      }).success
    ).toBe(false);
  });
});
