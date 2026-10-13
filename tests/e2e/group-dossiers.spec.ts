import { expect, test, type Page } from "playwright/test";
import { Pool } from "pg";
import { seedCharacterEvidence, seedSnapshot } from "./support/seed";

async function seedGroup(prefix: string, stale = false) {
  const root = {
    region: "eu",
    realm: "silvermoon",
    name: `${prefix}root`
  } as const;
  const sibling = { ...root, name: `${prefix}alt` };
  await seedSnapshot({
    key: root,
    displayName: "Group root",
    refreshedAt: new Date(Date.now() - (stale ? 48 * 3_600_000 : 0)),
    characters: [
      { key: root, displayName: "Group root", className: "Mage", level: 80 },
      {
        key: sibling,
        displayName: "Group sibling",
        className: "Priest",
        level: 80
      }
    ]
  });
  for (const key of [root, sibling])
    await seedCharacterEvidence(key, { withSampleKills: false });
  // Isolate the page's discovery start from the independent weekly sweep.
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO fingerprint_sweep_states (region, realm_slug, normalized_name, last_published_at) VALUES ($1, $2, $3, now()) ON CONFLICT (region, realm_slug, normalized_name) DO UPDATE SET last_published_at = now()`,
      [root.region, root.realm, root.name]
    );
  } finally {
    await pool.end();
  }
  return { root, sibling };
}

function starts(page: Page) {
  const bodies: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/dossiers"
    )
      bodies.push(request.postDataJSON());
  });
  return bodies;
}

test("a fresh sibling opens the group with no automatic start", async ({
  page
}) => {
  const { sibling } = await seedGroup("freshgroup");
  const requests = starts(page);
  await page.goto(`/dossiers/eu/silvermoon/${sibling.name}`);
  const panel = page.getByRole("region", { name: "Connected characters" });
  await expect(panel.getByText("Group root", { exact: true })).toBeVisible();
  await expect(panel.getByText("Group sibling", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Group sibling", exact: true })
  ).toBeVisible();
  expect(requests).toEqual([]);
});

test("a stale group starts once and keeps its page after refusal", async ({
  page
}) => {
  const { sibling } = await seedGroup("stalegroup", true);
  const requests = starts(page);
  await page.route("**/api/dossiers", (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "rate_limited", message: "Too many requests." }
      })
    })
  );
  await page.goto(`/dossiers/eu/silvermoon/${sibling.name}`);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ startedFrom: "page" });
  await expect(
    page
      .getByRole("region", { name: "Connected characters" })
      .getByText("Group root", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "Too many requests" })
  ).toHaveCount(0);
});

test("excluding and including from a sibling changes the shared dossier", async ({
  page
}) => {
  const { root, sibling } = await seedGroup("editgroup");
  await page.goto(`/dossiers/eu/silvermoon/${sibling.name}`);
  await page.getByRole("button", { name: "Actions for Group root" }).click();
  await page.getByRole("menuitem", { name: "Exclude", exact: true }).click();
  await expect(
    page.getByText("Group root is excluded from this dossier.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Actions for Group root" }).click();
  await page.getByRole("menuitem", { name: "Include", exact: true }).click();
  await expect(
    page.getByText("Group root is included in this dossier again.")
  ).toBeVisible();
  await page.goto(`/dossiers/eu/silvermoon/${root.name}`);
  await page.getByRole("button", { name: "Actions for Group root" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Exclude", exact: true })
  ).toHaveCount(0);
});
