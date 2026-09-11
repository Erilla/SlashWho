import { expect, test } from "playwright/test";

import { seedSnapshot } from "./support/seed";

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
    await page.goto("/");
    await page.getByLabel("Applicant URL").fill(applicantUrl);
    await page.getByRole("button", { name: "Research applicant" }).click();

    await expect(page).toHaveURL(/\/dossiers\/eu\/silvermoon\/ryii$/);
    await expect(
      page.getByRole("heading", { name: "Historic Cutting Edge" })
    ).toBeVisible();
    await expect(page.getByText("Queen Ansurek")).toBeVisible();
    await page
      .getByRole("group", { name: "Queen Ansurek evidence" })
      .getByText("View first-kill evidence")
      .click();
    await expect(
      page.getByRole("link", { name: "View Warcraft Logs report" })
    ).toBeVisible();
  });
}

test("completes queued discovery before reading applicant-bound Warcraft Logs evidence", async ({
  page
}) => {
  await fetch(`${process.env.E2E_RAIDER_IO_BASE_URL}/__control/hold`);
  await page.goto("/");
  await page
    .getByLabel("Applicant URL")
    .fill("https://raider.io/characters/eu/silvermoon/queued");
  await page.getByRole("button", { name: "Research applicant" }).click();

  await expect(page).toHaveURL(/\/dossiers\/eu\/silvermoon\/queued\?job=/);
  await expect(page.getByText("Researching applicant dossier…")).toBeVisible();
  await fetch(`${process.env.E2E_RAIDER_IO_BASE_URL}/__control/release`);

  const evidence = page.getByRole("group", { name: "Queen Ansurek evidence" });
  await expect(evidence).toBeVisible();
  await evidence.getByText("View first-kill evidence").click();
  await expect(
    evidence.getByRole("link", { name: "View Warcraft Logs report" })
  ).toHaveAttribute("href", /e2eReport#fight=9$/);
});
