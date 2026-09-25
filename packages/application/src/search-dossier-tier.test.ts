import type { CharacterKey } from "@slashwho/domain";
import { supportedRaidCatalogue } from "@slashwho/domain";
import { describe, expect, it, vi } from "vitest";

import { applicationConfigSchema } from "./config";
import {
  DOSSIER_TIER_SEARCH_CHARACTER_LIMIT,
  dossierTierSearchResponse,
  searchDossierTier
} from "./search-dossier-tier";
import { TIER_SEARCH_SPACING_MS } from "./tier-search";

const at = new Date("2026-09-23T12:00:00.000Z");
const eternalPalace = supportedRaidCatalogue().find(
  (raid) => raid.raidName === "The Eternal Palace"
)!.raidId;

const character = (name: string): CharacterKey => ({
  region: "eu",
  realm: "silvermoon",
  name
});
const ryii = character("ryii");
const alt = character("alt");
const cooling = character("cooling");
const active = character("active");
const busy = character("busy");
const fresh = character("fresh");

type Reservation =
  | { kind: "reserved" }
  | { kind: "active"; mode: string; raidId: string | null; status: string }
  | { kind: "recent"; status: string; createdAt: Date }
  | { kind: "no_evidence" };

/**
 * A store that answers each character's reservation as its own, so one
 * character's state can only reach another through the code under test.
 */
function harness(reservations: Readonly<Record<string, Reservation>>) {
  let runs = 0;
  const reserveTierSearch = vi.fn(
    async ({ key, raidId }: { key: CharacterKey; raidId: string }) => {
      const reservation = reservations[key.name] ?? { kind: "reserved" };
      const run = (overrides: Record<string, unknown>) => ({
        id: `run-${key.name}`,
        key,
        status: "queued",
        mode: "tier_search",
        tierSearchRaidId: raidId,
        createdAt: at,
        ...overrides
      });
      switch (reservation.kind) {
        case "reserved":
          runs += 1;
          return { kind: "reserved", run: run({ id: `run-${runs}` }) };
        case "active":
          return {
            kind: "active",
            run: run({
              mode: reservation.mode,
              tierSearchRaidId: reservation.raidId,
              status: reservation.status
            })
          };
        case "recent":
          return {
            kind: "recent",
            run: run({
              status: reservation.status,
              createdAt: reservation.createdAt
            })
          };
        case "no_evidence":
          return { kind: "no_evidence" };
      }
    }
  );
  const markEnqueued = vi.fn().mockResolvedValue(undefined);
  const enqueueCharacterEvidence = vi.fn(
    async (runId: string) => `job-${runId}`
  );
  return {
    reserveTierSearch,
    markEnqueued,
    enqueueCharacterEvidence,
    search: (
      subjects: readonly {
        key: CharacterKey;
        displayName: string;
        aliases?: readonly CharacterKey[];
      }[],
      options: { raidId?: string; limit?: number } = {}
    ) =>
      searchDossierTier({
        subjects,
        raidId: options.raidId ?? eternalPalace,
        at,
        repositories: {
          evidence: { reserveTierSearch, markEnqueued } as never
        },
        queue: { enqueueCharacterEvidence },
        ...(options.limit === undefined ? {} : { limit: options.limit })
      })
  };
}

const subject = (key: CharacterKey, aliases?: readonly CharacterKey[]) => ({
  key,
  displayName: key.name.charAt(0).toUpperCase() + key.name.slice(1),
  ...(aliases ? { aliases } : {})
});

describe("searching a dossier tier for every character", () => {
  it("queues a run of its own for each included character, for the one raid", async () => {
    // Break caught (#449): only the character in the page URL was searched,
    // so the connected characters' gaps in the section were never looked at.
    const test = harness({});

    const result = await test.search([subject(ryii), subject(alt)]);

    expect(result).toEqual({
      kind: "searched",
      characters: [
        { key: ryii, displayName: "Ryii", outcome: { kind: "queued" } },
        { key: alt, displayName: "Alt", outcome: { kind: "queued" } }
      ]
    });
    expect(test.reserveTierSearch.mock.calls.map(([input]) => input)).toEqual(
      [ryii, alt].map((key) =>
        expect.objectContaining({
          key,
          raidId: eternalPalace,
          at,
          searchedSince: new Date(at.getTime() - TIER_SEARCH_SPACING_MS)
        })
      )
    );
    // Each run is queued and costed as its own, never pooled into one.
    expect(test.enqueueCharacterEvidence.mock.calls.map(([id]) => id)).toEqual([
      "run-1",
      "run-2"
    ]);
    expect(test.markEnqueued.mock.calls).toEqual([
      ["run-1", "job-run-1"],
      ["run-2", "job-run-2"]
    ]);
  });

  it("queues the eligible characters past a cooling-down, an active and an empty one", async () => {
    const searchedAt = new Date(at.getTime() - 60 * 60 * 1_000);
    const test = harness({
      cooling: { kind: "recent", status: "complete", createdAt: searchedAt },
      active: {
        kind: "active",
        mode: "tier_search",
        raidId: eternalPalace,
        status: "running"
      },
      busy: { kind: "active", mode: "full", raidId: null, status: "running" },
      alt: { kind: "no_evidence" }
    });

    const result = await test.search([
      subject(ryii),
      subject(cooling),
      subject(active),
      subject(busy),
      subject(alt),
      subject(fresh)
    ]);

    if (result.kind !== "searched") throw new Error("not_searched");
    expect(
      result.characters.map((item) => [item.key.name, item.outcome])
    ).toEqual([
      ["ryii", { kind: "queued" }],
      [
        "cooling",
        {
          kind: "recent",
          status: "complete",
          searchedAt,
          searchableAgainAt: new Date(
            searchedAt.getTime() + TIER_SEARCH_SPACING_MS
          )
        }
      ],
      ["active", { kind: "busy", searchingThisTier: true, status: "running" }],
      ["busy", { kind: "busy", searchingThisTier: false, status: "running" }],
      ["alt", { kind: "no_evidence" }],
      ["fresh", { kind: "queued" }]
    ]);
    expect(test.enqueueCharacterEvidence).toHaveBeenCalledTimes(2);
  });

  it("searches a character once, however many names it has", async () => {
    // Characters sharing a Warcraft Logs ID are one dossier identity (#490),
    // and a key repeated across sources is still one character.
    const renamed = character("renamed");
    const test = harness({});

    const result = await test.search([
      subject(ryii),
      subject(alt, [renamed]),
      subject({ ...ryii, name: "RYII" }),
      subject(renamed)
    ]);

    if (result.kind !== "searched") throw new Error("not_searched");
    expect(result.characters.map((item) => item.key)).toEqual([ryii, alt]);
    expect(test.reserveTierSearch).toHaveBeenCalledTimes(2);
  });

  it("names the characters beyond its safety limit rather than dropping them", async () => {
    const subjects = Array.from({ length: 5 }, (_, index) =>
      subject(character(`c${index}`))
    );
    const test = harness({});

    const result = await test.search(subjects, { limit: 3 });

    if (result.kind !== "searched") throw new Error("not_searched");
    expect(result.characters.map((item) => item.outcome.kind)).toEqual([
      "queued",
      "queued",
      "queued",
      "over_limit",
      "over_limit"
    ]);
    expect(test.reserveTierSearch).toHaveBeenCalledTimes(3);
  });

  it("never stops short of the characters a dossier can display", () => {
    // Break caught: a limit below the configurable display cap would leave
    // listed characters unsearched on every press.
    const config = (cap: number) =>
      applicationConfigSchema.safeParse({
        BOT_API_KEY: "b".repeat(32),
        RATE_LIMIT_HASH_SECRET: "r".repeat(32),
        DOSSIER_CHARACTER_CAP: cap
      }).success;

    expect(config(1)).toBe(true);
    expect(config(DOSSIER_TIER_SEARCH_CHARACTER_LIMIT + 1)).toBe(false);
  });

  it("reports one character's failure and still queues the rest", async () => {
    const test = harness({});
    test.enqueueCharacterEvidence.mockImplementationOnce(async () => {
      throw new Error("queue_down");
    });

    const result = await test.search([subject(ryii), subject(alt)]);

    expect(result).toEqual({
      kind: "searched",
      characters: [
        { key: ryii, displayName: "Ryii", outcome: { kind: "failed" } },
        { key: alt, displayName: "Alt", outcome: { kind: "queued" } }
      ]
    });
  });

  it("fails the press when nothing at all could be queued", async () => {
    const test = harness({});
    test.enqueueCharacterEvidence.mockRejectedValue(new Error("queue_down"));

    await expect(test.search([subject(ryii), subject(alt)])).rejects.toThrow(
      "queue_down"
    );
  });

  it("refuses a raid it has no window for, before reserving anything", async () => {
    const test = harness({});

    await expect(
      test.search([subject(ryii)], { raidId: "not-a-raid" })
    ).resolves.toEqual({ kind: "unknown_tier" });
    expect(test.reserveTierSearch).not.toHaveBeenCalled();
  });
});

describe("answering a dossier tier search press", () => {
  const searchedAt = new Date("2026-09-23T10:00:00.000Z");
  const recent = (hoursAgo: number) => ({
    kind: "recent" as const,
    status: "complete" as const,
    searchedAt,
    searchableAgainAt: new Date(
      at.getTime() + (24 - hoursAgo) * 60 * 60 * 1_000
    )
  });
  const entry = (
    key: CharacterKey,
    outcome: Parameters<typeof dossierTierSearchResponse>[0][number]["outcome"]
  ) => ({ key, displayName: key.name, outcome });

  it("reports each character's outcome under a summary led by what it queued", () => {
    const response = dossierTierSearchResponse([
      entry(ryii, { kind: "queued" }),
      entry(cooling, recent(2)),
      entry(active, {
        kind: "busy",
        searchingThisTier: true,
        status: "queued"
      }),
      entry(busy, {
        kind: "busy",
        searchingThisTier: false,
        status: "running"
      }),
      entry(alt, { kind: "no_evidence" }),
      entry(fresh, { kind: "over_limit" }),
      entry(character("broken"), { kind: "failed" })
    ]);

    expect(response).toEqual({
      reserved: true,
      body: {
        state: "queued",
        searchableAgainAt: null,
        characters: [
          {
            key: ryii,
            displayName: "ryii",
            outcome: "queued",
            searchableAgainAt: null
          },
          {
            key: cooling,
            displayName: "cooling",
            outcome: "searched",
            searchableAgainAt: "2026-09-24T10:00:00.000Z"
          },
          {
            key: active,
            displayName: "active",
            outcome: "already_queued",
            searchableAgainAt: null
          },
          {
            key: busy,
            displayName: "busy",
            outcome: "busy",
            searchableAgainAt: null
          },
          {
            key: alt,
            displayName: "alt",
            outcome: "no_evidence",
            searchableAgainAt: null
          },
          {
            key: fresh,
            displayName: "fresh",
            outcome: "over_limit",
            searchableAgainAt: null
          },
          {
            key: character("broken"),
            displayName: "broken",
            outcome: "failed",
            searchableAgainAt: null
          }
        ]
      }
    });
  });

  it("summarises a press that queued nothing by what was already happening", () => {
    const summary = (
      outcomes: Parameters<typeof dossierTierSearchResponse>[0]
    ) => {
      const { reserved, body } = dossierTierSearchResponse(outcomes);
      return { reserved, state: body.state, again: body.searchableAgainAt };
    };

    expect(
      summary([
        entry(ryii, recent(1)),
        entry(alt, { kind: "busy", searchingThisTier: true, status: "running" })
      ])
    ).toEqual({ reserved: false, state: "running", again: null });
    expect(summary([entry(ryii, recent(1)), entry(alt, recent(5))])).toEqual({
      reserved: false,
      state: "searched",
      again: "2026-09-24T07:00:00.000Z"
    });
    expect(
      summary([
        entry(ryii, { kind: "no_evidence" }),
        entry(alt, {
          kind: "busy",
          searchingThisTier: false,
          status: "running"
        })
      ])
    ).toEqual({ reserved: false, state: "busy", again: null });
    expect(summary([entry(ryii, { kind: "no_evidence" })])).toEqual({
      reserved: false,
      state: "no_evidence",
      again: null
    });
  });
});
