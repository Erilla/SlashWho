// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import type { ApplicantDossier, CharacterKey } from "@slashwho/contracts";
import type { ReactElement } from "react";

import { DossierCharacterProvider } from "./dossier-character-name";
import { DossierRaidList } from "./dossier-raid-list";

const ryii: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "ryii"
};
const ryalts: CharacterKey = {
  region: "eu",
  realm: "draenor",
  name: "ryalts"
};
const knownCharacters = [
  {
    key: ryii,
    displayName: "Ryii",
    className: "Mage",
    raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
    source: "submitted" as const
  },
  {
    key: ryalts,
    displayName: "Ryalts",
    className: "Priest",
    raiderIoUrl: "https://raider.io/characters/eu/draenor/ryalts",
    source: "fingerprint_derived" as const
  }
];

function renderWithDossierCharacters(ui: ReactElement) {
  return render(
    <DossierCharacterProvider characters={knownCharacters}>
      {ui}
    </DossierCharacterProvider>
  );
}

const boss = {
  bossId: "2602",
  bossName: "Queen Ansurek",
  bossOrder: 8,
  imageUrl: null,
  state: "kill" as const,
  firstKill: {
    killedAt: "2025-01-14T20:30:00.000Z",
    guild: null,
    historicWorldRank: null,
    reportUrl: null,
    characters: [ryii],
    parses: []
  },
  bestParses: []
};

afterEach(cleanup);

it("shows the grouped rank and keeps distinct reports in a click-only menu", async () => {
  const reportUrls = [
    "https://www.warcraftlogs.com/reports/one#fight=1",
    "https://www.warcraftlogs.com/reports/two#fight=2"
  ];
  renderWithDossierCharacters(
    <DossierRaidList
      raids={[
        {
          raidId: "1320",
          raidName: "The Venomous Abyss",
          imageUrl: null,
          cuttingEdge: null,
          bosses: [
            {
              ...boss,
              bossName: "Nek'zali the Soulcoiler",
              imageUrl: null,
              firstKill: {
                ...boss.firstKill,
                historicWorldRank: 48,
                guild: { name: "Rancour", region: "eu", realm: "draenor" },
                reportUrl: reportUrls[0]!,
                reportUrls
              }
            }
          ]
        }
      ]}
    />
  );
  expect(screen.getByText("World #48")).toBeVisible();
  const trigger = screen.getByRole("button", {
    name: "Choose from 2 kill reports"
  });
  expect(trigger).toHaveAccessibleDescription("2 reports found");
  await userEvent.click(trigger);

  const links = screen.getAllByRole("link", { name: /log uploaded by/i });
  expect(links.map((link) => link.getAttribute("href"))).toEqual(reportUrls);
  for (const link of links) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  expect(screen.getAllByText("First kill")).toHaveLength(1);
});

it("replaces duplicate kill report icons with a click-only guild-first report menu", async () => {
  const reportUrls = [
    "https://www.warcraftlogs.com/reports/personal#fight=1",
    "https://www.warcraftlogs.com/reports/guild#fight=2",
    "https://www.warcraftlogs.com/reports/personal-two#fight=3"
  ];
  const raids = [
    {
      raidId: "menu-raid",
      raidName: "Menu Raid",
      imageUrl: null,
      cuttingEdge: null,
      bosses: [
        {
          ...boss,
          firstKill: {
            ...boss.firstKill,
            reportUrl: reportUrls[1]!,
            reportUrls,
            reports: [
              {
                reportUrl: reportUrls[1]!,
                source: "guild_log",
                uploader: "Dorian"
              },
              {
                reportUrl: reportUrls[0]!,
                source: "personal_log",
                uploader: "Ryiislogs"
              },
              {
                reportUrl: reportUrls[2]!,
                source: "personal_log",
                uploader: "Varod"
              }
            ]
          }
        }
      ]
    }
  ] as unknown as ApplicantDossier["raids"];

  renderWithDossierCharacters(<DossierRaidList raids={raids} />);

  const trigger = screen.getByRole("button", {
    name: "Choose from 3 kill reports"
  });
  expect(trigger).toHaveAccessibleDescription("3 reports found");
  expect(
    screen.queryByRole("link", { name: "Guild log uploaded by Dorian" })
  ).not.toBeInTheDocument();

  await userEvent.setup().click(trigger);

  expect(
    screen
      .getAllByRole("link", { name: /log uploaded by/ })
      .map((link) => link.getAttribute("href"))
  ).toEqual([reportUrls[1], reportUrls[0], reportUrls[2]]);
});

it("replaces duplicate wipe report icons with a guild-first click-only report menu", async () => {
  const reportUrls = [
    "https://www.warcraftlogs.com/reports/personal-wipe#fight=1",
    "https://www.warcraftlogs.com/reports/guild-wipe#fight=2",
    "https://www.warcraftlogs.com/reports/personal-wipe-two#fight=3"
  ];
  const raids = [
    {
      raidId: "wipe-menu-raid",
      raidName: "Wipe Menu Raid",
      imageUrl: null,
      cuttingEdge: null,
      bosses: [
        {
          bossId: "wipe-menu-boss",
          bossName: "Wipe Menu Boss",
          bossOrder: 1,
          imageUrl: null,
          state: "wipe",
          wipe: {
            attemptedAt: "2025-02-14T20:30:00.000Z",
            reportUrl: reportUrls[1],
            source: "guild_log",
            uploader: "Dorian",
            characters: [ryii]
          },
          wipes: [
            {
              attemptedAt: "2025-02-14T20:30:00.000Z",
              reportUrl: reportUrls[0],
              source: "personal_log",
              uploader: "Ryiislogs",
              characters: [ryii]
            },
            {
              attemptedAt: "2025-02-14T20:30:00.000Z",
              reportUrl: reportUrls[1],
              source: "guild_log",
              uploader: "Dorian",
              characters: [ryii]
            },
            {
              attemptedAt: "2025-02-14T20:30:00.000Z",
              reportUrl: reportUrls[2],
              source: "personal_log",
              uploader: "Varod",
              characters: [ryii]
            }
          ]
        }
      ]
    }
  ] as unknown as ApplicantDossier["raids"];

  renderWithDossierCharacters(<DossierRaidList raids={raids} />);
  await userEvent.setup().click(screen.getByText("View wipe evidence"));

  const trigger = screen.getByRole("button", {
    name: "Choose from 3 wipe reports"
  });
  expect(trigger).toHaveAccessibleDescription("3 reports found");
  expect(
    screen.queryByRole("link", { name: "Guild log uploaded by Dorian" })
  ).not.toBeInTheDocument();

  await userEvent.click(trigger);

  expect(
    screen
      .getAllByRole("link", { name: /log uploaded by/ })
      .map((link) => link.getAttribute("href"))
  ).toEqual([reportUrls[1], reportUrls[0], reportUrls[2]]);
});

it("renders guild attribution as a concise value with an accessible label", async () => {
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "guild-label",
            raidName: "Guild Label Raid",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [
              {
                ...boss,
                firstKill: {
                  ...boss.firstKill,
                  guild: { name: "Rancour", region: "eu", realm: "Draenor" }
                },
                firstKills: [
                  {
                    ...boss.firstKill,
                    guild: { name: "Rancour", region: "eu", realm: "Draenor" }
                  },
                  {
                    ...boss.firstKill,
                    killedAt: "2025-02-14T20:30:00.000Z",
                    guild: null
                  }
                ]
              }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  await userEvent.setup().click(screen.getByText("View kill evidence"));

  const evidence = screen.getByRole("region", { name: "Kill evidence" });
  const guildValues = within(evidence)
    .getAllByText("Guild", { selector: "dt" })
    .map((label) => label.parentElement?.querySelector("dd"));

  expect(guildValues[0]).toHaveTextContent(/^Rancour · Draenor$/);
  expect(guildValues[1]).toHaveTextContent(/^—$/);
  expect(guildValues[0]).not.toHaveTextContent(/^Guild:/);
  expect(guildValues[1]).not.toHaveTextContent(/^Guild:/);
  expect(
    within(evidence).getAllByText("Guild", { selector: "dt" })
  ).toHaveLength(2);
});

it("colours kill report controls green and wipe report controls grey", async () => {
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "report-colours",
            raidName: "Report Colours Raid",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [
              {
                ...boss,
                firstKill: {
                  ...boss.firstKill,
                  reportUrl: "https://www.warcraftlogs.com/reports/kill#fight=1"
                },
                firstKills: [
                  {
                    ...boss.firstKill,
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/kill#fight=1"
                  },
                  {
                    ...boss.firstKill,
                    killedAt: "2025-02-14T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/kill-later#fight=3"
                  }
                ],
                wipes: [
                  {
                    attemptedAt: "2025-01-13T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/wipe#fight=2",
                    characters: [ryii]
                  }
                ]
              }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  await userEvent.setup().click(screen.getByText("View kill evidence"));

  expect(
    screen
      .getAllByRole("link", {
        name: "View Warcraft Logs report (opens in a new tab)"
      })
      .every((link) =>
        link.classList.contains("upstream-icon-link--evidence-kill")
      )
  ).toBe(true);
  expect(
    screen.getByRole("link", {
      name: "View Warcraft Logs wipe report (opens in a new tab)"
    })
  ).toHaveClass("upstream-icon-link--evidence-wipe");
});

it("renders raid artwork as a decorative banner behind the real heading", () => {
  // Break caught: raid artwork could be announced as a duplicate identifier
  // or regress to a thumbnail that does not frame the section heading.
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "1273",
            raidName: "Nerub-ar Palace",
            imageUrl: "https://render.example/raids/nerub-ar.jpg",
            cuttingEdge: null,
            bosses: [
              {
                ...boss,
                imageUrl: "https://render.example/bosses/ansurek.jpg"
              }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  const heading = screen.getByRole("heading", {
    level: 3,
    name: "Nerub-ar Palace"
  });
  const artwork = heading.querySelector("img");

  expect(artwork).toHaveAttribute("alt", "");
  expect(artwork).toHaveAttribute("aria-hidden", "true");
  expect(artwork).toHaveAttribute(
    "src",
    "https://render.example/raids/nerub-ar.jpg"
  );
  expect(screen.getByAltText("Queen Ansurek artwork")).toHaveAttribute(
    "src",
    "https://render.example/bosses/ansurek.jpg"
  );
});

it("keeps the raid heading visible when its banner artwork fails to load", () => {
  // Break caught: a failed Blizzard image request could leave a broken-image
  // marker over the raid name instead of the text-first fallback.
  const view = renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "1273",
            raidName: "Nerub-ar Palace",
            imageUrl: "https://render.example/raids/missing.jpg",
            cuttingEdge: null,
            bosses: [{ ...boss, imageUrl: null }]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  const heading = screen.getByRole("heading", {
    level: 3,
    name: "Nerub-ar Palace"
  });
  const artwork = heading.querySelector("img");

  expect(artwork).not.toBeNull();
  fireEvent.error(artwork!);
  expect(artwork).toHaveAttribute("hidden");
  expect(heading).toBeVisible();

  view.rerender(
    <DossierCharacterProvider characters={knownCharacters}>
      <DossierRaidList
        raids={
          [
            {
              raidId: "1273",
              raidName: "Nerub-ar Palace",
              imageUrl: "https://render.example/raids/recovered.jpg",
              cuttingEdge: null,
              bosses: [{ ...boss, imageUrl: null }]
            }
          ] satisfies ApplicantDossier["raids"]
        }
      />
    </DossierCharacterProvider>
  );
  const recoveredArtwork = heading.querySelector("img");
  fireEvent.load(recoveredArtwork!);
  expect(recoveredArtwork).not.toHaveAttribute("hidden");
});

it("renders boss artwork at the enlarged intrinsic size", () => {
  // Break caught: artwork without intrinsic dimensions reserves no space, so
  // the boss name and evidence state shift as each image arrives.
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "1273",
            raidName: "Nerub-ar Palace",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [
              { ...boss, imageUrl: "https://render.example/bosses/ansurek.jpg" }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  const artwork = screen.getByRole("img", { name: "Queen Ansurek artwork" });
  expect(artwork).toHaveAttribute("width", "112");
  expect(artwork).toHaveAttribute("height", "112");
});

it("falls back to the placeholder when boss artwork fails to load", () => {
  // Break caught: a Blizzard render that 404s left a broken-image marker
  // beside the boss name, and hiding it collapsed the heading alignment.
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "1273",
            raidName: "Nerub-ar Palace",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [
              { ...boss, imageUrl: "https://render.example/bosses/missing.jpg" }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  const artwork = screen.getByRole("img", { name: "Queen Ansurek artwork" });
  expect(artwork.tagName).toBe("IMG");

  fireEvent.error(artwork);

  const fallback = screen.getByRole("img", { name: "Queen Ansurek artwork" });
  expect(fallback.tagName).toBe("svg");
  expect(fallback).toHaveClass("dossier-boss-artwork");
  expect(screen.queryByRole("img", { name: "" })).not.toBeInTheDocument();
  expect(screen.getByText("Queen Ansurek")).toBeVisible();
});

it("shows the placeholder when a boss has no catalogued artwork", () => {
  // Break caught: bosses missing upstream artwork must keep the same framed
  // slot so the evidence rows stay aligned down the raid.
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "1273",
            raidName: "Nerub-ar Palace",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [{ ...boss, imageUrl: null }]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  const fallback = screen.getByRole("img", { name: "Queen Ansurek artwork" });
  expect(fallback.tagName).toBe("svg");
  expect(fallback).toHaveClass("dossier-boss-artwork");
});

it("keeps a text-first raid heading when official artwork is unavailable", () => {
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "unmapped",
            raidName: "Unmapped raid",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [{ ...boss, imageUrl: null }]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  expect(
    screen.queryByRole("img", { name: "Unmapped raid artwork" })
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { level: 3, name: "Unmapped raid" })
  ).toBeVisible();
  expect(
    screen.getByRole("img", { name: "Queen Ansurek artwork" })
  ).toBeVisible();
  expect(screen.getByText("Queen Ansurek")).toBeVisible();
});

it("orders equal-timestamp kill evidence by report URL", async () => {
  const tieB = {
    ...boss.firstKill,
    killedAt: "2025-01-14T20:30:00.000Z",
    reportUrl: "https://www.warcraftlogs.com/reports/tie-b#fight=1"
  };
  const tieA = {
    ...boss.firstKill,
    killedAt: "2025-01-14T20:30:00.000Z",
    reportUrl: "https://www.warcraftlogs.com/reports/tie-a#fight=1"
  };

  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "tie-order",
            raidName: "Tie Order Raid",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [{ ...boss, firstKill: tieB, firstKills: [tieB, tieA] }]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  await userEvent.setup().click(screen.getByText("View kill evidence"));
  expect(
    within(screen.getByRole("region", { name: "Kill evidence" }))
      .getAllByRole("link", { name: /View Warcraft Logs report/ })
      .map((link) => link.getAttribute("href"))
  ).toEqual([
    "https://www.warcraftlogs.com/reports/tie-a#fight=1",
    "https://www.warcraftlogs.com/reports/tie-b#fight=1"
  ]);
});

it("uses the earliest sorted kill for the boss summary", () => {
  const earliest = {
    ...boss.firstKill,
    killedAt: "2025-01-14T20:30:00.000Z",
    historicWorldRank: 2,
    reportUrl: "https://www.warcraftlogs.com/reports/earliest#fight=1"
  };
  const latest = {
    ...boss.firstKill,
    killedAt: "2025-02-14T20:30:00.000Z",
    historicWorldRank: 99,
    reportUrl: "https://www.warcraftlogs.com/reports/latest#fight=2"
  };

  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "summary-order",
            raidName: "Summary Order Raid",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [
              { ...boss, firstKill: latest, firstKills: [latest, earliest] }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  expect(
    screen.getByText(
      (_, element) =>
        !!element?.classList.contains("dossier-boss-first-kill") &&
        !!element.textContent?.includes("14 Jan 2025")
    )
  ).toBeVisible();
  expect(screen.getByText("World #2")).toBeVisible();
});

it("keeps the chronological first-kill summary coherent while listing events oldest first", async () => {
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "1273",
            raidName: "Nerub-ar Palace",
            imageUrl: null,
            cuttingEdge: true,
            bosses: [
              {
                ...boss,
                imageUrl: null,
                firstKill: {
                  killedAt: "2025-01-14T20:30:00.000Z",
                  guild: {
                    name: "Earliest",
                    region: "eu",
                    realm: "Silvermoon"
                  },
                  historicWorldRank: 2,
                  reportUrl:
                    "https://www.warcraftlogs.com/reports/first#fight=8",
                  characters: [ryii],
                  parses: [
                    {
                      character: "Ryii",
                      damage: {
                        state: "available",
                        percentile: 77,
                        reportUrl:
                          "https://www.warcraftlogs.com/reports/first#fight=8"
                      },
                      healing: { state: "not_applicable" },
                      bossDamage: { state: "unavailable" }
                    }
                  ]
                },
                firstKills: [
                  {
                    killedAt: "2025-02-14T20:30:00.000Z",
                    guild: {
                      name: "Method",
                      region: "eu",
                      realm: "Tarren Mill"
                    },
                    historicWorldRank: null,
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/second#fight=9",
                    characters: [ryalts],
                    parses: [
                      {
                        character: "Ryalts",
                        damage: {
                          state: "available",
                          percentile: 99,
                          reportUrl:
                            "https://www.warcraftlogs.com/reports/second#fight=9"
                        },
                        healing: { state: "not_applicable" },
                        bossDamage: { state: "unavailable" }
                      }
                    ]
                  },
                  {
                    killedAt: "2025-01-14T20:30:00.000Z",
                    guild: {
                      name: "Method",
                      region: "eu",
                      realm: "Tarren Mill"
                    },
                    historicWorldRank: 2,
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/first#fight=8",
                    characters: [ryii],
                    parses: [
                      {
                        character: "Ryii",
                        damage: {
                          state: "available",
                          percentile: 77,
                          reportUrl:
                            "https://www.warcraftlogs.com/reports/first#fight=8"
                        },
                        healing: { state: "not_applicable" },
                        bossDamage: { state: "unavailable" }
                      }
                    ]
                  }
                ],
                bestParses: [
                  {
                    character: "Ryalts",
                    damage: {
                      state: "available",
                      percentile: 99,
                      reportUrl:
                        "https://www.warcraftlogs.com/reports/second#fight=9"
                    },
                    healing: { state: "not_applicable" },
                    bossDamage: { state: "unavailable" }
                  }
                ]
              }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  const firstKillSummary = screen
    .getByText("Ryii", {
      selector: ".dossier-boss-first-kill .dossier-character-name"
    })
    .closest(".dossier-boss-first-kill");
  expect(firstKillSummary).toHaveTextContent("First kill: 14 Jan 2025 · Ryii");
  expect(screen.getByText("World #2")).toBeVisible();
  const firstKillParses = screen
    .getAllByRole("region", { name: "First kill parses" })
    .find((region) =>
      within(region).queryByRole("link", { name: "Damage 77 percentile" })
    )!;
  expect(
    within(firstKillParses).getByRole("link", {
      name: "Damage 77 percentile"
    })
  ).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/reports/first#fight=8"
  );
  expect(
    within(firstKillParses).getByRole("group", { name: "Ryii parses" })
  ).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Best parses" })).getByRole(
      "group",
      { name: "Ryalts parses" }
    )
  ).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Best parses" })).getByRole(
      "link",
      { name: "Damage 99 percentile" }
    )
  ).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/reports/second#fight=9"
  );
  expect(screen.getByText("View kill evidence")).toBeVisible();
  await userEvent.setup().click(screen.getByText("View kill evidence"));
  const killEvidence = screen.getByRole("region", { name: "Kill evidence" });
  expect(
    within(killEvidence).getByRole("group", { name: "Ryii parses" })
  ).toBeVisible();
  expect(screen.getAllByText("First kill")).toHaveLength(1);
  expect(screen.getByText("Kill")).toBeInTheDocument();
  const evidenceRows = screen.getAllByText(/^(First kill|Kill)$/, {
    selector: "dt"
  });
  expect(evidenceRows[0]).toHaveTextContent("First kill");
  expect(evidenceRows[0]?.closest(".dossier-evidence")).toHaveClass(
    "dossier-evidence-first-kill"
  );
  expect(evidenceRows[1]).toHaveTextContent("Kill");
  expect(evidenceRows[1]?.closest(".dossier-evidence")).not.toHaveClass(
    "dossier-evidence-first-kill"
  );
  expect(
    screen.getByRole("region", { hidden: true, name: "Kill evidence" })
  ).toBeInTheDocument();

  const dates = screen
    .getAllByText(/14 (Jan|Feb) 2025/)
    .filter((date) => date.tagName === "TIME");
  expect(dates.map((date) => date.textContent)).toEqual([
    "14 Jan 2025",
    "14 Feb 2025"
  ]);
});

it("lists kill reports before inline wipe reports ordered newest to oldest", async () => {
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "wipe-order",
            raidName: "Wipe Order Raid",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [
              {
                ...boss,
                wipes: [
                  {
                    attemptedAt: "2025-01-13T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/latest#fight=4",
                    characters: [ryii]
                  },
                  {
                    attemptedAt: "2025-01-12T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/older#fight=2",
                    characters: [ryii]
                  }
                ]
              }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  await userEvent.setup().click(screen.getByText("View kill evidence"));
  const rows = screen.getAllByText(/First kill|Wipe/, { selector: "dt" });
  expect(rows.map((row) => row.textContent)).toEqual(["First kill"]);
  const reportLinks = screen
    .getByRole("region", { name: "Kill evidence" })
    .querySelectorAll<HTMLAnchorElement>(
      ".dossier-report-links a.upstream-icon-link"
    );
  expect(Array.from(reportLinks).map((link) => link.href)).toEqual([
    "https://www.warcraftlogs.com/reports/latest#fight=4",
    "https://www.warcraftlogs.com/reports/older#fight=2"
  ]);
  expect(reportLinks[0]).toHaveClass("upstream-icon-link--evidence-wipe");
  expect(reportLinks[1]).toHaveClass("upstream-icon-link--evidence-wipe");
  expect(
    screen.getAllByRole("img", { name: "Verified Mythic kill" })
  ).not.toHaveLength(0);
});

it("groups multiple wipes after each corresponding kill report", async () => {
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "grouped-wipes",
            raidName: "Grouped Wipes Raid",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [
              {
                ...boss,
                firstKill: {
                  ...boss.firstKill,
                  killedAt: "2025-01-10T20:30:00.000Z",
                  reportUrl:
                    "https://www.warcraftlogs.com/reports/first#fight=8"
                },
                firstKills: [
                  {
                    ...boss.firstKill,
                    killedAt: "2025-01-10T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/first#fight=8"
                  },
                  {
                    ...boss.firstKill,
                    killedAt: "2025-01-20T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/second#fight=9"
                  }
                ],
                wipes: [
                  {
                    attemptedAt: "2025-01-19T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/progression#fight=7",
                    characters: [ryii]
                  },
                  {
                    attemptedAt: "2025-01-05T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/early#fight=6",
                    characters: [ryii]
                  },
                  {
                    attemptedAt: "2025-01-19T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/progression#fight=8",
                    characters: [ryii]
                  },
                  {
                    attemptedAt: "2025-01-20T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/second#fight=10",
                    characters: [ryii]
                  }
                ]
              }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  await userEvent.setup().click(screen.getByText("View kill evidence"));
  const evidence = screen.getByRole("region", {
    name: "Kill evidence"
  });
  const rows = within(evidence).getAllByText(/First kill|Kill|Wipe/, {
    selector: "dt"
  });

  expect(rows.map((row) => row.textContent)).toEqual(["First kill", "Kill"]);
  expect(
    within(evidence).getAllByRole("link", {
      name: "View Warcraft Logs wipe report (opens in a new tab)"
    })
  ).toHaveLength(2);
  const evidenceRows = Array.from(
    evidence.querySelectorAll<HTMLElement>(".dossier-evidence-row")
  );
  expect(
    Array.from(
      evidenceRows[0]!.querySelectorAll<HTMLAnchorElement>(
        ".dossier-report-links a.upstream-icon-link"
      )
    ).map((link) => link.getAttribute("href"))
  ).toEqual([
    "https://www.warcraftlogs.com/reports/first#fight=8",
    "https://www.warcraftlogs.com/reports/early#fight=6"
  ]);
  expect(
    Array.from(
      evidenceRows[1]!.querySelectorAll<HTMLAnchorElement>(
        ".dossier-report-links a.upstream-icon-link"
      )
    ).map((link) => link.getAttribute("href"))
  ).toEqual([
    "https://www.warcraftlogs.com/reports/second#fight=9",
    "https://www.warcraftlogs.com/reports/progression#fight=8"
  ]);
  expect(
    within(evidence).getAllByRole("link", {
      name: "View Warcraft Logs report (opens in a new tab)"
    })
  ).toHaveLength(2);
  expect(
    within(evidence).getAllByRole("link", {
      name: "View Warcraft Logs wipe report (opens in a new tab)"
    })
  ).toHaveLength(2);
  expect(
    within(evidence).getAllByRole("img", { name: "Verified Mythic kill" })
  ).toHaveLength(2);
});

it("renders kill, wipe, no-log, and incomplete states with accessible labels", async () => {
  renderWithDossierCharacters(
    <DossierRaidList
      raids={[
        {
          raidId: "mixed",
          raidName: "Mixed Evidence Raid",
          imageUrl: null,
          cuttingEdge: null,
          bosses: [
            { ...boss, bossId: "kill", bossOrder: 1 },
            {
              bossId: "wipe",
              bossName: "Wipe Boss",
              bossOrder: 2,
              imageUrl: null,
              state: "wipe",
              wipe: {
                attemptedAt: "2025-02-14T20:30:00.000Z",
                reportUrl: "https://www.warcraftlogs.com/reports/wipe#fight=12",
                characters: [
                  { region: "eu", realm: "silvermoon", name: "ryii" },
                  { region: "eu", realm: "draenor", name: "ryalts" }
                ]
              },
              wipes: [
                {
                  attemptedAt: "2025-02-14T20:30:00.000Z",
                  reportUrl:
                    "https://www.warcraftlogs.com/reports/wipe#fight=12",
                  characters: [
                    { region: "eu", realm: "silvermoon", name: "ryii" },
                    { region: "eu", realm: "draenor", name: "ryalts" }
                  ]
                }
              ]
            },
            {
              bossId: "no-logs",
              bossName: "No Logs Boss",
              bossOrder: 3,
              imageUrl: null,
              state: "no_logs"
            },
            {
              bossId: "incomplete",
              bossName: "Incomplete Boss",
              bossOrder: 4,
              imageUrl: null,
              state: "incomplete"
            }
          ]
        }
      ]}
    />
  );

  expect(
    screen.getAllByRole("img", { name: "Verified Mythic kill" })[0]
  ).toBeVisible();
  expect(
    screen.getAllByRole("img", { name: "Mythic wipe found" })[0]
  ).toBeVisible();
  expect(
    screen.getByRole("img", { name: "No qualifying public logs found" })
  ).toBeVisible();
  expect(
    screen.getByText("No qualifying public logs found", { selector: "p" })
  ).toBeVisible();
  expect(screen.getByText("Evidence incomplete")).toBeVisible();
  expect(
    screen.getByText(
      (_, element) =>
        element?.tagName === "P" &&
        /Wipe found: 14 Feb 2025 · Ryii.*Ryalts/.test(element.textContent ?? "")
    )
  ).toBeVisible();
  await userEvent.setup().click(screen.getByText("View wipe evidence"));
  expect(
    screen.getByRole("link", {
      name: "View Warcraft Logs wipe report (opens in a new tab)"
    })
  ).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/reports/wipe#fight=12"
  );
});

it("orders wipe-only evidence newest first with a stable tie-break", async () => {
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "wipe-only-order",
            raidName: "Wipe Only Raid",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [
              {
                bossId: "wipe-only",
                bossName: "Wipe Only Boss",
                bossOrder: 1,
                imageUrl: null,
                state: "wipe",
                wipe: {
                  attemptedAt: "2025-02-10T20:30:00.000Z",
                  reportUrl:
                    "https://www.warcraftlogs.com/reports/tie-a#fight=1",
                  characters: [ryii]
                },
                wipes: [
                  {
                    attemptedAt: "2025-02-09T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/older#fight=2",
                    characters: [ryii]
                  },
                  {
                    attemptedAt: "2025-02-10T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/tie-b#fight=1",
                    characters: [ryii]
                  },
                  {
                    attemptedAt: "2025-02-10T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/tie-a#fight=1",
                    characters: [ryii]
                  }
                ]
              }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  await userEvent.setup().click(screen.getByText("View wipe evidence"));
  const evidence = screen.getByRole("region", { name: "Wipe evidence" });
  expect(
    within(evidence).getByRole("link", {
      name: "View Warcraft Logs wipe report (opens in a new tab)"
    })
  ).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/reports/older#fight=2"
  );
  await userEvent.click(
    within(evidence).getByRole("button", {
      name: "Choose from 2 wipe reports"
    })
  );
  expect(
    screen
      .getAllByRole("link", { name: /log uploaded by/ })
      .map((link) => link.getAttribute("href"))
  ).toEqual([
    "https://www.warcraftlogs.com/reports/tie-b#fight=1",
    "https://www.warcraftlogs.com/reports/tie-a#fight=1"
  ]);
});

it("merges wipe rows on the same date and deduplicates reports", async () => {
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "merged-wipes",
            raidName: "Merged Wipes Raid",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [
              {
                bossId: "merged-wipe-boss",
                bossName: "Merged Wipe Boss",
                bossOrder: 1,
                imageUrl: null,
                state: "wipe",
                wipe: {
                  attemptedAt: "2025-02-14T20:30:00.000Z",
                  reportUrl:
                    "https://www.warcraftlogs.com/reports/shared#fight=1",
                  characters: [ryii]
                },
                wipes: [
                  {
                    attemptedAt: "2025-02-14T20:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/shared#fight=1",
                    characters: [ryii]
                  },
                  {
                    attemptedAt: "2025-02-14T21:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/shared#fight=2",
                    characters: [ryalts]
                  },
                  {
                    attemptedAt: "2025-02-14T22:30:00.000Z",
                    reportUrl:
                      "https://www.warcraftlogs.com/reports/other#fight=3",
                    characters: [ryii]
                  }
                ]
              }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  await userEvent.setup().click(screen.getByText("View wipe evidence"));
  const evidence = screen.getByRole("region", { name: "Wipe evidence" });
  expect(evidence.querySelectorAll(".dossier-evidence-row")).toHaveLength(1);
  expect(within(evidence).getByText("14 Feb 2025")).toBeVisible();
  await userEvent.click(
    within(evidence).getByRole("button", {
      name: "Choose from 2 wipe reports"
    })
  );
  expect(
    screen
      .getAllByRole("link", { name: /log uploaded by/ })
      .map((link) => link.getAttribute("href"))
  ).toEqual([
    "https://www.warcraftlogs.com/reports/other#fight=3",
    "https://www.warcraftlogs.com/reports/shared#fight=2"
  ]);
  expect(within(evidence).getByText("Ryii")).toBeVisible();
  expect(within(evidence).getByText("Ryalts")).toBeVisible();
});

it("greys out an entire no-log tier as a single explanatory row", () => {
  render(
    <DossierRaidList
      raids={[
        {
          raidId: "empty-tier",
          raidName: "Empty Tier",
          imageUrl: "https://render.example/raids/empty.jpg",
          cuttingEdge: null,
          bosses: [
            {
              bossId: "one",
              bossName: "First Boss",
              bossOrder: 1,
              imageUrl: null,
              state: "no_logs"
            },
            {
              bossId: "two",
              bossName: "Second Boss",
              bossOrder: 2,
              imageUrl: null,
              state: "no_logs"
            }
          ]
        }
      ]}
    />
  );

  const row = screen.getByRole("group", { name: "Empty Tier evidence" });
  expect(row).toHaveClass("dossier-raid-no-logs");
  expect(
    within(row).getByRole("heading", { name: "Empty Tier" })
  ).toBeVisible();
  expect(within(row).getByText("No logs found")).toBeVisible();
  expect(
    within(row).getByText(
      "No qualifying public logs found; this does not prove no attempt."
    )
  ).toBeVisible();
  expect(within(row).queryByRole("article")).not.toBeInTheDocument();
  expect(
    within(row).queryByAltText("Empty Tier artwork")
  ).not.toBeInTheDocument();
});

it("shows first-kill and best parse summaries before evidence details are opened", () => {
  // Break caught: meaningful parse evidence could be buried behind the
  // disclosure, preventing a reviewer from comparing a boss at a glance.
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "1273",
            raidName: "Nerub-ar Palace",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [
              {
                ...boss,
                imageUrl: null,
                firstKill: {
                  ...boss.firstKill,
                  parses: [
                    {
                      character: "Ryii",
                      damage: {
                        state: "available",
                        percentile: 87,
                        reportUrl:
                          "https://www.warcraftlogs.com/reports/first#fight=8"
                      },
                      healing: { state: "not_applicable" },
                      bossDamage: { state: "unavailable" }
                    }
                  ]
                },
                bestParses: [
                  {
                    character: "Ryii",
                    damage: {
                      state: "available",
                      percentile: 99.2,
                      reportUrl:
                        "https://www.warcraftlogs.com/reports/best#fight=9"
                    },
                    healing: { state: "not_applicable" },
                    bossDamage: { state: "unavailable" }
                  }
                ]
              }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  const firstKillParses = screen.getAllByRole("region", {
    name: "First kill parses"
  })[0]!;
  expect(firstKillParses.closest("details")).toBeNull();
  expect(firstKillParses).toBeVisible();
  const bestParses = screen.getByRole("region", {
    name: "Best parses"
  });
  expect(bestParses).toBeVisible();
  expect(
    within(firstKillParses).getByRole("link", {
      name: "Damage 87 percentile"
    })
  ).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/reports/first#fight=8"
  );
  expect(
    within(firstKillParses).getByRole("group", { name: "Ryii parses" })
  ).toBeVisible();
  expect(
    within(bestParses).getByRole("link", { name: "Damage 99.2 percentile" })
  ).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/reports/best#fight=9"
  );
  expect(
    within(bestParses).getByRole("group", { name: "Ryii parses" })
  ).toBeVisible();
  expect(
    screen.getByText("View kill evidence").closest("details")
  ).not.toHaveAttribute("open");
  screen.getByText("View kill evidence").click();
  const eventParses = within(
    screen.getByRole("region", { name: "Kill evidence" })
  ).getByRole("region", { name: "First kill parses" });
  expect(
    within(eventParses).getByRole("link", { name: "Damage 87 percentile" })
  ).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/reports/first#fight=8"
  );
  expect(
    within(eventParses).getByRole("group", { name: "Ryii parses" })
  ).toBeVisible();
});

it("lists bosses within a raid last-to-first, with the raid order untouched", () => {
  renderWithDossierCharacters(
    <DossierRaidList
      raids={
        [
          {
            raidId: "1273",
            raidName: "Nerub-ar Palace",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [
              { ...boss, bossId: "1", bossName: "Ulgrax the Devourer" },
              { ...boss, bossId: "2", bossName: "The Bloodbound Horror" },
              { ...boss, bossId: "3", bossName: "Queen Ansurek" }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  expect(
    screen
      .getAllByRole("group", { name: /evidence$/ })
      .map((group) => group.getAttribute("aria-label"))
  ).toEqual([
    "Queen Ansurek evidence",
    "The Bloodbound Horror evidence",
    "Ulgrax the Devourer evidence"
  ]);
});
