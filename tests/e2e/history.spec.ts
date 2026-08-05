import { expect, test } from "playwright/test";

import { seedSnapshot, suppressCharacter } from "./support/seed";

const ARCHIVE = { region: "eu", realm: "silvermoon", name: "archive" } as const;

test("opens an immutable historical refresh without internal provenance", async ({
  page
}) => {
  const older = await seedSnapshot({
    key: ARCHIVE,
    displayName: "Archive",
    refreshedAt: new Date("2025-01-02T03:04:00.000Z"),
    state: "partial",
    limitationCode: "privacy_hidden"
  });
  await seedSnapshot({
    key: ARCHIVE,
    displayName: "Archive",
    refreshedAt: new Date("2025-02-03T04:05:00.000Z"),
    characters: [
      { key: ARCHIVE, displayName: "Archive", className: "Mage", level: 80 },
      {
        key: { region: "eu", realm: "silvermoon", name: "archivealt" },
        displayName: "Archivealt",
        className: "Druid",
        level: 76
      }
    ]
  });

  await page.goto("/characters/eu/silvermoon/archive");
  await expect(
    page.getByRole("heading", { name: "Refresh history" })
  ).toBeVisible();
  await expect(
    page.locator('time[datetime="2025-01-02T03:04:00.000Z"]')
  ).toHaveText("2 Jan 2025, 03:04");

  await page.getByRole("link", { name: "1 character" }).click();
  await expect(page).toHaveURL(
    `/characters/eu/silvermoon/archive/history/${older.id}`
  );
  await expect(
    page.getByRole("link", { name: "Archive", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Archivealt", exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByText(/profile guess|claimed|provenance|source/i)
  ).toHaveCount(0);
});

test("suppression hides a previously published character without deleting history", async ({
  page
}) => {
  const key = { region: "eu", realm: "silvermoon", name: "hidden" } as const;
  await seedSnapshot({
    key,
    displayName: "Hidden",
    refreshedAt: new Date("2025-03-01T00:00:00.000Z")
  });
  await suppressCharacter(key, "public_removal_request");

  await page.goto("/characters/eu/silvermoon/hidden");
  await expect(
    page.getByRole("heading", { name: "Character not found" })
  ).toBeVisible();
});
