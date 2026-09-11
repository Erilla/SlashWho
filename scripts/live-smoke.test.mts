import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
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

it("runs required environment validation when invoked as the smoke CLI", () => {
  // Break caught: an unsupported direct-execution guard could make scheduled
  // smoke runs exit successfully without issuing any validation or requests.
  const result = spawnSync(
    process.platform === "win32" ? "cmd.exe" : "corepack",
    process.platform === "win32"
      ? [
          "/d",
          "/s",
          "/c",
          "corepack",
          "pnpm",
          "exec",
          "tsx",
          "scripts/live-smoke.mts"
        ]
      : ["pnpm", "exec", "tsx", "scripts/live-smoke.mts"],
    {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        SLASHWHO_BASE_URL: "",
        SLASHWHO_SMOKE_CHARACTER_URL: ""
      }
    }
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("slashwho_base_url_required");
});
