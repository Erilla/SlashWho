// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicantDossier } from "@slashwho/contracts";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push })
}));

import { DossierPageClient } from "../app/dossiers/[region]/[realm]/[name]/dossier-page-client";

const dossier: ApplicantDossier = {
  root: { region: "eu", realm: "silvermoon", name: "ryii" },
  research: {
    state: "complete",
    message: "Linked-character research is complete."
  },
  characters: [
    {
      key: { region: "eu", realm: "silvermoon", name: "ryii" },
      displayName: "Ryii",
      className: "Mage",
      raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
      source: "raiderio_declared"
    },
    {
      key: { region: "eu", realm: "draenor", name: "ryalts" },
      displayName: "Ryalts",
      className: "Priest",
      raiderIoUrl: "https://raider.io/characters/eu/draenor/ryalts",
      source: "fingerprint_derived"
    }
  ],
  raids: [
    {
      raidId: "nerub-ar-palace",
      raidName: "Nerub-ar Palace",
      imageUrl: null,
      cuttingEdge: true,
      bosses: [
        {
          bossId: "ansurek",
          bossName: "Queen Ansurek",
          bossOrder: 8,
          imageUrl: null,
          state: "kill",
          firstKill: {
            killedAt: "2025-01-14T20:30:00.000Z",
            guild: { name: "Arachnid", region: "eu", realm: "Silvermoon" },
            historicWorldRank: 147,
            reportUrl: "https://www.warcraftlogs.com/reports/abc123",
            characters: [
              { region: "eu", realm: "silvermoon", name: "ryii" },
              { region: "eu", realm: "draenor", name: "ryalts" }
            ],
            parses: []
          },
          bestParses: []
        },
        {
          bossId: "sikran",
          bossName: "Sikran",
          bossOrder: 5,
          imageUrl: null,
          state: "kill",
          firstKill: {
            killedAt: "2025-01-10T20:30:00.000Z",
            guild: null,
            historicWorldRank: null,
            reportUrl: null,
            characters: [{ region: "eu", realm: "silvermoon", name: "ryii" }],
            parses: []
          },
          bestParses: []
        }
      ]
    }
  ],
  cuttingEdges: [
    {
      achievementId: "40254",
      achievementName: "Cutting Edge: Queen Ansurek",
      description:
        "Defeat Queen Ansurek in Nerub-ar Palace on Mythic Difficulty.",
      iconUrl: null,
      completedAt: "2025-01-14T20:30:00.000Z"
    }
  ],
  limitations: [
    {
      source: "warcraft_logs",
      character: { region: "eu", realm: "draenor", name: "ryalts" },
      code: "unavailable",
      message:
        "Warcraft Logs evidence is incomplete because the source is temporarily unavailable."
    }
  ]
};

const sameNamedPriest: ApplicantDossier["characters"][number] = {
  key: { region: "us", realm: "illidan", name: "ryii" },
  displayName: "Ryii",
  className: "Priest",
  raiderIoUrl: "https://raider.io/characters/us/illidan/ryii",
  source: "fingerprint_derived" as const
};

const sameNamedDossier: ApplicantDossier = {
  ...dossier,
  characters: [dossier.characters[0]!, sameNamedPriest],
  raids: [
    {
      ...dossier.raids[0]!,
      bosses: dossier.raids[0]!.bosses.slice(0, 1).map((boss) => {
        if (boss.state !== "kill") return boss;
        return {
          ...boss,
          firstKill: {
            ...boss.firstKill,
            characters: [dossier.root]
          },
          firstKills: [
            {
              ...boss.firstKill,
              characters: [dossier.root]
            },
            {
              ...boss.firstKill,
              killedAt: "2025-01-15T20:30:00.000Z",
              characters: [sameNamedPriest.key]
            }
          ]
        };
      })
    }
  ],
  cuttingEdges: [
    {
      ...dossier.cuttingEdges[0]!
    }
  ],
  limitations: [
    {
      ...dossier.limitations[0]!,
      character: sameNamedPriest.key
    }
  ]
};

describe("DossierPageClient", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    push.mockReset();
  });

  it("renders source-labelled characters, historic evidence, and every limitation", async () => {
    // Break caught: a dossier could flatten evidence, omit provenance, or hide an
    // unavailable source that explains why a field has no value.
    render(
      <DossierPageClient
        identity={dossier.root}
        initialDossier={dossier}
        jobId={null}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Historic Cutting Edge" })
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Historic Mythic boss evidence" })
    ).toBeVisible();
    expect(screen.getByText("Queen Ansurek")).toBeVisible();
    expect(screen.getByText("World #147")).toBeVisible();
    expect(screen.getByText("Raider.IO declared")).toBeVisible();
    expect(screen.getByText("Fingerprint-derived")).toBeVisible();
    const dossierHeader = screen
      .getByRole("heading", { level: 1 })
      .closest("header")!;
    expect(
      within(dossierHeader).getByRole("link", {
        name: "View Ryii on Raider.IO (opens in a new tab)"
      })
    ).toHaveAttribute(
      "href",
      "https://raider.io/characters/eu/silvermoon/ryii"
    );
    expect(
      within(dossierHeader).getByRole("link", {
        name: "View Ryii on Warcraft Logs (opens in a new tab)"
      })
    ).toHaveAttribute(
      "href",
      "https://www.warcraftlogs.com/character/eu/silvermoon/ryii"
    );
    const connectedCharacters = screen.getByRole("region", {
      name: "Connected characters"
    });
    expect(
      within(connectedCharacters).queryByRole("link", {
        name: "View Ryii on Raider.IO (opens in a new tab)"
      })
    ).not.toBeInTheDocument();
    expect(
      within(connectedCharacters).getByRole("link", {
        name: "View Ryalts on Raider.IO (opens in a new tab)"
      })
    ).toHaveAttribute("href", "https://raider.io/characters/eu/draenor/ryalts");
    const limitation = screen
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes("Warcraft Logs evidence"));
    expect(limitation).toHaveTextContent(
      /Warcraft Logs evidence is incomplete.*Affected character: Ryalts\./i
    );

    const evidence = screen.getByRole("group", {
      name: "Queen Ansurek evidence"
    });
    expect(
      within(evidence).getByRole("link", {
        name: "View Warcraft Logs report (opens in a new tab)"
      })
    ).toHaveAttribute("href", "https://www.warcraftlogs.com/reports/abc123");
    expect(
      within(evidence).getByRole("link", {
        name: "View Arachnid on Warcraft Logs (opens in a new tab)"
      })
    ).toHaveAttribute(
      "href",
      "https://www.warcraftlogs.com/guild/eu/Silvermoon/Arachnid"
    );
    await userEvent
      .setup()
      .click(
        within(screen.getByText("Sikran").closest("article")!).getByText(
          "View kill evidence"
        )
      );
    expect(
      within(screen.getByText("Sikran").closest("article")!).getByText(
        "Guild: —"
      )
    ).toBeVisible();
    expect(
      within(screen.getByText("Sikran").closest("article")!).getAllByText(
        "World rank: —"
      )[0]
    ).toBeVisible();
    expect(
      within(screen.getByText("Sikran").closest("article")!).getByText(
        "Report: —"
      )
    ).toBeVisible();
  });

  it("uses known classes for every visible character-name mention", () => {
    // Break caught: evidence summaries, details, attribution, or limitation copy
    // can bypass the shared character-name renderer and lose class colouring.
    render(
      <DossierPageClient
        identity={dossier.root}
        initialDossier={dossier}
        jobId={null}
      />
    );

    const mageMentions = screen.getAllByText("Ryii");
    const priestMentions = screen.getAllByText("Ryalts");

    expect(mageMentions).toHaveLength(6);
    expect(priestMentions).toHaveLength(4);
    for (const mention of mageMentions) {
      expect(mention).toHaveClass("dossier-character-name--mage");
    }
    for (const mention of priestMentions) {
      expect(mention).toHaveClass("dossier-character-name--priest");
    }
  });

  it("resolves each dossier character mention by canonical key", () => {
    // Break caught: duplicate display names can cause a participant reference to
    // borrow a different connected character's class instead of using its key.
    render(
      <DossierPageClient
        identity={sameNamedDossier.root}
        initialDossier={sameNamedDossier}
        jobId={null}
      />
    );

    expect(
      within(screen.getByRole("heading", { level: 1 })).getByText("Ryii")
    ).toHaveClass("dossier-character-name--mage");

    const connectedCharacters = screen.getByRole("region", {
      name: "Connected characters"
    });
    const connectedMentions = within(connectedCharacters).getAllByText("Ryii");
    expect(connectedMentions[0]).toHaveClass("dossier-character-name--mage");
    expect(connectedMentions[1]).toHaveClass("dossier-character-name--priest");

    const firstKill = document.querySelector<HTMLParagraphElement>(
      ".dossier-boss-first-kill"
    )!;
    expect(within(firstKill).getByText("Ryii")).toHaveClass(
      "dossier-character-name--mage"
    );

    const evidenceDefinitions =
      document.querySelectorAll<HTMLDListElement>(".dossier-evidence");
    expect(within(evidenceDefinitions[1]!).getByText("Ryii")).toHaveClass(
      "dossier-character-name--priest"
    );

    const limitation = screen
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes("Warcraft Logs evidence"))!;
    expect(within(limitation).getByText("Ryii")).toHaveClass(
      "dossier-character-name--priest"
    );
  });

  it("polls the dossier-scoped research status endpoint", async () => {
    // Break caught: an in-flight dossier could poll the retired versioned API.
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        status: "complete",
        error: null
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DossierPageClient
        identity={dossier.root}
        initialDossier={null}
        jobId="ca3ccfdf-1e8b-49b1-9729-459f42a104c0"
      />
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/dossiers/jobs/ca3ccfdf-1e8b-49b1-9729-459f42a104c0",
        expect.any(Object)
      );
    });
  });
});
