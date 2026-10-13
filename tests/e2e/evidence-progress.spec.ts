import { expect, test } from "playwright/test";
import type { ApplicantDossier } from "@slashwho/contracts";

test("progress patches and coalesced poll reads never start research", async ({
  page
}) => {
  const key = {
    region: "eu",
    realm: "silvermoon",
    name: "progresspatch"
  } as const;
  const first = "10000000-0000-4000-8000-000000000013";
  const second = "10000000-0000-4000-8000-000000000014";
  const readPath = "/api/dossiers/eu/silvermoon/progresspatch";
  const shown: ApplicantDossier = {
    root: key,
    research: {
      state: "complete",
      message: "Linked-character research is complete."
    },
    characters: [
      {
        key,
        displayName: "Progresspatch",
        className: null,
        source: "raiderio_declared",
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/progresspatch",
        evidenceState: "scanning",
        researchState: "gathering"
      }
    ],
    evidenceRunIds: [first, second],
    raids: [],
    cuttingEdges: [],
    limitations: []
  };
  const settled: ApplicantDossier = {
    ...shown,
    characters: shown.characters.map((row) => ({
      ...row,
      evidenceState: "complete",
      researchState: "complete"
    }))
  };
  delete settled.evidenceRunIds;
  let stage: "steps" | "intermediate" | "final" = "steps";
  let progressReads = 0;
  let fullReads = 0;
  const starts: string[] = [];
  await page.clock.install();
  await page.route("**/api/dossiers**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      starts.push(url.pathname);
      await route.fulfill({ status: 500, json: {} });
    } else if (url.pathname === "/api/dossiers/evidence-runs") {
      progressReads++;
      const settled = stage !== "steps";
      await route.fulfill({
        json: {
          runs: [
            {
              id: first,
              key,
              state: settled ? "settled" : "running",
              version: stage,
              evidenceState: settled ? "complete" : "scanning",
              collectionProgress: [
                { id: "warcraft_logs_history", state: "active" }
              ]
            },
            {
              id: second,
              key,
              state: stage === "final" ? "settled" : "running",
              version: stage,
              evidenceState: stage === "final" ? "complete" : "scanning",
              collectionProgress: []
            }
          ]
        }
      });
    } else if (url.pathname === readPath) {
      fullReads++;
      await route.fulfill({
        json:
          stage === "final"
            ? settled
            : {
                ...shown,
                evidenceRunIds:
                  stage === "intermediate" ? [second] : [first, second]
              }
      });
    } else await route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/dossiers/eu/silvermoon/progresspatch");
  await page.clock.runFor(1_000);
  await expect(page.locator(".collection-progress-summary")).toContainText(
    "Scanning report history"
  );
  expect(fullReads).toBe(1);
  stage = "intermediate";
  const before = progressReads;
  await page.clock.runFor(500);
  await expect.poll(() => progressReads).toBeGreaterThan(before);
  expect(fullReads).toBe(1);
  await page.clock.runFor(11_000);
  await expect.poll(() => fullReads).toBe(2);
  stage = "final";
  await page.clock.runFor(2_000);
  await expect.poll(() => fullReads).toBe(3);
  await expect(page.locator(".collection-progress-summary")).toHaveCount(0);
  expect(starts).toEqual([]);
});
