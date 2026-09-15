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

test("offers no row actions for a source-discovered character", async ({
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
  await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(
    0
  );
});
