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
    await expect(
      page.getByRole("link", { name: "View Warcraft Logs report" })
    ).toBeVisible();
  });
}
