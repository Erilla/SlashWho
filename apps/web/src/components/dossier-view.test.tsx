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

import { DossierPageClient } from "../app/dossiers/[region]/[realm]/[name]/dossier-page-client";

const dossier: ApplicantDossier = {
  root: { region: "eu", realm: "silvermoon", name: "ryii" },
  characters: [
    {
      key: { region: "eu", realm: "silvermoon", name: "ryii" },
      displayName: "Ryii",
      source: "raiderio_declared"
    },
    {
      key: { region: "eu", realm: "draenor", name: "ryalts" },
      displayName: "Ryalts",
      source: "fingerprint_derived"
    }
  ],
  raids: [
    {
      raidId: "nerub-ar-palace",
      raidName: "Nerub-ar Palace",
      cuttingEdge: true,
      bosses: [
        {
          bossId: "ansurek",
          bossName: "Queen Ansurek",
          bossOrder: 8,
          firstKill: {
            killedAt: "2025-01-14T20:30:00.000Z",
            guild: { name: "Arachnid", realm: "Silvermoon" },
            historicWorldRank: 147,
            reportUrl: "https://www.warcraftlogs.com/reports/abc123",
            characters: ["Ryii", "Ryalts"]
          }
        },
        {
          bossId: "sikran",
          bossName: "Sikran",
          bossOrder: 5,
          firstKill: {
            killedAt: "2025-01-10T20:30:00.000Z",
            guild: null,
            historicWorldRank: null,
            reportUrl: null,
            characters: ["Ryii"]
          }
        }
      ]
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

describe("DossierPageClient", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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
    expect(screen.getByText("Queen Ansurek")).toBeVisible();
    expect(screen.getByText("World #147")).toBeVisible();
    expect(screen.getByText("Raider.IO declared")).toBeVisible();
    expect(screen.getByText("Fingerprint-derived")).toBeVisible();
    expect(
      screen.getByText(/Warcraft Logs evidence is incomplete/i)
    ).toBeVisible();

    const evidence = screen.getByRole("group", {
      name: "Queen Ansurek evidence"
    });
    expect(
      within(evidence).getByRole("link", { name: "View Warcraft Logs report" })
    ).toHaveAttribute("href", "https://www.warcraftlogs.com/reports/abc123");
    await userEvent
      .setup()
      .click(
        within(screen.getByText("Sikran").closest("article")!).getByText(
          "View first-kill evidence"
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
