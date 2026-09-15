import { expect, test } from "playwright/test";

import { seedCharacterEvidence, seedSnapshot } from "./support/seed";

/**
 * jsdom implements neither showModal nor close, so the component tests exercise
 * the open-attribute fallback and the submit logic. Everything the platform
 * owns — the top layer, the inert backdrop, native Escape, and the focus trap —
 * can only be proven in a real browser, which is what this spec covers.
 */
async function openDossierWithDialog(
  page: import("playwright/test").Page,
  name: string
) {
  const key = { region: "eu", realm: "silvermoon", name } as const;
  await seedSnapshot({
    key,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    refreshedAt: new Date()
  });
  await seedCharacterEvidence(key, { withSampleKills: false });
  await page.goto(`/dossiers/eu/silvermoon/${name}`);
  return page.getByRole("button", { name: "Add character" });
}

test("opens the add-character dialog as a real modal with focus in the first field", async ({
  page
}) => {
  const trigger = await openDossierWithDialog(page, "dialogopen");

  const panel = page.getByRole("region", { name: "Connected characters" });
  await expect(trigger).toBeVisible();
  // #148: the panel must not show idle text fields before the dialog opens.
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Add connected character" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(
    true
  );
  await expect(
    dialog.getByRole("textbox", { name: "Character/URL" })
  ).toBeFocused();
  // Realm and region stay hidden until a character is entered.
  await expect(dialog.getByRole("textbox", { name: "Realm" })).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Region" })).toHaveCount(0);
});

test("reveals the realm and region once a character is entered", async ({
  page
}) => {
  const trigger = await openDossierWithDialog(page, "dialogreveal");
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Add connected character" });
  await dialog.getByRole("textbox", { name: "Character/URL" }).fill("Ryalts");

  await expect(dialog.getByRole("textbox", { name: "Realm" })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Region" })).toBeVisible();
});

test("keeps the page behind the dialog inert", async ({ page }) => {
  // Break caught: a dialog rendered without the top layer leaves the dossier
  // behind it clickable, which #148 rules out.
  const trigger = await openDossierWithDialog(page, "dialoginert");
  await trigger.click();

  await expect(page.getByRole("dialog")).toBeVisible();
  const heading = page.getByRole("heading", { name: "Connected characters" });
  expect(
    await heading.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const topMost = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2
      );
      return element.contains(topMost);
    })
  ).toBe(false);
});

test("closes on Escape and returns focus to the add action", async ({
  page
}) => {
  const trigger = await openDossierWithDialog(page, "dialogescape");
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("closes on Cancel and returns focus to the add action", async ({
  page
}) => {
  const trigger = await openDossierWithDialog(page, "dialogcancel");
  await trigger.click();

  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("keeps keyboard navigation inside the dialog", async ({ page }) => {
  // Break caught: without the top layer, Tab walks out of the dialog into the
  // dossier and the header search behind it.
  //
  // Chromium wraps a modal dialog's focus cycle through document.body, which is
  // not an interactive element and not an escape. What matters is that no
  // control behind the dialog can ever take focus.
  const trigger = await openDossierWithDialog(page, "dialogtrap");
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const visited: string[] = [];
  for (let press = 0; press < 8; press += 1) {
    await page.keyboard.press("Tab");
    visited.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return "body";
        return document.querySelector("dialog")?.contains(active)
          ? "dialog"
          : `escaped:${active.tagName}`;
      })
    );
  }

  expect(visited.filter((step) => step.startsWith("escaped:"))).toEqual([]);
  expect(visited).toContain("dialog");
});

test("reports an entry that is not a character without closing", async ({
  page
}) => {
  const trigger = await openDossierWithDialog(page, "dialogvalidation");
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Character/URL" }).fill("Ryalts");
  await dialog.getByRole("button", { name: "Add connected character" }).click();

  await expect(dialog.getByRole("alert")).toHaveText(
    "Enter a valid character URL, or character name, realm, and region."
  );
  await expect(dialog).toBeVisible();
});

test("fits the dialog inside a narrow viewport without overflow", async ({
  page
}) => {
  // Break caught: a fixed-width dialog overflows a phone viewport and the
  // revealed realm and region push its controls outside the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = await openDossierWithDialog(page, "dialognarrow");
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Character/URL" }).fill("Ryalts");
  await expect(dialog.getByRole("combobox", { name: "Region" })).toBeVisible();

  const width = await dialog.evaluate(
    (element) => element.getBoundingClientRect().width
  );
  expect(width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
