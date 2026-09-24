import { expect, test } from "playwright/test";

test("spreads the desktop timeline to the bottom of a tall viewport", async ({
  page
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/demo");

  const navigation = page.getByRole("navigation", { name: "Dossier sections" });
  const first = await navigation
    .getByRole("link", { name: "Connected characters" })
    .boundingBox();
  const last = await navigation
    .getByRole("link", { name: "Data limitations" })
    .boundingBox();
  expect(first).not.toBeNull();
  expect(last).not.toBeNull();
  const headerBottom = await page
    .locator(".site-header")
    .evaluate((header) => header.getBoundingClientRect().bottom);
  expect(first!.y - headerBottom).toBeGreaterThanOrEqual(24);
  expect(first!.y - headerBottom).toBeLessThanOrEqual(40);
  expect(1200 - (last!.y + last!.height)).toBeGreaterThanOrEqual(24);
  expect(1200 - (last!.y + last!.height)).toBeLessThanOrEqual(40);
  expect(first!.y).toBeLessThan(110);
  expect(last!.y + last!.height).toBeGreaterThan(1160);
  expect(last!.y + last!.height).toBeLessThanOrEqual(1200);

  const restingMarkWidth = (name: string) =>
    navigation
      .getByRole("link", { name })
      .evaluate((link) =>
        Number.parseFloat(getComputedStyle(link, "::after").width)
      );
  const sectionMark = await restingMarkWidth("Historic Cutting Edge");
  const raidMark = await restingMarkWidth("Raid: The Venomous Abyss");
  expect(sectionMark).toBeGreaterThan(raidMark);

  const majorLabels = navigation.locator(
    "a:not(.dossier-section-navigation-raid) .dossier-section-navigation-label"
  );
  for (const label of await majorLabels.all()) {
    const box = await label.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThan(120);
  }
});

test("navigates a long dossier without hiding targets behind the header", async ({
  page
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/demo");

  const navigation = page.getByRole("navigation", { name: "Dossier sections" });
  const raids = navigation.getByRole("link", { name: /^Raid:/ });
  expect(await raids.count()).toBeGreaterThan(20);
  await expect(navigation).toHaveCSS("position", "fixed");
  const rail = await navigation.boundingBox();
  const content = await page.locator(".dossier-layout").boundingBox();
  expect(rail).not.toBeNull();
  expect(content).not.toBeNull();
  expect(rail!.width).toBeLessThanOrEqual(48);
  expect(rail!.x).toBeGreaterThan(content!.x + content!.width);
  expect(rail!.x + rail!.width).toBeGreaterThan(1160);

  const firstRaid = raids.first();
  const raidLabel = firstRaid.locator(".dossier-section-navigation-label");
  await expect(raidLabel).toBeHidden();
  await firstRaid.hover();
  await expect(raidLabel).toBeVisible();
  const raidMark = await firstRaid.boundingBox();
  expect(raidMark).not.toBeNull();
  expect(raidMark!.height).toBeLessThanOrEqual(18);
  const longRaid = navigation.getByRole("link", {
    name: "Raid: Aberrus, the Shadowed Crucible"
  });
  await longRaid.hover();
  const longLabel = await longRaid
    .locator(".dossier-section-navigation-label")
    .boundingBox();
  expect(longLabel).not.toBeNull();
  expect(longLabel!.x).toBeGreaterThan(content!.x + content!.width);

  const mainSection = navigation.getByRole("link", {
    name: "Connected characters"
  });
  const mainLabel = mainSection.locator(".dossier-section-navigation-label");
  await expect(mainLabel).toBeVisible();
  const mutedColor = await mainLabel.evaluate(
    (label) => getComputedStyle(label).color
  );
  await mainSection.hover();
  await expect(mainLabel).toHaveCSS("color", "rgb(244, 244, 245)");
  expect(mutedColor).not.toBe("rgb(244, 244, 245)");

  const targetLink = raids.last();
  const targetId = (await targetLink.getAttribute("href"))!.slice(1);
  await targetLink.click();
  await expect(targetLink).toHaveAttribute("aria-current", "location");
  await targetLink.focus();
  await expect(
    targetLink.locator(".dossier-section-navigation-label")
  ).toBeVisible();
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
