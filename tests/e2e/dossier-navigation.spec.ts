import { expect, test } from "playwright/test";

test("navigates a long dossier without hiding targets behind the header", async ({
  page
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/demo");

  const navigation = page.getByRole("navigation", { name: "Dossier sections" });
  const raids = navigation.getByRole("link", { name: /^Raid:/ });
  expect(await raids.count()).toBeGreaterThan(1);
  await expect(navigation).toHaveCSS("position", "sticky");

  const targetLink = raids.last();
  const targetId = (await targetLink.getAttribute("href"))!.slice(1);
  await targetLink.click();
  await expect(targetLink).toHaveAttribute("aria-current", "location");
  const geometry = await page.locator(`#${targetId}`).evaluate((target) => ({
    targetTop: target.getBoundingClientRect().top,
    headerBottom: document
      .querySelector(".site-header")!
      .getBoundingClientRect().bottom
  }));
  expect(geometry.targetTop).toBeGreaterThan(geometry.headerBottom);
  expect(geometry.targetTop).toBeLessThan(geometry.headerBottom + 40);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(
    navigation.getByRole("link", { name: "Connected characters" })
  ).toHaveAttribute("aria-current", "location");
});

test("keeps section navigation usable by keyboard on a narrow viewport", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo");

  const navigation = page.getByRole("navigation", { name: "Dossier sections" });
  await expect(navigation).toHaveCSS("position", "static");
  const link = navigation.getByRole("link", {
    name: "Historic Mythic boss evidence"
  });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#historic-mythic-evidence-heading$/);
  await expect(link).toHaveAttribute("aria-current", "location");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
