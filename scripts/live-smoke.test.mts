import { expect, it, vi } from "vitest";

import { runLiveSmoke } from "./live-smoke.mts";

it("starts and polls only dossier-scoped research endpoints", async () => {
  // Break caught: the production smoke could keep calling a retired /api/v1
  // route even though applicant research is available only through dossiers.
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(
      Response.json(
        {
          kind: "job",
          jobId: "54f14e37-7df7-43db-91d5-21e797d1d145",
          status: "queued"
        },
        { status: 202 }
      )
    )
    .mockResolvedValueOnce(Response.json({ status: "complete", error: null }));

  await runLiveSmoke({
    baseUrl: new URL("https://slashwho.example"),
    characterUrl: "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii",
    authorization: null,
    fetch,
    sleep: async () => {}
  });

  expect(
    fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)
  ).toEqual([
    "/health",
    "/ready",
    "/api/dossiers",
    "/api/dossiers/jobs/54f14e37-7df7-43db-91d5-21e797d1d145"
  ]);
});
