import { expect, test } from "playwright/test";

import { seedCharacterEvidence, seedSnapshot } from "./support/seed";

const applicantUrls = [
  "https://raider.io/characters/eu/silvermoon/Ryii",
  "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii"
] as const;

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
    await page.getByLabel("Applicant URL").fill(applicantUrl);
    await page.getByRole("button", { name: "Research applicant" }).click();

    await expect(page).toHaveURL(
      /\/dossiers\/eu\/silvermoon\/ryii(?:\?job=[\da-f-]+)?$/
    );
    await expect(
      page.getByRole("heading", { name: "Historic Cutting Edge" })
    ).toBeVisible();
    const raiderIoLink = page.getByRole("link", {
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
    const reportLinks = evidence.getByRole("link", {
      name: /View Warcraft Logs report/
    });
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
    .getByLabel("Applicant URL")
    .fill("https://raider.io/characters/eu/silvermoon/queued");
  await page.getByRole("button", { name: "Research applicant" }).click();

  await expect(page).toHaveURL(/\/dossiers\/eu\/silvermoon\/queued\?job=/);
  const initialDisclosure = page.getByText(
    "Linked-character research is still running; this evidence covers only the submitted character.",
    { exact: true }
  );
  await expect(initialDisclosure).toBeVisible();

  const evidence = page.getByRole("group", { name: "Queen Ansurek evidence" });
  await expect(evidence).toBeVisible();
  await fetch(`${process.env.E2E_RAIDER_IO_BASE_URL}/__control/release`);

  await expect(
    page.getByText("Linked-character research is complete.", { exact: true })
  ).toBeVisible();
  await expect(initialDisclosure).not.toBeVisible();
  await evidence.getByText("View kill evidence").click();
  const reportLinks = evidence.getByRole("link", {
    name: /View Warcraft Logs report/
  });
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
  await seedSnapshot({
    key,
    displayName: "Parsecheck",
    refreshedAt: new Date("2026-09-11T00:00:00.000Z")
  });
  await seedCharacterEvidence(key);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dossiers/eu/silvermoon/parsecheck");
  const boss = page.getByRole("group", { name: "Queen Ansurek evidence" });
  const firstKillParses = boss.getByRole("region", {
    name: "First kill parses"
  });
  const bestParses = boss.getByRole("region", { name: "Best shown parses" });
  await expect(firstKillParses).toBeVisible();
  await expect(bestParses).toBeVisible();
  await expect(
    firstKillParses.getByRole("link", { name: "Damage 87.1 percentile" })
  ).toHaveAttribute("href", /e2eReport#fight=9$/);
  await expect(
    bestParses.getByRole("link", { name: "Damage 99.2 percentile" })
  ).toHaveAttribute("href", /e2eReport#fight=10$/);
  await expect(
    firstKillParses.getByText("Healing not applicable")
  ).toBeVisible();
  await expect(
    firstKillParses.getByText("Boss damage unavailable")
  ).toBeVisible();

  await boss.getByText("View kill evidence").click();
  const evidence = boss.getByRole("region", { name: "Kill evidence" });
  await expect(
    evidence
      .getByRole("region", { name: "First kill parses" })
      .getByRole("link", { name: "Damage 87.1 percentile" })
  ).toHaveAttribute("href", /e2eReport#fight=9$/);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
