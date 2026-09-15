import { expect, test, type Locator } from "playwright/test";

import { seedCharacterEvidence, seedSnapshot } from "./support/seed";

async function raidBannerGeometry(heading: Locator) {
  return heading.evaluate((element) => {
    const image = element.querySelector("img");
    const bounds = element.getBoundingClientRect();
    const raid = element.closest<HTMLElement>(".dossier-raid")!;
    const raidStyle = getComputedStyle(raid);
    return {
      width: bounds.width,
      height: bounds.height,
      raidContentWidth:
        raid.clientWidth -
        Number.parseFloat(raidStyle.paddingLeft) -
        Number.parseFloat(raidStyle.paddingRight),
      objectFit: image ? getComputedStyle(image).objectFit : null
    };
  });
}

test("keeps the fixed header visible and offset-safe while dossier scrolling", async ({
  page
}) => {
  await seedSnapshot({
    key: { region: "eu", realm: "silvermoon", name: "ryii" },
    displayName: "Ryii",
    refreshedAt: new Date()
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByLabel("Applicant URL")
    .fill("https://raider.io/characters/eu/silvermoon/ryii");
  await page.getByRole("button", { name: "Research applicant" }).click();
  await expect(page).toHaveURL(
    /\/dossiers\/eu\/silvermoon\/ryii(?:\?job=[\da-f-]+)?$/
  );

  const profileLinks = page.locator(".dossier-heading .upstream-icon-link");
  await expect(profileLinks).toHaveCount(2);
  await expect(profileLinks.nth(0)).toHaveAccessibleName(
    "View Ryii on Raider.IO (opens in a new tab)"
  );
  await expect(profileLinks.nth(1)).toHaveAccessibleName(
    "View Ryii on Warcraft Logs (opens in a new tab)"
  );
  const profileLinkDetails = await profileLinks.evaluateAll((links) =>
    links.map((link) => {
      const bounds = link.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        hasIcon: Boolean(link.querySelector("svg")),
        target: link.getAttribute("target"),
        rel: link.getAttribute("rel")
      };
    })
  );
  for (const details of profileLinkDetails) {
    expect(details.width).toBeGreaterThanOrEqual(24);
    expect(details.width).toBeLessThanOrEqual(28);
    expect(details.height).toBe(details.width);
    expect(details.hasIcon).toBe(true);
    expect(details.target).toBe("_blank");
    expect(details.rel).toBe("noopener noreferrer");
  }

  const header = page.locator(".site-header");
  await expect(header).toHaveCSS("position", "fixed");
  await expect(header.getByLabel("Applicant URL")).toBeVisible();
  const headline = page.getByRole("heading", { name: "Historic Cutting Edge" });
  const headerRectBeforeScroll = await header.evaluate((element) =>
    element.getBoundingClientRect()
  );
  const headlineRectBeforeScroll = await headline.evaluate((element) =>
    element.getBoundingClientRect()
  );
  expect(headerRectBeforeScroll.bottom).toBeGreaterThan(0);
  expect(headlineRectBeforeScroll.top).toBeGreaterThan(
    headerRectBeforeScroll.bottom + 2
  );
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(header).toBeVisible();
  const headerRect = await header.evaluate((element) =>
    element.getBoundingClientRect()
  );
  const headerTop = headerRect.top;
  const headerBottom = headerRect.bottom;
  expect(headerTop).toBeLessThanOrEqual(1);
  expect(headerBottom).toBeGreaterThan(1);
});

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
  const reportLinks = evidence.getByRole("link", {
    name: /View Warcraft Logs report/
  });
  await expect(reportLinks).toHaveCount(2);
  expect(
    await reportLinks.evaluateAll((links) =>
      links.map((link) => ({
        accessibleName: link.getAttribute("aria-label"),
        href: link.getAttribute("href")
      }))
    )
  ).toEqual([
    {
      accessibleName: "View Warcraft Logs report 1 (opens in a new tab)",
      href: "https://www.warcraftlogs.com/reports/e2eReport#fight=10"
    },
    {
      accessibleName: "View Warcraft Logs report 2 (opens in a new tab)",
      href: "https://www.warcraftlogs.com/reports/e2eReport#fight=9"
    }
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test("keeps landing search modes compact and usable at desktop and mobile widths", async ({
  page
}) => {
  // Break caught: equal flexible tracks made the character-name and realm
  // controls dominate the structured desktop form, while constrained tracks
  // must still collapse without overflowing on small screens.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  const urlInput = page.getByLabel("Applicant URL");
  await expect(urlInput).toBeVisible();
  await page.getByRole("radio", { name: "Character name + realm" }).check();

  const [nameWidth, realmWidth, regionWidth] = await Promise.all([
    page
      .getByRole("textbox", { name: "Character name" })
      .evaluate((element) => element.getBoundingClientRect().width),
    page
      .getByRole("textbox", { name: "Realm" })
      .evaluate((element) => element.getBoundingClientRect().width),
    page
      .getByLabel("Region")
      .evaluate((element) => element.getBoundingClientRect().width)
  ]);
  expect(nameWidth).toBeLessThanOrEqual(192);
  expect(realmWidth).toBeLessThanOrEqual(192);
  expect(regionWidth).toBeLessThanOrEqual(160);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("textbox", { name: "Character name" }).fill("Ryii");
  await page.getByRole("textbox", { name: "Realm" }).fill("the-shatar");
  await page.getByRole("textbox", { name: "Character name" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Realm" })).toBeFocused();
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).resolves.toBe(true);
});

test("centers landing search controls within the header", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  const geometry = await page.locator(".site-header").evaluate((header) => {
    const control = header.querySelector(".search-input")!;
    const button = header.querySelector(".search-button")!;
    const headerBounds = header.getBoundingClientRect();
    const controlBounds = control.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    const buttonStyle = getComputedStyle(button);
    return {
      headerCenter: headerBounds.top + headerBounds.height / 2,
      controlCenter: controlBounds.top + controlBounds.height / 2,
      buttonCenter: buttonBounds.top + buttonBounds.height / 2,
      buttonDisplay: buttonStyle.display,
      buttonAlignItems: buttonStyle.alignItems,
      buttonJustifyContent: buttonStyle.justifyContent
    };
  });

  expect(Math.abs(geometry.controlCenter - geometry.headerCenter)).toBeLessThan(
    1
  );
  expect(Math.abs(geometry.buttonCenter - geometry.headerCenter)).toBeLessThan(
    1
  );
  expect(geometry.buttonDisplay).toBe("flex");
  expect(geometry.buttonAlignItems).toBe("center");
  expect(geometry.buttonJustifyContent).toBe("center");
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
  const characters = Array.from({ length: 12 }, (_, index) => ({
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
  }));
  await seedSnapshot({
    key,
    displayName: "Longlist",
    refreshedAt: new Date(),
    characters
  });
  await Promise.all(
    characters.map((character) =>
      seedCharacterEvidence(character.key, { withSampleKills: false })
    )
  );
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
  await seedCharacterEvidence(key, { withSampleKills: false });

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
  expect(
    await characterList.evaluate((element) => ({
      paddingInlineEnd: getComputedStyle(element).paddingInlineEnd,
      scrollbarGutter: getComputedStyle(element).scrollbarGutter
    }))
  ).toEqual({ paddingInlineEnd: "0px", scrollbarGutter: "auto" });
});

test("keeps overflowing connected characters clear of classic and overlay scrollbars", async ({
  page
}) => {
  // Break caught: scrollbar tracks could cover achievement cards or character
  // badges and icon links when either summary list became scrollable.
  const key = { region: "eu", realm: "silvermoon", name: "clearance" } as const;
  const characters = Array.from({ length: 12 }, (_, index) => ({
    key:
      index === 0
        ? key
        : {
            region: "eu" as const,
            realm: "silvermoon",
            name: `clearancealt${index}`
          },
    displayName: index === 0 ? "Clearance" : `Clearancealt${index}`,
    className: "Mage",
    level: 80 - index
  }));
  await seedSnapshot({
    key,
    displayName: "Clearance",
    refreshedAt: new Date(),
    characters
  });
  await Promise.all(
    characters.map((character) =>
      seedCharacterEvidence(character.key, { withSampleKills: false })
    )
  );
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/dossiers/eu/silvermoon/clearance");
  await page.addStyleTag({
    content: `
      .dossier-character-list { max-height: 3rem; min-height: 0; }
    `
  });

  const list = page.getByRole("list", { name: "Connected characters" });
  await expect(list).toHaveAttribute("tabindex", "0");
  expect(
    await list.evaluate((element) => ({
      paddingInlineEnd: Number.parseFloat(
        getComputedStyle(element).paddingInlineEnd
      ),
      scrollbarGutter: getComputedStyle(element).scrollbarGutter
    }))
  ).toEqual({ paddingInlineEnd: 16, scrollbarGutter: "stable" });
  await expect(list).toHaveCSS("overflow-x", "hidden");
  await list.focus();
  await page.keyboard.press("PageDown");
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
});

test("separates adjacent raid evidence with responsive artwork banners", async ({
  page
}) => {
  // Break caught: raid sections could collapse back to small icon-and-text rows
  // or overflow once a dossier contains artwork for multiple raids.
  const key = {
    region: "eu",
    realm: "silvermoon",
    name: "banner"
  } as const;
  await seedSnapshot({ key, displayName: "Banner", refreshedAt: new Date() });
  await seedCharacterEvidence(key, { withSecondRaid: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page
    .getByLabel("Applicant URL")
    .fill("https://raider.io/characters/eu/silvermoon/banner");
  await page.getByRole("button", { name: "Research applicant" }).click();

  const nerubar = page.getByRole("heading", {
    level: 3,
    name: "Nerub-ar Palace"
  });
  const vault = page.getByRole("heading", {
    level: 3,
    name: "Vault of the Incarnates"
  });
  await expect(nerubar).toBeVisible();
  await expect(vault).toBeVisible();
  await expect(nerubar.getByRole("img")).toHaveCount(0);
  await expect(vault.getByRole("img")).toHaveCount(0);

  const desktopBanners = await Promise.all([
    raidBannerGeometry(nerubar),
    raidBannerGeometry(vault)
  ]);
  for (const banner of desktopBanners) {
    expect(banner.width).toBeGreaterThan(400);
    expect(Math.abs(banner.width - banner.raidContentWidth)).toBeLessThan(1);
    expect(banner.height).toBeGreaterThanOrEqual(112);
    expect(banner.objectFit).toBe("cover");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const heading of [nerubar, vault]) {
    const banner = await raidBannerGeometry(heading);
    expect(Math.abs(banner.width - banner.raidContentWidth)).toBeLessThan(1);
    expect(banner.width).toBeLessThanOrEqual(390);
    expect(banner.height).toBeGreaterThanOrEqual(104);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test("keeps the scrolled header identity clear of the header search", async ({
  page
}) => {
  // Break caught: the scrolled-in character identity was centred on the
  // viewport independently of the header grid, so between the two-row
  // breakpoint and roughly 860px it was drawn straight over the search field.
  const key = { region: "eu", realm: "silvermoon", name: "overlap" } as const;
  const characters = Array.from({ length: 12 }, (_, index) => ({
    key:
      index === 0
        ? key
        : {
            region: "eu" as const,
            realm: "silvermoon",
            name: `overlapalt${index}`
          },
    displayName: index === 0 ? "Overlap" : `Overlapalt${index}`,
    className: "Mage",
    level: 80 - index
  }));
  await seedSnapshot({
    key,
    displayName: "Overlap",
    refreshedAt: new Date(),
    characters
  });
  await Promise.all(
    characters.map((character) => seedCharacterEvidence(character.key))
  );

  await page.goto("/dossiers/eu/silvermoon/overlap");
  // The identity only appears once the dossier heading has scrolled away, so
  // the page has to be fully rendered before the viewport sweep begins.
  await expect(
    page.getByRole("heading", { name: "Historic Cutting Edge" })
  ).toBeVisible();

  const identity = page.locator(".dossier-header-identity");
  for (const width of [390, 544, 560, 700, 768, 820, 900, 1280]) {
    await page.setViewportSize({ width, height: 600 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(identity).toBeVisible();

    const geometry = await page.evaluate(() => {
      const bounds = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect();
      const identityBounds = bounds(".dossier-header-identity");
      const overlapWith = (selector: string) => {
        const other = bounds(selector);
        const horizontal =
          Math.min(identityBounds.right, other.right) -
          Math.max(identityBounds.left, other.left);
        const vertical =
          Math.min(identityBounds.bottom, other.bottom) -
          Math.max(identityBounds.top, other.top);
        return horizontal > 0 && vertical > 0 ? Math.round(horizontal) : 0;
      };
      return {
        width: Math.round(identityBounds.width),
        searchInput: overlapWith(".header-search .search-input"),
        searchButton: overlapWith(".header-search .search-button"),
        nav: overlapWith(".site-nav"),
        logo: overlapWith(".header-logo")
      };
    });

    expect({ viewport: width, ...geometry }).toEqual({
      viewport: width,
      width: geometry.width,
      searchInput: 0,
      searchButton: 0,
      nav: 0,
      logo: 0
    });
    expect(geometry.width).toBeGreaterThan(0);
  }
});
