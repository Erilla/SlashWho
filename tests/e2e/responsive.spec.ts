import { expect, test } from "playwright/test";

import { seedSnapshot } from "./support/seed";

test("keeps keyboard focus visible and stacks history after characters on mobile", async ({
  page
}) => {
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
  await expect(page.getByLabel("Raider.IO character URL")).toBeFocused();
  await expect(page.getByLabel("Raider.IO character URL")).toHaveCSS(
    "outline-style",
    "solid"
  );
  await page.getByLabel("Raider.IO character URL").fill("not-a-character-url");
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Enter a Raider.IO character URL." })
  ).toHaveText("Enter a Raider.IO character URL.");

  await page.goto("/characters/eu/silvermoon/mobile");
  await expect(page.getByRole("heading", { name: "Mobile" })).toBeVisible();
  const characters = await page.locator(".character-list").boundingBox();
  const history = await page.locator(".history-panel").boundingBox();
  expect(characters).not.toBeNull();
  expect(history).not.toBeNull();
  expect(history!.y).toBeGreaterThan(characters!.y + characters!.height);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
