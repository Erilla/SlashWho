import { expect, test } from "playwright/test";

import { seedCharacterEvidence, seedSnapshot } from "./support/seed";

test("keeps dossier research accessible without horizontal overflow on mobile", async ({
  page
}) => {
  // Break caught: narrow screens could retain the retired character/history
  // layout or hide the applicant-research controls outside the viewport.
  const key = { region: "eu", realm: "silvermoon", name: "ryii" } as const;
  await seedSnapshot({
    key,
    displayName: "Ryii",
    // This layout fixture must be fresh: queued discovery is covered separately
    // and the shared fake Raider.IO fixture deliberately holds a refresh.
    refreshedAt: new Date()
  });
  await seedCharacterEvidence(key);

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
    .fill("https://raider.io/characters/eu/silvermoon/ryii");
  await page.getByRole("button", { name: "Research applicant" }).click();
  await expect(
    page.getByRole("heading", { name: "Historic Cutting Edge" })
  ).toBeVisible();
  const evidence = page.getByRole("group", { name: "Queen Ansurek evidence" });
  await evidence.getByText("View kill evidence").click();
  await expect(
    evidence
      .getByRole("link", {
        name: "View Warcraft Logs report (opens in a new tab)"
      })
      .first()
  ).toHaveAttribute("href", /e2eReport#fight=9$/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test("matches dossier summary panels and confines character scrolling to desktop", async ({
  page
}) => {
  // Break caught: the character panel could outgrow its neighbour, or retain a
  // nested scroll area after the dossier collapses to one column.
  const key = {
    region: "eu",
    realm: "silvermoon",
    name: "longlist"
  } as const;
  await seedSnapshot({
    key,
    displayName: "Longlist",
    refreshedAt: new Date(),
    characters: Array.from({ length: 12 }, (_, index) => ({
      key:
        index === 0
          ? key
          : {
              region: "eu" as const,
              realm: "silvermoon",
              name: `ryalt${index}`
            },
      displayName: index === 0 ? "Longlist" : `Ryalt${index}`,
      className: "Mage",
      level: 80 - index
    }))
  });

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/dossiers/eu/silvermoon/longlist");

  const characterPanel = page.getByRole("region", {
    name: "Connected characters"
  });
  const cuttingEdgePanel = page.getByRole("region", {
    name: "Historic Cutting Edge"
  });
  const characterList = page.getByRole("list", {
    name: "Connected characters"
  });
  const characterHeading = characterPanel.getByRole("heading", {
    name: "Connected characters"
  });
  const scrollHint = page.getByText(
    "Scroll to see more connected characters when available."
  );
  await expect(characterPanel).toBeVisible();
  await expect(cuttingEdgePanel).toBeVisible();
  await expect(scrollHint).toBeVisible();
  await expect(characterList).toHaveAttribute("tabindex", "0");
  await expect(characterList).toHaveAccessibleDescription(
    "Scroll to see more connected characters when available."
  );

  const desktopHeights = await Promise.all([
    characterPanel.evaluate(
      (element) => element.getBoundingClientRect().height
    ),
    cuttingEdgePanel.evaluate(
      (element) => element.getBoundingClientRect().height
    )
  ]);
  expect(Math.abs(desktopHeights[0] - desktopHeights[1])).toBeLessThan(1);
  expect(
    await characterList.evaluate(
      (element) => element.scrollHeight > element.clientHeight
    )
  ).toBe(true);
  const headingOffset = await characterHeading.evaluate(
    (element) =>
      element.getBoundingClientRect().top -
      element.closest("section")!.getBoundingClientRect().top
  );
  await characterList.focus();
  await page.keyboard.press("PageDown");
  await expect
    .poll(() => characterList.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(
    await characterHeading.evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        element.closest("section")!.getBoundingClientRect().top
    )
  ).toBe(headingOffset);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(characterList).not.toHaveAttribute("tabindex");
  await expect(characterList).toHaveAccessibleDescription("");
  await expect(scrollHint).not.toBeAttached();
  expect(
    await characterList.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      fullyExpanded: element.scrollHeight === element.clientHeight
    }))
  ).toEqual({ overflowY: "visible", fullyExpanded: true });
});

test("does not create a desktop scroll range when connected characters fit", async ({
  page
}) => {
  // Break caught: applying a fixed scroll viewport could create an awkward
  // nested scroll range even when every connected character is already visible.
  const key = {
    region: "eu",
    realm: "silvermoon",
    name: "shortlist"
  } as const;
  await seedSnapshot({
    key,
    displayName: "Shortlist",
    refreshedAt: new Date()
  });

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/dossiers/eu/silvermoon/shortlist");
  const characterList = page.getByRole("list", {
    name: "Connected characters"
  });
  await expect(characterList).toBeVisible();
  expect(
    await characterList.evaluate(
      (element) => element.scrollHeight === element.clientHeight
    )
  ).toBe(true);
});
