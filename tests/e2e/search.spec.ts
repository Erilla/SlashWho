import { expect, test } from "playwright/test";

import {
  countDiscoveryRuns,
  seedCharacterEvidence,
  seedSnapshot
} from "./support/seed";

const applicantUrls = [
  "https://raider.io/characters/eu/silvermoon/Ryii",
  "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii"
] as const;

test("reports an absent character before creating discovery work", async ({
  page
}) => {
  // Break caught: absence could first become a queued run, expose a polling
  // URL, post a start webhook, and only then degrade into temporary failure.
  const fixtureBaseUrl = process.env.E2E_RAIDER_IO_BASE_URL;
  if (!fixtureBaseUrl) throw new Error("e2e_fixture_base_url_unavailable");
  await fetch(new URL("/__control/reset-stats", fixtureBaseUrl));
  const polledJobs: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/dossiers/jobs/")) {
      polledJobs.push(request.url());
    }
  });

  await page.goto("/dossiers/eu/silvermoon/absent");

  await expect(page).toHaveURL("/dossiers/eu/silvermoon/absent");
  const notFoundAlert = page
    .getByRole("alert")
    .filter({ hasText: "The character was not found." });
  await expect(notFoundAlert).toHaveText("The character was not found.");
  expect(
    await countDiscoveryRuns({
      region: "eu",
      realm: "silvermoon",
      name: "absent"
    })
  ).toBe(0);
  expect(polledJobs).toEqual([]);

  await page.reload();
  await expect(notFoundAlert).toHaveText("The character was not found.");
  const stats = (await fetch(new URL("/__control/stats", fixtureBaseUrl)).then(
    (response) => response.json()
  )) as {
    discoveryWebhooks: number;
    characterRequests: Record<string, number>;
  };
  expect(stats.discoveryWebhooks).toBe(0);
  expect(stats.characterRequests["/api/characters/eu/silvermoon/absent"]).toBe(
    1
  );
  expect(
    await countDiscoveryRuns({
      region: "eu",
      realm: "silvermoon",
      name: "absent"
    })
  ).toBe(0);
  expect(polledJobs).toEqual([]);
});

for (const applicantUrl of applicantUrls) {
  test(`researches an applicant dossier from ${new URL(applicantUrl).hostname}`, async ({
    page
  }) => {
    // Break caught: either supported URL form could still enter the retired
    // character/history journey instead of rendering dossier evidence.
    await seedSnapshot({
      key: { region: "eu", realm: "silvermoon", name: "ryii" },
      displayName: "Ryii",
      refreshedAt: new Date("2026-09-11T00:00:00.000Z")
    });
    await seedCharacterEvidence({
      region: "eu",
      realm: "silvermoon",
      name: "ryii"
    });
    await page.goto("/");
    await page.getByLabel("Character/URL").fill(applicantUrl);
    await page.getByRole("button", { name: "Research applicant" }).click();

    await expect(page).toHaveURL(
      /\/dossiers\/eu\/silvermoon\/ryii(?:\?job=[\da-f-]+)?$/
    );
    await expect(page.getByLabel("Character/URL")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Research applicant" })
    ).toHaveCount(1);
    await expect(page.locator("main").getByLabel("Character/URL")).toHaveCount(
      0
    );
    await expect(page.getByLabel("Character/URL")).toHaveValue("");
    await expect(page.getByLabel("Realm")).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Historic Cutting Edge" })
    ).toBeVisible();
    const raiderIoLink = page.locator("header").getByRole("link", {
      name: "View Ryii on Raider.IO (opens in a new tab)"
    });
    await expect(raiderIoLink).toHaveAttribute(
      "href",
      /raider\.io\/characters\/eu\/silvermoon\/ryii$/
    );
    await expect(raiderIoLink).toHaveAttribute("target", "_blank");
    await expect(page.getByText("Queen Ansurek")).toBeVisible();
    const evidence = page.getByRole("group", {
      name: "Queen Ansurek evidence"
    });
    await expect(evidence.getByText("World #147")).toBeVisible();
    await evidence.getByText("View kill evidence").click();
    await expect
      .poll(() =>
        evidence
          .locator(".dossier-evidence time")
          .evaluateAll((times) =>
            times.map((time) => time.getAttribute("datetime"))
          )
      )
      .toEqual(["2025-01-13T21:31:40.000Z"]);
    const reportMenu = evidence.getByRole("button", {
      name: "Choose from 2 kill reports"
    });
    await expect(reportMenu).toHaveAccessibleDescription("2 reports found");
    await reportMenu.click();
    const reportLinks = page
      .getByRole("list", { name: "Kill reports" })
      .getByRole("link");
    await expect(reportLinks).toHaveCount(2);
    expect(
      await reportLinks.evaluateAll((links) =>
        links.map((link) => link.getAttribute("href"))
      )
    ).toEqual(
      expect.arrayContaining([
        "https://www.warcraftlogs.com/reports/e2eReport#fight=9",
        "https://www.warcraftlogs.com/reports/e2eReport#fight=10"
      ])
    );
  });
}

test("shows submitted-character evidence while queued discovery is held", async ({
  page
}) => {
  await seedCharacterEvidence({
    region: "eu",
    realm: "silvermoon",
    name: "queued"
  });
  await fetch(`${process.env.E2E_RAIDER_IO_BASE_URL}/__control/hold`);
  await page.goto("/");
  await page
    .getByLabel("Character/URL")
    .fill("https://raider.io/characters/eu/silvermoon/queued");
  await page.getByRole("button", { name: "Research applicant" }).click();

  await expect(page).toHaveURL(/\/dossiers\/eu\/silvermoon\/queued\?job=/);
  const initialDisclosure = page.getByText(
    "Linked-character research is pending; stored evidence is shown only for the submitted character.",
    { exact: true }
  );
  await expect(initialDisclosure).toBeVisible();

  const evidence = page.getByRole("group", { name: "Queen Ansurek evidence" });
  await expect(evidence).toBeVisible();
  await fetch(`${process.env.E2E_RAIDER_IO_BASE_URL}/__control/release`);

  await expect(
    page.getByText("Linked-character research is complete.", { exact: true })
  ).toBeVisible({ timeout: 15_000 });
  await expect(initialDisclosure).not.toBeVisible();
  await evidence.getByText("View kill evidence").click();
  const reportMenu = evidence.getByRole("button", {
    name: "Choose from 2 kill reports"
  });
  await expect(reportMenu).toHaveAccessibleDescription("2 reports found");
  await reportMenu.click();
  const reportLinks = page
    .getByRole("list", { name: "Kill reports" })
    .getByRole("link");
  await expect(reportLinks).toHaveCount(2);
  expect(
    await reportLinks.evaluateAll((links) =>
      links.map((link) => link.getAttribute("href"))
    )
  ).toEqual(
    expect.arrayContaining([
      "https://www.warcraftlogs.com/reports/e2eReport#fight=9",
      "https://www.warcraftlogs.com/reports/e2eReport#fight=10"
    ])
  );
});

test("discloses that a partial snapshot may omit linked characters", async ({
  page
}) => {
  await seedSnapshot({
    key: { region: "eu", realm: "silvermoon", name: "partial" },
    displayName: "Partial",
    refreshedAt: new Date("2026-09-11T00:00:00.000Z"),
    state: "partial",
    limitationCode: "fingerprint_sweep_capped"
  });

  await page.goto("/dossiers/eu/silvermoon/partial");

  await expect(
    page.getByText(
      "Additional linked characters may exist; this dossier is not exhaustive.",
      { exact: true }
    )
  ).toBeVisible();
});

test("shows a grey no-log row when an entire supported tier has no evidence", async ({
  page
}) => {
  const key = { region: "eu", realm: "silvermoon", name: "no-logs" } as const;
  await seedSnapshot({
    key,
    displayName: "No Logs",
    refreshedAt: new Date("2026-09-11T00:00:00.000Z")
  });
  await seedCharacterEvidence(key, { withSampleKills: false });

  await page.goto("/dossiers/eu/silvermoon/no-logs");

  const tier = page.getByRole("group", {
    name: "The Venomous Abyss evidence"
  });
  await expect(tier).toHaveClass(/dossier-raid-no-logs/);
  await expect(tier.getByText("No logs found", { exact: true })).toBeVisible();
  await expect(
    tier.getByText(
      "No qualifying public logs found; this does not prove no attempt.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(tier.getByRole("article")).toHaveCount(0);
});

test("presents parse evidence with exact fight sources at desktop and mobile widths", async ({
  page
}) => {
  // Break caught: a parse could become detached from its precise fight source,
  // inaccessible without colour, hidden from a collapsed card, or force a
  // horizontal scroll on the dossier's existing mobile viewport.
  const key = {
    region: "eu",
    realm: "silvermoon",
    name: "parsecheck"
  } as const;
  const laterKey = {
    region: "eu",
    realm: "draenor",
    name: "laterparse"
  } as const;
  await seedSnapshot({
    key,
    displayName: "Parsecheck",
    refreshedAt: new Date("2026-09-11T00:00:00.000Z"),
    characters: [
      { key, displayName: "Parsecheck", className: "Mage", level: 80 },
      {
        key: laterKey,
        displayName: "Laterparse",
        className: "Priest",
        level: 80
      }
    ]
  });
  await seedCharacterEvidence(key);
  await seedCharacterEvidence(laterKey, {
    withLaterParseEvent: true,
    laterParseEventOnly: true
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dossiers/eu/silvermoon/parsecheck");
  const boss = page.getByRole("group", { name: "Queen Ansurek evidence" });
  const firstKillParses = boss.locator(
    ":scope > [aria-label='First kill parses']"
  );
  const bestParses = boss.locator(":scope > [aria-label='Best parses']");
  await expect(firstKillParses).toBeVisible();
  await expect(bestParses).toBeVisible();
  await expect(
    firstKillParses.getByRole("link", { name: "Damage 99 percentile (Fire)" })
  ).toHaveAttribute("href", /e2eReport#fight=10$/);
  await expect(
    firstKillParses.getByAltText("Fire specialization").first()
  ).toBeVisible();
  await expect(
    bestParses.getByRole("link", { name: "Damage 100 percentile (Fire)" })
  ).toHaveAttribute("href", /e2eLaterReport#fight=11$/);
  await expect(
    firstKillParses
      .locator(".dossier-parse-metric")
      .filter({ hasText: "Healing" })
      .getByText("-", { exact: true })
  ).toBeVisible();
  await expect(
    firstKillParses
      .locator(".dossier-parse-metric")
      .filter({ hasText: "Boss Dam" })
      .getByText("-", { exact: true })
  ).toBeVisible();

  await boss.getByText("View kill evidence").click();
  const evidence = boss.getByRole("region", { name: "Kill evidence" });
  const latestEventParses = evidence.getByRole("region", {
    name: "Kill parses",
    exact: true
  });
  const firstEventParses = evidence.getByRole("region", {
    name: "First kill parses"
  });
  await expect(
    latestEventParses.getByRole("link", {
      name: "Damage 100 percentile (Fire)"
    })
  ).toHaveAttribute("href", /e2eLaterReport#fight=11$/);
  await expect(
    firstEventParses.getByRole("link", {
      name: "Damage 99 percentile (Fire)"
    })
  ).toHaveAttribute("href", /e2eReport#fight=10$/);
  await expect(
    latestEventParses.getByRole("group", { name: "Laterparse parses" })
  ).toBeVisible();
  await expect(
    firstEventParses.getByRole("group", { name: "Parsecheck parses" })
  ).toBeVisible();
  await expect(
    latestEventParses.getByText("Laterparse", { exact: true })
  ).toHaveCount(0);
  await expect(
    firstEventParses.getByText("Parsecheck", { exact: true })
  ).toHaveCount(0);
  await expect(
    firstKillParses.getByText("Parsecheck", { exact: true })
  ).toBeVisible();
  await expect(
    bestParses.getByText("Laterparse", { exact: true })
  ).toBeVisible();
  await expect(latestEventParses.locator("xpath=ancestor::dl")).not.toHaveClass(
    /dossier-evidence-first-kill/
  );
  await expect(firstEventParses.locator("xpath=ancestor::dl")).toHaveClass(
    /dossier-evidence-first-kill/
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await firstKillParses.scrollIntoViewIfNeeded();
  await expect(firstKillParses).toBeVisible();
  await expect(firstKillParses).toBeInViewport();
  await expect(
    firstKillParses.getByRole("link", { name: "Damage 99 percentile (Fire)" })
  ).toHaveAttribute("href", /e2eReport#fight=10$/);

  await bestParses.scrollIntoViewIfNeeded();
  await expect(bestParses).toBeVisible();
  await expect(bestParses).toBeInViewport();
  await expect(
    bestParses.getByRole("link", { name: "Damage 100 percentile (Fire)" })
  ).toHaveAttribute("href", /e2eLaterReport#fight=11$/);

  await latestEventParses.scrollIntoViewIfNeeded();
  await expect(latestEventParses).toBeVisible();
  await expect(latestEventParses).toBeInViewport();
  await expect(
    latestEventParses.getByRole("link", {
      name: "Damage 100 percentile (Fire)"
    })
  ).toHaveAttribute("href", /e2eLaterReport#fight=11$/);
  await firstEventParses.scrollIntoViewIfNeeded();
  await expect(firstEventParses).toBeVisible();
  await expect(firstEventParses).toBeInViewport();
  await expect(
    firstEventParses.getByRole("link", {
      name: "Damage 99 percentile (Fire)"
    })
  ).toHaveAttribute("href", /e2eReport#fight=10$/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test("keeps parse metrics aligned beside a wrapped long character name", async ({
  page
}) => {
  // Break caught: a long name could consume the flexible space before the
  // metrics, making every parse column begin at a different position or wrap
  // below the name on a narrow screen.
  const key = {
    region: "eu",
    realm: "silvermoon",
    name: "parsealignment"
  } as const;
  const longKey = {
    region: "eu",
    realm: "draenor",
    name: "unusuallylongparsecharactername"
  } as const;
  const longName = "Unusuallylongparsecharactername";
  await seedSnapshot({
    key,
    displayName: "Parsealignment",
    refreshedAt: new Date("2026-09-11T00:00:00.000Z"),
    characters: [
      { key, displayName: "Parsealignment", className: "Mage", level: 80 },
      { key: longKey, displayName: longName, className: "Priest", level: 80 }
    ]
  });
  await seedCharacterEvidence(key);
  await seedCharacterEvidence(longKey, {
    withLaterParseEvent: true,
    laterParseEventOnly: true
  });

  await page.goto("/dossiers/eu/silvermoon/parsealignment");
  const bestParses = page.getByRole("region", { name: "Best parses" });
  const shortRow = bestParses.getByRole("group", {
    name: "Parsealignment parses"
  });
  const longRow = bestParses.getByRole("group", {
    name: `${longName} parses`
  });

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await longRow.scrollIntoViewIfNeeded();
    await expect(longRow).toBeVisible();

    const [shortMetricsLeft, longMetricsLeft, shortNameHeight, longNameHeight] =
      await Promise.all([
        shortRow
          .locator(".dossier-parse-metrics")
          .evaluate((element) => element.getBoundingClientRect().left),
        longRow
          .locator(".dossier-parse-metrics")
          .evaluate((element) => element.getBoundingClientRect().left),
        shortRow
          .locator(".dossier-parse-character")
          .evaluate((element) => element.getBoundingClientRect().height),
        longRow
          .locator(".dossier-parse-character")
          .evaluate((element) => element.getBoundingClientRect().height)
      ]);

    expect(Math.abs(shortMetricsLeft - longMetricsLeft)).toBeLessThanOrEqual(1);
    expect(longNameHeight).toBeGreaterThan(shortNameHeight);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  }
});
