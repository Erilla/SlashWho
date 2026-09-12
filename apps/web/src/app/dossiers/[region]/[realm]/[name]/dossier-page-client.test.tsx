// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicantDossier, CharacterKey } from "@slashwho/contracts";

import { DossierPageClient } from "./dossier-page-client";

const identity: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "ryii"
};
const jobId = "ca3ccfdf-1e8b-49b1-9729-459f42a104c0";
const dossierPath = "/api/dossiers/eu/silvermoon/ryii";

function dossier(
  state: ApplicantDossier["research"]["state"],
  message: string,
  raidName: string
): ApplicantDossier {
  return {
    root: identity,
    research: { state, message },
    characters: [
      {
        key: identity,
        displayName: "Ryii",
        source: "raiderio_declared"
      }
    ],
    raids: [
      {
        raidId: raidName.toLowerCase().replaceAll(" ", "-"),
        raidName,
        cuttingEdge: true,
        bosses: [
          {
            bossId: "boss",
            bossName: `${raidName} boss`,
            bossOrder: 1,
            firstKill: {
              killedAt: "2025-01-14T20:30:00.000Z",
              guild: null,
              historicWorldRank: null,
              reportUrl: null,
              characters: ["Ryii"]
            }
          }
        ]
      }
    ],
    limitations: []
  };
}

const initial = dossier(
  "initial",
  "Linked-character research is still running; this evidence covers only the submitted character.",
  "Initial evidence"
);
const expanded = dossier(
  "complete",
  "Linked-character research is complete.",
  "Expanded evidence"
);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DossierPageClient staged research", () => {
  it("shows initial evidence while queued research polls, then replaces it after completion", async () => {
    // Break caught: polling could be skipped as soon as initial evidence exists,
    // leaving a root-only dossier visible after linked-character research finishes.
    vi.useFakeTimers();
    let statusCalls = 0;
    const fetchMock = vi.fn((input: string) => {
      if (input === `${dossierPath}?scope=initial`) {
        return Promise.resolve(Response.json(initial));
      }
      if (input === `/api/dossiers/jobs/${jobId}`) {
        statusCalls += 1;
        return Promise.resolve(
          Response.json({
            status: statusCalls === 1 ? "queued" : "complete",
            error: null
          })
        );
      }
      if (input === dossierPath)
        return Promise.resolve(Response.json(expanded));
      return Promise.reject(new Error(`Unexpected request: ${input}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DossierPageClient
        identity={identity}
        initialDossier={null}
        jobId={jobId}
      />
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Initial evidence")).toBeVisible();
    expect(
      screen.getByText(initial.research.message).closest("[aria-live]")
    ).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByText("Expanded evidence")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Expanded evidence")).toBeVisible();
    expect(screen.queryByText("Initial evidence")).not.toBeInTheDocument();
  });

  it("keeps initial evidence visible when linked-character research fails", async () => {
    // Break caught: a failed background job could clear valid root-character
    // evidence instead of reporting the research failure separately.
    const fetchMock = vi.fn((input: string) => {
      if (input === `${dossierPath}?scope=initial`) {
        return Promise.resolve(Response.json(initial));
      }
      if (input === `/api/dossiers/jobs/${jobId}`) {
        return Promise.resolve(
          Response.json({
            status: "failed",
            error: { code: "upstream_unavailable", message: "Research failed." }
          })
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${input}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DossierPageClient
        identity={identity}
        initialDossier={null}
        jobId={jobId}
      />
    );

    expect(await screen.findByText("Initial evidence")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Research failed.");
  });

  it("keeps expanded evidence when the initial response arrives after completion", async () => {
    // Break caught: a slow initial request could overwrite the completed
    // snapshot-backed dossier after polling has already replaced it.
    let resolveInitial: (response: Response) => void;
    const initialResponse = new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    });
    const fetchMock = vi.fn((input: string) => {
      if (input === `${dossierPath}?scope=initial`) return initialResponse;
      if (input === `/api/dossiers/jobs/${jobId}`) {
        return Promise.resolve(
          Response.json({ status: "complete", error: null })
        );
      }
      if (input === dossierPath)
        return Promise.resolve(Response.json(expanded));
      return Promise.reject(new Error(`Unexpected request: ${input}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DossierPageClient
        identity={identity}
        initialDossier={null}
        jobId={jobId}
      />
    );

    expect(await screen.findByText("Expanded evidence")).toBeVisible();

    await act(async () => {
      resolveInitial!(Response.json(initial));
    });

    expect(screen.getByText("Expanded evidence")).toBeVisible();
    expect(screen.queryByText("Initial evidence")).not.toBeInTheDocument();
  });
});
