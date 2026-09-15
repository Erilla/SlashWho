// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicantDossier, CharacterKey } from "@slashwho/contracts";
import { clearStoredCredentials, writeStoredCredentials } from "../../../../../lib/api-credentials";

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
              characters: [identity],
              parses: []
            },
            bestParses: []
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
const partiallyExpanded = dossier(
  "partial",
  "Additional linked characters may exist; this dossier is not exhaustive.",
  "Partial evidence"
);
const rateLimited = {
  ...expanded,
  limitations: [
    {
      source: "raiderio" as const,
      character: null,
      code: "rate_limited" as const,
      message: "Raider.IO is temporarily rate limited.",
      observedAt: "2026-09-15T12:00:00.000Z",
      retryAt: "2026-09-15T12:02:05.000Z"
    }
  ]
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  push.mockReset();
  clearStoredCredentials();
});

describe("DossierPageClient staged research", () => {
  it("shows a provider reset countdown at the top of the dossier", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));

    render(
      <DossierPageClient
        identity={identity}
        initialDossier={rateLimited}
        jobId={null}
      />
    );

    const heading = screen
      .getByRole("heading", { name: "Ryii" })
      .closest("header");
    expect(heading).not.toBeNull();
    expect(heading).toHaveTextContent("Raider.IO limit resets in 2m 5s");
  });

  it("moves the identity into the centered header after the heading scrolls away", async () => {
    let observe: ((entries: IntersectionObserverEntry[]) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
          observe = callback;
        }
        observe() {}
        disconnect() {}
      }
    );

    render(
      <DossierPageClient
        identity={identity}
        initialDossier={expanded}
        jobId={null}
      />
    );

    expect(
      screen.queryByRole("status", { name: "Current character" })
    ).toBeNull();
    act(() =>
      observe?.([{ isIntersecting: false } as IntersectionObserverEntry])
    );

    expect(
      await screen.findByRole("status", { name: "Current character" })
    ).toHaveTextContent("RyiiEU · silvermoon");
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

  it("keeps polling evidence after a transient read failure", async () => {
    // Break caught: a temporary dossier read throttle could strand the page on
    // the gathering message until the reviewer manually refreshed it.
    vi.useFakeTimers();
    let evidenceCalls = 0;
    const fetchMock = vi.fn((input: string) => {
      if (input !== dossierPath)
        return Promise.reject(new Error(`Unexpected request: ${input}`));
      evidenceCalls += 1;
      return evidenceCalls === 1
        ? Promise.resolve(
            Response.json(
              { error: { code: "rate_limited", message: "Try again later." } },
              { status: 429 }
            )
          )
        : Promise.resolve(Response.json(partiallyExpanded));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DossierPageClient
        identity={identity}
        initialDossier={dossier(
          "gathering",
          "Historic mythic evidence is still gathering in the background. Cached results are shown while it completes.",
          "Gathering evidence"
        )}
        jobId={null}
      />
    );

    expect(
      screen.getByText(
        "Historic mythic evidence is still gathering in the background. Cached results are shown while it completes."
      )
    ).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(evidenceCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(evidenceCalls).toBe(2);
    expect(screen.getByText(partiallyExpanded.research.message)).toBeVisible();
    expect(
      screen.queryByText(
        "Historic mythic evidence is still gathering in the background. Cached results are shown while it completes."
      )
    ).not.toBeInTheDocument();
  });

  it("shows a linked snapshot immediately and starts discovery for its root", async () => {
    const linkedDossier = {
      ...expanded,
      root: {
        region: "eu" as const,
        realm: "silvermoon",
        name: "root"
      }
    };
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === dossierPath)
        return Promise.resolve(Response.json(linkedDossier));
      if (input === "/api/dossiers") {
        expect(JSON.parse(String(init?.body))).toEqual({
          characterUrl: "https://raider.io/characters/eu/silvermoon/root"
        });
        return Promise.resolve(
          Response.json(
            { kind: "job", jobId, status: "running" },
            { status: 202 }
          )
        );
      }
      if (input === `${dossierPath}?scope=initial`)
        return Promise.resolve(Response.json(initial));
      if (input === `/api/dossiers/jobs/${jobId}`)
        return new Promise<Response>(() => undefined);
      return Promise.reject(new Error(`Unexpected request: ${input}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DossierPageClient
        identity={identity}
        initialDossier={null}
        jobId={null}
      />
    );

    expect(await screen.findByText("Expanded evidence")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dossiers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          characterUrl: "https://raider.io/characters/eu/silvermoon/root"
        })
      })
    );
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

  it("attaches stored credential headers to the dossier fetch", async () => {
    writeStoredCredentials({
      blizzardClientId: "id",
      blizzardClientSecret: "secret",
      raiderIoAccessKey: "",
      wclClientId: "",
      wclClientSecret: ""
    });
    const fetchMock = vi.fn((input: string) => {
      if (input === `${dossierPath}?scope=initial`) {
        return Promise.resolve(Response.json(initial));
      }
      if (input === `/api/dossiers/jobs/${jobId}`) {
        return Promise.resolve(
          Response.json({
            status: "complete",
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

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(dossierPath),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-blizzard-client-id": "id",
          "x-blizzard-client-secret": "secret"
        })
      })
    );
  });
});
