// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicantDossier, CharacterKey } from "@slashwho/contracts";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push })
}));

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
        className: "Mage",
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
        source: state === "initial" ? "submitted" : "raiderio_declared"
      }
    ],
    raids: [
      {
        raidId: raidName.toLowerCase().replaceAll(" ", "-"),
        raidName,
        imageUrl: null,
        cuttingEdge: true,
        bosses: [
          {
            bossId: "boss",
            bossName: `${raidName} boss`,
            bossOrder: 1,
            imageUrl: null,
            state: "kill",
            firstKill: {
              killedAt: "2025-01-14T20:30:00.000Z",
              guild: null,
              historicWorldRank: null,
              reportUrl: null,
              characters: [identity]
            }
          }
        ]
      }
    ],
    cuttingEdges: [],
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
  push.mockReset();
});

describe("DossierPageClient staged research", () => {
  it("shows a reusable dossier search form", () => {
    render(
      <DossierPageClient
        identity={identity}
        initialDossier={expanded}
        jobId={null}
      />
    );

    expect(
      screen.getByRole("group", { name: "Search mode" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Applicant URL" })
    ).toBeInTheDocument();
  });

  it("shows a loading indicator while applicant research is in progress", () => {
    // Break caught: an in-progress dossier could show only static text, making
    // it unclear that background research is still active.
    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));

    render(
      <DossierPageClient
        identity={identity}
        initialDossier={null}
        jobId={jobId}
      />
    );

    const status = screen.getByRole("status");
    expect(status).toBeVisible();
    expect(status).toHaveTextContent("Researching applicant dossier…");
    expect(status.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
  });

  it("starts linked research for a direct visit, then shows initial evidence", async () => {
    // Break caught: a direct visit lacked the job identifier required to poll
    // linked-character research, leaving it permanently root-only.
    vi.stubGlobal("fetch", (input: string) => {
      if (input === dossierPath) {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "discovery_not_ready",
                message: "Discovery is still in progress."
              }
            },
            { status: 409 }
          )
        );
      }
      if (input === "/api/dossiers") {
        return Promise.resolve(
          Response.json(
            { kind: "job", jobId, status: "queued" },
            { status: 202 }
          )
        );
      }
      if (input === `${dossierPath}?scope=initial`) {
        return Promise.resolve(Response.json(initial));
      }
      if (input === `/api/dossiers/jobs/${jobId}`)
        return new Promise<Response>(() => undefined);
      return Promise.reject(new Error(`Unexpected request: ${input}`));
    });

    render(
      <DossierPageClient
        identity={identity}
        initialDossier={null}
        jobId={null}
      />
    );

    expect(await screen.findByText("Initial evidence")).toBeVisible();
    expect(screen.getByText(/research is still running/i)).toBeVisible();
    expect(
      screen.queryByText("Loading applicant dossier…")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a start failure for a direct visit", async () => {
    // Break caught: a failed direct-start request could be hidden behind
    // partial dossier evidence or a persistent loading indicator.
    vi.stubGlobal("fetch", (input: string) => {
      if (input === dossierPath) {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "discovery_not_ready",
                message: "Discovery is still in progress."
              }
            },
            { status: 409 }
          )
        );
      }
      if (input === "/api/dossiers") {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "search_failed",
                message: "The dossier request conflicted."
              }
            },
            { status: 409 }
          )
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${input}`));
    });

    render(
      <DossierPageClient
        identity={identity}
        initialDossier={null}
        jobId={null}
      />
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The dossier request conflicted."
    );
    expect(
      screen.queryByText("Loading applicant dossier…")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Initial evidence")).not.toBeInTheDocument();
  });

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
    expect(screen.getByText("Submitted character")).toBeVisible();
    expect(screen.queryByText("Raider.IO declared")).not.toBeInTheDocument();
    expect(
      screen.getByText(initial.research.message).closest("[aria-live]")
    ).toHaveAttribute("aria-live", "polite");
    expect(
      screen
        .getByText(initial.research.message)
        .closest(".dossier-status")
        ?.querySelector('svg[aria-hidden="true"]')
    ).toBeInTheDocument();
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
    expect(
      screen.queryByText(/research is still running/i)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/research failed;.*only the submitted character/i)
    ).toBeVisible();
  });

  it("discloses failed research when root evidence arrives after the job failure", async () => {
    // Break caught: a late initial response can reintroduce a running disclosure after failure.
    let resolveInitial!: (response: Response) => void;
    const initialResponse = new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    });
    vi.stubGlobal("fetch", (input: string) => {
      if (input === `${dossierPath}?scope=initial`) return initialResponse;
      return Promise.resolve(
        Response.json({
          status: "failed",
          error: { code: "upstream_unavailable", message: "Research failed." }
        })
      );
    });
    render(
      <DossierPageClient
        identity={identity}
        initialDossier={null}
        jobId={jobId}
      />
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Research failed."
    );
    await act(async () => {
      resolveInitial(Response.json(initial));
    });
    expect(screen.getByText("Initial evidence")).toBeVisible();
    expect(
      screen.queryByText(/research is still running/i)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/research failed;.*only the submitted character/i)
    ).toBeVisible();
  });

  it.each([
    ["HTTP", "before"],
    ["schema", "before"],
    ["network", "before"],
    ["HTTP", "after"],
    ["schema", "after"],
    ["network", "after"]
  ])(
    "discards an initial %s failure %s successful expansion",
    async (failure, timing) => {
      // Break caught: initial errors can survive expansion or arrive after the expanded dossier.
      let resolveInitial!: (response: Response) => void;
      let rejectInitial!: (error: Error) => void;
      let resolveJob!: (response: Response) => void;
      const initialResponse = new Promise<Response>((resolve, reject) => {
        resolveInitial = resolve;
        rejectInitial = reject;
      });
      const jobResponse = new Promise<Response>((resolve) => {
        resolveJob = resolve;
      });
      vi.stubGlobal("fetch", (input: string) => {
        if (input === `${dossierPath}?scope=initial`) return initialResponse;
        if (input === `/api/dossiers/jobs/${jobId}`) return jobResponse;
        if (input === dossierPath)
          return Promise.resolve(Response.json(expanded));
        throw new Error(`Unexpected request: ${input}`);
      });
      render(
        <DossierPageClient
          identity={identity}
          initialDossier={null}
          jobId={jobId}
        />
      );
      const failInitial = () => {
        if (failure === "network") rejectInitial(new Error("Connection lost"));
        else
          resolveInitial(
            Response.json({}, { status: failure === "HTTP" ? 503 : 200 })
          );
      };
      if (timing === "before") {
        await act(async () => {
          failInitial();
        });
        expect(screen.getByRole("alert")).toBeVisible();
      }
      await act(async () => {
        resolveJob(Response.json({ status: "complete", error: null }));
      });
      expect(screen.getByText("Expanded evidence")).toBeVisible();
      if (timing === "after")
        await act(async () => {
          failInitial();
        });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
  );

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
