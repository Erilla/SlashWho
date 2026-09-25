import { expect, test } from "playwright/test";

test("centers a compact desktop timeline on a tall viewport", async ({
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
  const topSpace = first!.y - headerBottom;
  const bottomSpace = 1200 - (last!.y + last!.height);
  expect(last!.y + last!.height - first!.y).toBeLessThanOrEqual(400);
  expect(last!.y + last!.height - first!.y).toBeGreaterThanOrEqual(340);
  expect(Math.abs(topSpace - bottomSpace)).toBeLessThanOrEqual(20);

  const links = await navigation.locator("ol > li > a").all();
  expect(links.length).toBeGreaterThan(20);
  const hitAreas = await Promise.all(links.map((link) => link.boundingBox()));
  for (let index = 1; index < hitAreas.length; index += 1) {
    const previous = hitAreas[index - 1];
    const current = hitAreas[index];
    expect(previous).not.toBeNull();
    expect(current).not.toBeNull();
    expect(current!.y - (previous!.y + previous!.height)).toBeLessThanOrEqual(
      0.5
    );
  }

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

test("reveals the dossier page scrollbar while scrolling or near the edge", async ({
  page
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/demo");

  const root = page.locator("html");
  const scrollbarColor = () =>
    root.evaluate((element) => getComputedStyle(element).scrollbarColor);
  const hidden = "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)";
  await expect.poll(scrollbarColor).toBe(hidden);

  const scrollingColor = await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      window.addEventListener("scroll", () => resolve(), { once: true });
      window.scrollTo(0, 500);
    });
    return getComputedStyle(document.documentElement).scrollbarColor;
  });
  expect(scrollingColor).not.toBe(hidden);
  await expect.poll(scrollbarColor).toBe(hidden);

  await page.mouse.move(1178, 200);
  await expect.poll(scrollbarColor).not.toBe(hidden);
  await page.mouse.move(20, 200);
  await expect.poll(scrollbarColor).toBe(hidden);
});

test("colours raid ticks and names by evidence while keeping section hover white", async ({
  page
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/demo");

  const navigation = page.getByRole("navigation", { name: "Dossier sections" });
  const logged = navigation.getByRole("link", {
    name: "Raid: The Venomous Abyss"
  });
  const incomplete = navigation.getByRole("link", {
    name: "Raid: Ny'alotha, the Waking City"
  });
  await expect(logged).toHaveAttribute("data-evidence", "kill-log");
  await expect(logged).toHaveAttribute("aria-description", "Boss kill logged");
  await expect(logged).toHaveCSS("color", "rgb(54, 89, 66)");
  await logged.hover();
  await expect(logged).toHaveCSS("color", "rgb(108, 171, 122)");
  await expect(logged.locator(".dossier-section-navigation-label")).toHaveCSS(
    "color",
    "rgb(108, 171, 122)"
  );
  await expect(logged.locator(".dossier-section-navigation-label")).toHaveCSS(
    "visibility",
    "visible"
  );
  const raidLabel = await logged
    .locator(".dossier-section-navigation-label")
    .boundingBox();
  const evidenceHeading = await navigation
    .getByRole("link", { name: "Historic Mythic boss evidence" })
    .locator(".dossier-section-navigation-label")
    .boundingBox();
  expect(raidLabel).not.toBeNull();
  expect(evidenceHeading).not.toBeNull();
  expect(raidLabel!.y).toBeGreaterThanOrEqual(
    evidenceHeading!.y + evidenceHeading!.height
  );
  await expect(incomplete).toHaveAttribute("data-evidence", "incomplete");
  await expect(incomplete).toHaveCSS("color", "rgb(48, 48, 57)");

  const section = navigation.getByRole("link", {
    name: "Historic Cutting Edge"
  });
  await section.locator(".dossier-section-navigation-label").hover();
  await expect(section).toHaveCSS("color", "rgb(244, 244, 245)");
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
  expect(raidMark!.height).toBeGreaterThanOrEqual(10);
  expect(raidMark!.height).toBeLessThanOrEqual(14);
  const hoveredRaid = raids.nth(5);
  const hoveredItem = hoveredRaid.locator("..");
  const preceding = hoveredItem.locator("xpath=preceding-sibling::li[1]/a");
  const following = hoveredItem.locator("xpath=following-sibling::li[1]/a");
  const secondFollowing = hoveredItem.locator(
    "xpath=following-sibling::li[2]/a"
  );
  const markWidth = (link: typeof hoveredRaid) =>
    link.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element, "::after").width)
    );
  const restingWidth = await markWidth(following);
  await hoveredRaid.hover();
  expect(await markWidth(preceding)).toBeGreaterThan(restingWidth);
  expect(await markWidth(following)).toBeGreaterThan(restingWidth);
  expect(await markWidth(secondFollowing)).toBeGreaterThan(restingWidth);
  expect(await markWidth(following)).toBeGreaterThan(
    await markWidth(secondFollowing)
  );
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
    name: "Historic Cutting Edge"
  });
  const mainLabel = mainSection.locator(".dossier-section-navigation-label");
  await expect(mainLabel).toBeVisible();
  const mutedColor = await mainLabel.evaluate(
    (label) => getComputedStyle(label).color
  );
  await mainSection.hover();
  await expect(mainLabel).toHaveCSS("color", "rgb(244, 244, 245)");
  expect(mutedColor).not.toBe("rgb(244, 244, 245)");
  await mainSection.click();
  await expect(mainSection).toHaveAttribute("aria-current", "location");
  await page.mouse.move(20, 200);
  await expect(mainLabel).toHaveCSS("color", "rgb(244, 244, 245)");

  const targetLink = raids.last();
  const targetId = (await targetLink.getAttribute("href"))!.slice(1);
  await targetLink.click();
  await expect(targetLink).toHaveAttribute("aria-current", "location");
  await page.mouse.move(20, 200);
  await expect(
    targetLink.locator(".dossier-section-navigation-label")
  ).toBeVisible();
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

test("scrubs through dossier sections while dragging the desktop timeline", async ({
  page
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/demo");

  const navigation = page.getByRole("navigation", { name: "Dossier sections" });
  const first = navigation.getByRole("link", { name: "Connected characters" });
  const destination = navigation.getByRole("link", { name: /^Raid:/ }).nth(14);
  const destinationId = (await destination.getAttribute("href"))!.slice(1);
  const start = await first.boundingBox();
  const end = await destination.boundingBox();
  expect(start).not.toBeNull();
  expect(end).not.toBeNull();
  const historyLength = await page.evaluate(() => window.history.length);

  await page.mouse.move(
    start!.x + start!.width / 2,
    start!.y + start!.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, {
    steps: 12
  });
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(200);
  const draggedScrollY = await page.evaluate(() => window.scrollY);
  await page.mouse.up();
  await expect(page).toHaveURL(new RegExp(`#${destinationId}$`));
  await expect(destination).toHaveAttribute("aria-current", "location");
  await page.mouse.move(20, 200);
  await expect(
    destination.locator(".dossier-section-navigation-label")
  ).toBeVisible();
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

  const newPagePromise = page.context().waitForEvent("page", { timeout: 3000 });
  await first.click({ modifiers: ["Control"] });
  const newPage = await newPagePromise;
  await expect(newPage).toHaveURL(/#dossier-characters-heading$/);
  await newPage.close();

  await first.click();
  await expect(page).toHaveURL(/#dossier-characters-heading$/);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeLessThan(draggedScrollY);

  const rail = await navigation.boundingBox();
  expect(rail).not.toBeNull();
  await page.mouse.move(
    start!.x + start!.width / 2,
    start!.y + start!.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(end!.x + end!.width / 2, rail!.y + rail!.height + 30, {
    steps: 12
  });
  await page.mouse.up();
  await expect(page).toHaveURL(/#limitations-heading$/);
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
