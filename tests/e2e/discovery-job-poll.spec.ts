import { expect, test } from "playwright/test";
import type { ApplicantDossier } from "@slashwho/contracts";

test("a fast discovery poll shows the committed snapshot without starting research again", async ({
  page
}) => {
  const key = { region: "eu", realm: "silvermoon", name: "fastjob" } as const;
  const jobId = "10000000-0000-4000-8000-000000000013";
  const initial: ApplicantDossier = {
    root: key,
    research: { state: "initial", message: "Research is running." },
    characters: [
      {
        key,
        displayName: "Fastjob",
        className: null,
        source: "submitted",
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/fastjob"
      }
    ],
    raids: [],
    cuttingEdges: [],
    limitations: []
  };
  const completed: ApplicantDossier = {
    ...initial,
    research: { state: "complete", message: "Research complete." },
    characters: [
      { ...initial.characters[0]!, source: "raiderio_declared" },
      {
        ...initial.characters[0]!,
        key: { ...key, name: "linked" },
        displayName: "Linked",
        source: "raiderio_declared"
      }
    ]
  };
  let ready = false;
  let jobReads = 0;
  let fullReads = 0;
  const starts: string[] = [];
  await page.clock.install();
  await page.route("**/api/dossiers**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      starts.push(url.pathname);
      await route.fulfill({ status: 500, json: {} });
    } else if (url.pathname === `/api/dossiers/jobs/${jobId}`) {
      jobReads++;
      await route.fulfill({
        json: { status: ready ? "complete" : "running", error: null }
      });
    } else if (url.searchParams.get("scope") === "initial") {
      await route.fulfill({ json: initial });
    } else {
      fullReads++;
      await route.fulfill(
        ready
          ? { json: completed }
          : {
              status: 409,
              json: {
                error: { code: "discovery_not_ready", message: "Not ready" }
              }
            }
      );
    }
  });
  await page.goto(`/dossiers/eu/silvermoon/fastjob?job=${jobId}`);
  await expect(page.getByText("Research is running.")).toBeVisible();
  await expect.poll(() => jobReads).toBe(1);
  await page.clock.runFor(1_000);
  await expect.poll(() => jobReads).toBe(2);
  await page.clock.runFor(2_000);
  await expect.poll(() => jobReads).toBe(3);
  ready = true;
  await page.clock.runFor(2_000);
  await expect(page.getByText("Research complete.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Linked", exact: true })
  ).toBeVisible();
  expect(jobReads).toBe(4);
  expect(fullReads).toBe(2);
  expect(starts).toEqual([]);
  await page.clock.runFor(10_000);
  expect(jobReads).toBe(4);
});
