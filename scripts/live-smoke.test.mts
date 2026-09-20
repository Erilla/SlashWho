import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";

import { runLiveSmoke } from "./live-smoke.mts";

it("starts and polls only dossier-scoped research endpoints", async () => {
  // Break caught: the production smoke could keep calling a retired /api/v1
  // route even though applicant research is available only through dossiers.
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        status: "ready",
        lastSuccessfulRunAgeMs: 12_345,
        queueDepth: 2
      })
    )
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

  await expect(
    runLiveSmoke({
      workerBaseUrl: new URL("https://worker.slashwho.example"),
      workerMaxSuccessfulRunAgeMs: 48 * 60 * 60_000,
      baseUrl: new URL("https://slashwho.example"),
      characterUrl: "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii",
      authorization: null,
      fetch,
      sleep: async () => {}
    })
  ).resolves.toEqual({
    worker: {
      lastSuccessfulRunAgeMs: 12_345,
      queueDepth: 2
    },
    dossierJobPath: "passed"
  });

  expect(
    fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)
  ).toEqual([
    "/probe",
    "/health",
    "/ready",
    "/api/dossiers",
    "/api/dossiers/jobs/54f14e37-7df7-43db-91d5-21e797d1d145"
  ]);
});

it("reports a fresh dossier as skipped without hiding worker coverage", async () => {
  // Break caught: a fresh cache hit could still make the job-path assertion
  // look green even though no queue or worker job ran.
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        status: "ready",
        lastSuccessfulRunAgeMs: 1_000,
        queueDepth: 0
      })
    )
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(Response.json({ kind: "ready" }));

  await expect(
    runLiveSmoke({
      workerBaseUrl: new URL("https://worker.slashwho.example"),
      workerMaxSuccessfulRunAgeMs: 48 * 60 * 60_000,
      baseUrl: new URL("https://slashwho.example"),
      characterUrl: "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii",
      authorization: null,
      fetch,
      sleep: async () => {}
    })
  ).resolves.toEqual({
    worker: {
      lastSuccessfulRunAgeMs: 1_000,
      queueDepth: 0
    },
    dossierJobPath: "skipped_inconclusive"
  });
});

it("fails before searching when the worker has not succeeded recently", async () => {
  // Break caught: a healthy web service could keep the scheduled smoke green
  // while the worker had stopped completing jobs.
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
    Response.json({
      status: "ready",
      lastSuccessfulRunAgeMs: 48 * 60 * 60_000 + 1,
      queueDepth: 4
    })
  );

  await expect(
    runLiveSmoke({
      workerBaseUrl: new URL("https://worker.slashwho.example"),
      workerMaxSuccessfulRunAgeMs: 48 * 60 * 60_000,
      baseUrl: new URL("https://slashwho.example"),
      characterUrl: "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii",
      authorization: null,
      fetch,
      sleep: async () => {}
    })
  ).rejects.toThrow("smoke_worker_stale");
  expect(fetch).toHaveBeenCalledOnce();
});

it("fails before searching when the worker has never completed a run", async () => {
  // Break caught: an absent aggregate must not look like a just-completed run.
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
    Response.json({
      status: "ready",
      lastSuccessfulRunAgeMs: null,
      queueDepth: 0
    })
  );

  await expect(
    runLiveSmoke({
      workerBaseUrl: new URL("https://worker.slashwho.example"),
      workerMaxSuccessfulRunAgeMs: 48 * 60 * 60_000,
      baseUrl: new URL("https://slashwho.example"),
      characterUrl: "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii",
      authorization: null,
      fetch,
      sleep: async () => {}
    })
  ).rejects.toThrow("smoke_worker_never_succeeded");
  expect(fetch).toHaveBeenCalledOnce();
});

it("fails before checking the web service when the worker is unavailable", async () => {
  // Break caught: the web health checks could mask a worker process that is
  // down or has not finished claiming its queues.
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }));

  await expect(
    runLiveSmoke({
      workerBaseUrl: new URL("https://worker.slashwho.example"),
      workerMaxSuccessfulRunAgeMs: 48 * 60 * 60_000,
      baseUrl: new URL("https://slashwho.example"),
      characterUrl: "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii",
      authorization: null,
      fetch,
      sleep: async () => {}
    })
  ).rejects.toThrow("smoke_worker_http_503");
  expect(fetch).toHaveBeenCalledOnce();
});

it("rejects any identity-bearing field on the worker probe", async () => {
  // Break caught: a worker response could add character or fingerprint
  // details and turn a public operational endpoint into a data surface.
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
    Response.json({
      status: "ready",
      lastSuccessfulRunAgeMs: 1_000,
      queueDepth: 0,
      characterName: "private"
    })
  );

  await expect(
    runLiveSmoke({
      workerBaseUrl: new URL("https://worker.slashwho.example"),
      workerMaxSuccessfulRunAgeMs: 48 * 60 * 60_000,
      baseUrl: new URL("https://slashwho.example"),
      characterUrl: "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii",
      authorization: null,
      fetch,
      sleep: async () => {}
    })
  ).rejects.toThrow("smoke_worker_probe_invalid");
  expect(fetch).toHaveBeenCalledOnce();
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
