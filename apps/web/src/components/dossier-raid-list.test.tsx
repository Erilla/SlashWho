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
    characters: [ryii]
  }
};

afterEach(cleanup);

it("shows the grouped rank in the summary and retains all distinct report links", () => {
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
  expect(
    screen
      .getAllByRole("link", { hidden: true })
      .map((link) => link.getAttribute("href"))
      .filter((href) => href?.includes("/reports/"))
  ).toEqual(reportUrls);
  for (const [index, link] of screen
    .getAllByRole("link", {
      hidden: true,
      name: /View Warcraft Logs report \d+ \(opens in a new tab\)/
    })
    .entries()) {
    expect(link).toHaveAccessibleName(
      `View Warcraft Logs report ${index + 1} (opens in a new tab)`
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      link.querySelector(".upstream-link-icon--warcraft-logs")
    ).toBeInTheDocument();
  }
  expect(screen.getAllByText("First kill")).toHaveLength(1);
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

it("shows latest-kill metadata and lists every kill latest first", () => {
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
                firstKills: [
                  {
                    killedAt: "2025-02-14T20:30:00.000Z",
                    guild: {
                      name: "Method",
                      region: "eu",
                      realm: "Tarren Mill"
                    },
                    historicWorldRank: null,
                    reportUrl: "https://www.warcraftlogs.com/reports/second",
                    characters: [ryalts]
                  },
                  {
                    killedAt: "2025-01-14T20:30:00.000Z",
                    guild: {
                      name: "Method",
                      region: "eu",
                      realm: "Tarren Mill"
                    },
                    historicWorldRank: 2,
                    reportUrl: "https://www.warcraftlogs.com/reports/first",
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

  const firstKillSummary = screen
    .getByText("Ryalts", {
      selector: ".dossier-boss-first-kill .dossier-character-name"
    })
    .closest(".dossier-boss-first-kill");
  expect(firstKillSummary).toHaveTextContent(
    "First kill: 14 Feb 2025 · Ryalts"
  );
  expect(screen.getByText("View kill evidence")).toBeVisible();
  expect(screen.getAllByText("First kill")).toHaveLength(1);
  expect(screen.getByText("Kill")).toBeInTheDocument();
  const evidenceRows = screen.getAllByText(/^(First kill|Kill)$/, {
    selector: "dt"
  });
  expect(evidenceRows[0]?.closest(".dossier-evidence")).toHaveClass(
    "dossier-evidence-first-kill"
  );
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
    "14 Feb 2025",
    "14 Jan 2025"
  ]);
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
              }
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
    screen.getByRole("img", { name: "Verified Mythic kill" })
  ).toBeVisible();
  expect(screen.getByRole("img", { name: "Mythic wipe found" })).toBeVisible();
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
