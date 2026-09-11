import { expect, test } from "playwright/test";

import { seedSnapshot } from "./support/seed";

test("keeps dossier research accessible without horizontal overflow on mobile", async ({
  page
}) => {
  // Break caught: narrow screens could retain the retired character/history
  // layout or hide the applicant-research controls outside the viewport.
  const key = { region: "eu", realm: "silvermoon", name: "mobile" } as const;
  await seedSnapshot({
    key,
    displayName: "Mobile",
    refreshedAt: new Date("2025-04-05T06:07:00.000Z")
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  for (let index = 0; index < 6; index += 1) {
    if (
      (await page.evaluate(() => document.activeElement?.id)) ===
      "character-url"
    )
      break;
    await page.keyboard.press("Tab");
  }
  await expect(page.getByLabel("Applicant URL")).toBeFocused();
  await expect(page.getByLabel("Applicant URL")).toHaveCSS(
    "outline-style",
    "solid"
  );
  await page.getByLabel("Applicant URL").fill("not-a-character-url");
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Enter a Raider.IO or Warcraft Logs character URL." })
  ).toHaveText("Enter a Raider.IO or Warcraft Logs character URL.");

  await page
    .getByLabel("Applicant URL")
    .fill("https://raider.io/characters/eu/silvermoon/mobile");
  await page.getByRole("button", { name: "Research applicant" }).click();
  await expect(
    page.getByRole("heading", { name: "Historic Cutting Edge" })
  ).toBeVisible();
  await expect(page.getByText("World #147")).toBeVisible();
  await expect(page.getByText(/evidence is incomplete/i)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
