import { expect, test, type Page } from "playwright/test";

import {
  accountMailLink,
  seedSnapshot,
  seedVerifiedAccount
} from "./support/seed";

const password = "e2e-account-password-long-enough";

async function signIn(page: Page, email: string) {
  await page.goto("/operations/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/account$/);
}

test("anonymous visitor can search and open a dossier", async ({ page }) => {
  await seedSnapshot({
    key: { region: "eu", realm: "silvermoon", name: "accountpublic" },
    displayName: "Accountpublic",
    refreshedAt: new Date()
  });
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Create account" })
  ).toBeVisible();
  await page
    .getByLabel("Character/URL")
    .fill("https://raider.io/characters/eu/silvermoon/Accountpublic");
  await page.getByRole("button", { name: "Research applicant" }).click();
  await expect(page).toHaveURL(/\/dossiers\/eu\/silvermoon\/accountpublic/);
  await expect(
    page.getByRole("heading", { name: /Accountpublic/i }).first()
  ).toBeVisible();
});

test("registration needs mailbox verification before sign-in", async ({
  page
}) => {
  const email = "browser-registration@example.test";
  await page.goto("/account/create");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("check your email");

  await page.goto("/operations/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByText("Sign in failed. Check your email and password.")
  ).toBeVisible();

  await page.goto(await accountMailLink(email));
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByRole("status")).toContainText(/verif/i);
  await signIn(page, email);
});

test("ordinary account is denied admin settings and collection monitor", async ({
  page
}) => {
  const email = "browser-user@example.test";
  await seedVerifiedAccount(email, password);
  await signIn(page, email);
  await page.goto("/admin/settings");
  await expect(page).toHaveURL(/\/operations\/login$/);
  await page.goto("/operations/collection-monitor");
  await expect(page).toHaveURL(/\/operations\/login$/);
  const response = await page.request.get("/api/operations/collection-monitor");
  expect(response.status()).toBe(401);
});

test("browser key imports into a signed-in account and clears local copy", async ({
  page
}) => {
  const email = "browser-import@example.test";
  await seedVerifiedAccount(email, password);
  await page.goto("/settings");
  await page.getByLabel("Access key").fill("browser-raiderio-key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await signIn(page, email);
  await page.goto("/settings");
  await expect(
    page.getByRole("button", { name: "Import browser copy" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Import browser copy" }).click();
  await expect(page.getByRole("status")).toContainText("raiderio saved");
  await expect(page.getByText("Saved in account")).toHaveCount(1);
  const stored = await page.evaluate(() =>
    localStorage.getItem("slashwho:api-credentials")
  );
  expect(stored).not.toContain("browser-raiderio-key");
});

test("keyboard navigation and validation feedback keep visible focus", async ({
  page
}) => {
  await page.goto("/operations/login");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  const focusStyle = await page
    .locator(":focus")
    .evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(focusStyle).not.toBe("none");
  await page.getByLabel("Email address").fill("nobody@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByText("Sign in failed. Check your email and password.")
  ).toBeFocused();
});
