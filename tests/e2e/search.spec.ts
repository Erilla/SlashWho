import { expect, test } from "playwright/test";

import { releaseUpstreamCharacterRead, seedSnapshot } from "./support/seed";

const RYII_URL = "https://raider.io/characters/eu/silvermoon/Ryii";

test("searches, refreshes, and opens an immutable snapshot", async ({
  page
}) => {
  await seedSnapshot({
    key: { region: "eu", realm: "silvermoon", name: "ryii" },
    displayName: "Ryii",
    refreshedAt: new Date("2025-01-01T00:00:00.000Z")
  });
  await page.goto("/");
  await page.getByLabel("Raider.IO character URL").fill(RYII_URL);
  await page.getByRole("button", { name: "Search" }).click();

  await expect(page).toHaveURL(/\/characters\/eu\/silvermoon\/ryii$/);
  await expect(page.getByText("Refreshing")).toBeVisible();

  await releaseUpstreamCharacterRead();
  await expect(
    page.getByRole("link", { name: "Ryii", exact: true })
  ).toBeVisible({
    timeout: 30_000
  });

  await page.getByRole("link", { name: "3 characters" }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { name: "Refresh history" })
  ).toBeVisible();
});
