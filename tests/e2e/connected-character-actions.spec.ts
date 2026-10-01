import { expect, test, type Page } from "playwright/test";

import {
  seedCharacterEvidence,
  seedManualConnection,
  seedSnapshot
} from "./support/seed";

/**
 * #186: the row actions live behind a popup menu and a native confirmation
 * dialog. Component tests cover the fallback markup; the top layer, the inert
 * backdrop and the real click targets can only be proven in a browser.
 */
async function openDossierWithManualCharacter(
  page: Page,
  root: string,
  manual: string
) {
  const rootKey = { region: "eu", realm: "silvermoon", name: root } as const;
  const manualKey = {
    region: "eu",
    realm: "silvermoon",
    name: manual
  } as const;
  const title = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

  for (const key of [rootKey, manualKey]) {
    await seedSnapshot({
      key,
      displayName: title(key.name),
      refreshedAt: new Date()
    });
    await seedCharacterEvidence(key, { withSampleKills: false });
  }
  await seedManualConnection(rootKey, manualKey);
  await page.goto(`/dossiers/eu/silvermoon/${root}`);

  const panel = page.getByRole("region", { name: "Connected characters" });
  await expect(panel.getByText(title(manual))).toBeVisible();
  return {
    panel,
    trigger: page.getByRole("button", {
      name: `Actions for ${title(manual)}`
    })
  };
}

test("excludes a manually added character from the evidence and restores it", async ({
  page
}) => {
  const { panel, trigger } = await openDossierWithManualCharacter(
    page,
    "excluderoot",
    "excludable"
  );

  await trigger.click();
  await page.getByRole("menuitem", { name: "Exclude" }).click();

  await expect(
    page.getByText("Excludable is excluded from this dossier.")
  ).toBeVisible();
  await expect(panel.getByText("Excluded")).toBeVisible();

  await trigger.click();
  await expect(page.getByRole("menuitem", { name: "Exclude" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Include" }).click();

  await expect(
    page.getByText("Excludable is included in this dossier again.")
  ).toBeVisible();
  await expect(panel.getByText("Excluded")).toHaveCount(0);
});

test("unlinks a manually added character only after a real modal confirms it", async ({
  page
}) => {
  const { panel, trigger } = await openDossierWithManualCharacter(
    page,
    "removeroot",
    "removable"
  );

  await trigger.click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();

  const dialog = page.getByRole("dialog", {
    name: "Remove connected character"
  });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(
    true
  );
  await expect(dialog).toContainText("Removable");

  // Cancelling leaves the character where it was.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel.getByText("Removable")).toBeVisible();

  await trigger.click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await page.getByRole("button", { name: "Remove character" }).click();

  await expect(
    page.getByText("Removable has been removed from this dossier.")
  ).toBeVisible();
  await expect(panel.getByText("Removable")).toHaveCount(0);
});

test("offers Exclude and historic links for a source-discovered character", async ({
  page
}) => {
  const key = {
    region: "eu",
    realm: "silvermoon",
    name: "declaredroot"
  } as const;
  await seedSnapshot({
    key,
    displayName: "Declaredroot",
    refreshedAt: new Date(),
    characters: [
      {
        key,
        displayName: "Declaredroot",
        className: "Mage",
        level: 80
      },
      {
        key: { region: "eu", realm: "silvermoon", name: "declaredalt" },
        displayName: "Declaredalt",
        className: "Priest",
        level: 80
      }
    ]
  });
  await seedCharacterEvidence(key, { withSampleKills: false });
  await page.goto("/dossiers/eu/silvermoon/declaredroot");

  const panel = page.getByRole("region", { name: "Connected characters" });
  await expect(panel.getByText("Declaredalt")).toBeVisible();
  await page.getByRole("button", { name: "Actions for Declaredalt" }).click();
  await expect(page.getByRole("menuitem", { name: "Exclude" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Link historic alias…" })
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove…" })).toHaveCount(0);
});

test("links and removes a historic alias with a two-field modal and tooltip", async ({
  page
}) => {
  const root = {
    region: "eu",
    realm: "silvermoon",
    name: "aliasroot"
  } as const;
  const connected = {
    region: "eu",
    realm: "silvermoon",
    name: "aliascurrent"
  } as const;
  await seedSnapshot({
    key: root,
    displayName: "Aliasroot",
    refreshedAt: new Date(),
    characters: [
      { key: root, displayName: "Aliasroot", className: "Mage", level: 80 },
      {
        key: connected,
        displayName: "Aliascurrent",
        className: "Mage",
        level: 80
      }
    ]
  });
  await seedCharacterEvidence(root, { withSampleKills: false });
  await seedCharacterEvidence(connected, { withSampleKills: false });
  await page.goto("/dossiers/eu/silvermoon/aliasroot");
  const trigger = page.getByRole("button", {
    name: "Actions for Aliascurrent"
  });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Link historic alias…" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Link historic alias to Aliascurrent"
  });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(
    true
  );
  await expect(dialog.getByRole("textbox")).toHaveCount(2);
  await dialog.getByRole("textbox", { name: "Character name" }).fill("Erilla");
  await dialog.getByRole("textbox", { name: "Realm" }).fill("Neptulon");
  await dialog.getByRole("button", { name: "Link historic alias" }).click();
  const aliasIcon = page
    .getByRole("region", { name: "Connected characters" })
    .getByRole("button", { name: "Also known as" });
  // Hover only once the re-read dossier has given the name its icon.
  await expect(aliasIcon).toHaveCount(1);
  await aliasIcon.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Also known as: Erilla-Neptulon"
  );
  const tooltip = page.getByRole("tooltip");
  const iconBox = (await aliasIcon.boundingBox())!;
  const tooltipBox = (await tooltip.boundingBox())!;
  const crossingX = iconBox.x + iconBox.width / 2;
  const gapY = (iconBox.y + iconBox.height + tooltipBox.y) / 2;
  await page.mouse.move(crossingX, gapY);
  await expect(tooltip).toBeVisible();
  await page.mouse.move(crossingX, tooltipBox.y + tooltipBox.height / 2);
  await expect(tooltip).toBeVisible();
  // The text extends beyond the icon's hit area.
  await tooltip.hover({
    position: { x: tooltipBox.width - 10, y: tooltipBox.height / 2 }
  });
  await expect(tooltip).toBeVisible();
  await aliasIcon.hover();
  await expect(tooltip).toBeVisible();
  await page.mouse.move(
    tooltipBox.x + tooltipBox.width + 20,
    tooltipBox.y + tooltipBox.height + 20
  );
  await expect(tooltip).toBeHidden();
  await aliasIcon.hover();
  await expect(tooltip).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  await aliasIcon.hover();
  const narrowTooltipBox = (await tooltip.boundingBox())!;
  expect(narrowTooltipBox.x).toBeGreaterThanOrEqual(0);
  expect(narrowTooltipBox.x + narrowTooltipBox.width).toBeLessThanOrEqual(320);
  await page.setViewportSize({ width: 1280, height: 720 });
  await aliasIcon.hover();
  // Escape closes it although the pointer is still over the icon.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  // Returning by keyboard opens it, and tabbing away dismisses it.
  await aliasIcon.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(aliasIcon).toBeFocused();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(tooltip).toBeHidden();
  await page.reload();
  await expect(aliasIcon).toHaveCount(1);
  await aliasIcon.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Also known as: Erilla-Neptulon"
  );
  // A second click closes it although the button keeps focus.
  await aliasIcon.click();
  await expect(page.getByRole("tooltip")).toBeHidden();
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Remove historic alias erilla-neptulon" })
    .click();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});
