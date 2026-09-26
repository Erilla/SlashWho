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
  const connectedName = page
    .getByRole("region", { name: "Connected characters" })
    .locator(".dossier-character-name", { hasText: "Aliascurrent" });
  // The tooltip is CSS :hover, and Chromium does not re-evaluate hover for a
  // stationary pointer when the alias renders beneath it. Hover only once the
  // re-read dossier has given the name its tooltip.
  await expect(connectedName).toHaveAttribute("aria-describedby", /.+/);
  await connectedName.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Also known as: Erilla-Neptulon"
  );
  await page.reload();
  await expect(connectedName).toHaveAttribute("aria-describedby", /.+/);
  await connectedName.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Also known as: Erilla-Neptulon"
  );
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Remove historic alias erilla-neptulon" })
    .click();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});
