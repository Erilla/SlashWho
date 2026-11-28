import {
  expect,
  test,
  type APIRequestContext,
  type Page
} from "playwright/test";
import { Pool } from "pg";
import { applicantDossierSchema } from "@slashwho/contracts";
type FixtureStats = { characterRequests: Record<string, number> };
import { createPostgresRepositories } from "../../packages/database/src/postgres-repositories";
import {
  seedCharacterEvidence,
  seedManualConnection,
  seedSnapshot
} from "./support/seed";

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

// Force observable progress-only cycles while preserving the real group read.
// A second POST after a progress patch is the regression this fixture catches.
async function followLiveEvidence(
  page: Page,
  request: APIRequestContext,
  key: { region: string; realm: string; name: string }
) {
  const path = `/api/dossiers/${key.region}/${key.realm}/${key.name}`;
  const response = await request.get(path);
  expect(response.ok()).toBeTruthy();
  const stored = applicantDossierSchema.parse(await response.json());
  const runId = "10000000-0000-4000-8000-000000000013";
  let cycles = 0;
  await page.route(`**${path}`, (route) =>
    route.fulfill({
      json: {
        ...stored,
        evidenceRunIds: [runId],
        characters: stored.characters.map(
          (character: { key: { name: string } }) => ({
            ...character,
            ...(character.key.name === key.name
              ? { evidenceState: "scanning" }
              : {})
          })
        )
      }
    })
  );
  await page.route("**/api/dossiers/evidence-runs?*", (route) => {
    cycles += 1;
    return route.fulfill({
      json: {
        runs: [
          {
            id: runId,
            key,
            state: "running",
            version: `running-${cycles}`,
            evidenceState: "scanning",
            collectionProgress: []
          }
        ]
      }
    });
  });
  return () => cycles;
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
  const progressCycles = await followLiveEvidence(page, page.request, sibling);
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
  await expect.poll(progressCycles).toBeGreaterThanOrEqual(3);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ startedFrom: "page" });
  await expect(
    page
      .getByRole("region", { name: "Connected characters" })
      .getByText("Group root", { exact: true })
  ).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
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

for (const outcome of ["failed", "refused"] as const) {
  test(`a stale sibling retains its group after joined research is ${outcome}`, async ({
    page
  }) => {
    const { sibling } = await seedGroup(`joined${outcome}`, true);
    const requests = starts(page);
    const progressCycles = await followLiveEvidence(
      page,
      page.request,
      sibling
    );
    const jobId = "ca3ccfdf-1e8b-49b1-9729-459f42a104c0";
    await page.route("**/api/dossiers", (route) =>
      route.fulfill({
        status: 202,
        json: { kind: "job", jobId, status: "running" }
      })
    );
    await page.route(`**/api/dossiers/jobs/${jobId}`, (route) =>
      route.fulfill(
        outcome === "failed"
          ? {
              json: {
                status: "failed",
                error: {
                  code: "upstream_unavailable",
                  message: "Joined research failed."
                }
              }
            }
          : {
              status: 403,
              json: {
                error: {
                  code: "unauthorized",
                  message: "Joined research is unavailable."
                }
              }
            }
      )
    );
    await page.goto(`/dossiers/eu/silvermoon/${sibling.name}`);
    await expect.poll(progressCycles).toBeGreaterThanOrEqual(3);
    await expect(
      page.getByText("Researching applicant dossier…", { exact: true })
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Connected characters" })
        .getByText("Group root", { exact: true })
    ).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ startedFrom: "page" });
  });
}

test("removing a manual connection retains a character linked by its provider", async ({
  page
}) => {
  const { root, sibling } = await seedGroup("providerremove");
  await seedManualConnection(root, sibling);
  await page.goto(`/dossiers/eu/silvermoon/${root.name}`);
  await page.getByRole("button", { name: "Actions for Group sibling" }).click();
  await page.getByRole("menuitem", { name: "Remove…", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove character", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Connected characters" })
      .getByText("Group sibling", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Actions for Group sibling" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Remove…", exact: true })
  ).toHaveCount(0);
});

test("a group rejects an alias matching the opened character's normalized identity", async ({
  page
}) => {
  const { sibling } = await seedGroup("selfalias");
  await page.goto(`/dossiers/eu/silvermoon/${sibling.name}`);
  await page.getByRole("button", { name: "Actions for Group sibling" }).click();
  await page.getByRole("menuitem", { name: "Link historic alias…" }).click();
  await page
    .getByRole("textbox", { name: "Character name" })
    .fill(sibling.name.toUpperCase());
  await page.getByRole("textbox", { name: "Realm" }).fill("Silvermoon");
  await page
    .getByRole("button", { name: "Link historic alias", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "A character cannot be its own historic alias."
  );
  await expect(
    page.getByRole("dialog", { name: "Link historic alias to Group sibling" })
  ).toBeVisible();
});

test("Include and Remove from a surviving group page clear a suppressed maker's manual row", async ({
  page
}) => {
  const { root, sibling } = await seedGroup("suppressedmaker");
  await seedSnapshot({
    key: sibling,
    displayName: "Group sibling",
    refreshedAt: new Date()
  });
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
  try {
    const repositories = createPostgresRepositories(pool);
    await repositories.manualConnections.add(root, sibling);
    await repositories.manualConnections.setExcluded(root, sibling, true);
    await repositories.suppressions.suppress(root, "privacy", null);
    await page.goto(`/dossiers/eu/silvermoon/${sibling.name}`);
    await expect(
      page.getByRole("heading", { name: "Group sibling", exact: true })
    ).toBeVisible();
    const path = `/api/dossiers/eu/silvermoon/${sibling.name}/connected-characters`;
    const characterUrl = `https://raider.io/characters/eu/silvermoon/${sibling.name}`;
    const includeStatus = await page.evaluate(
      async ({ path, characterUrl }) => {
        return (
          await fetch(path, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ characterUrl, excluded: false })
          })
        ).status;
      },
      { path, characterUrl }
    );
    expect(includeStatus).toBe(200);
    const rows = await pool.query(
      "SELECT excluded_at FROM manual_dossier_connections WHERE connected_normalized_name = $1",
      [sibling.name]
    );
    expect(rows.rows).toEqual([{ excluded_at: null }]);
    const removeStatus = await page.evaluate(
      async ({ path, characterUrl }) => {
        return (
          await fetch(path, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ characterUrl })
          })
        ).status;
      },
      { path, characterUrl }
    );
    expect(removeStatus).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM manual_dossier_connections WHERE connected_normalized_name = $1",
          [sibling.name]
        )
      ).rows
    ).toEqual([]);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Group sibling", exact: true })
    ).toBeVisible();
  } finally {
    await pool.end();
  }
});

test("a provider 404 for the opened sibling retains its stored group", async ({
  page
}) => {
  // Synthetic names deliberately return 404 in the real fake Raider.IO server.
  const { sibling } = await seedGroup("missingprovider", true);
  await page.goto(`/dossiers/eu/silvermoon/${sibling.name}`);
  const fixtureBaseUrl = process.env.E2E_RAIDER_IO_BASE_URL!;
  await expect
    .poll(async () => {
      const stats = await fetch(`${fixtureBaseUrl}/__control/stats`).then(
        (response) => response.json() as Promise<FixtureStats>
      );
      return (
        stats.characterRequests[
          `/api/characters/eu/silvermoon/${sibling.name}`
        ] ?? 0
      );
    })
    .toBeGreaterThan(0);
  const response = await page.request.get(
    `/api/dossiers/eu/silvermoon/${sibling.name}`
  );
  expect(response.ok()).toBeTruthy();
  const body = applicantDossierSchema.parse(await response.json());
  expect(
    body.characters.map(
      (character: { displayName: string }) => character.displayName
    )
  ).toEqual(expect.arrayContaining(["Group root", "Group sibling"]));
  await expect(
    page
      .getByRole("region", { name: "Connected characters" })
      .getByText("Group root", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Group sibling", exact: true })
  ).toBeVisible();
});

test("recent failed member research suppresses a page start but landing search reserves and records it", async ({
  page
}) => {
  const root = {
    region: "eu",
    realm: "silvermoon",
    name: "backoffgroup"
  } as const;
  const sibling = { ...root, name: "ryun" };
  await seedSnapshot({
    key: root,
    displayName: "Backoff root",
    refreshedAt: new Date(Date.now() - 48 * 3_600_000),
    characters: [
      { key: root, displayName: "Backoff root", className: "Mage", level: 80 },
      { key: sibling, displayName: "Ryun", className: "Warrior", level: 80 }
    ]
  });
  for (const key of [root, sibling])
    await seedCharacterEvidence(key, { withSampleKills: false });
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
  try {
    const run = await createPostgresRepositories(pool).runs.createOrReuse(
      root,
      "anonymous"
    );
    await pool.query(
      "UPDATE discovery_runs SET status = 'failed', completed_at = now() WHERE id = $1",
      [run.id]
    );
    await pool.query(
      "INSERT INTO fingerprint_sweep_states (region, realm_slug, normalized_name, last_published_at) VALUES ($1, $2, $3, now()) ON CONFLICT (region, realm_slug, normalized_name) DO UPDATE SET last_published_at = now()",
      [root.region, root.realm, root.name]
    );
    const requests = starts(page);
    await page.goto(`/dossiers/eu/silvermoon/${sibling.name}`);
    await expect(
      page
        .getByRole("region", { name: "Connected characters" })
        .getByText("Backoff root", { exact: true })
    ).toBeVisible();
    const read = await page.request.get(
      `/api/dossiers/eu/silvermoon/${sibling.name}`
    );
    expect(applicantDossierSchema.parse(await read.json()).groupStale).not.toBe(
      true
    );
    expect(requests).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM dossier_searches WHERE normalized_name = $1",
          [sibling.name]
        )
      ).rows
    ).toEqual([]);
    await page.goto("/");
    const input = page.getByLabel("Character/URL");
    await input.fill(
      `https://raider.io/characters/eu/silvermoon/${sibling.name}`
    );
    const started = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/dossiers"
    );
    await input.press("Enter");
    const answer = await started;
    expect(answer.ok()).toBeTruthy();
    expect(await answer.json()).toMatchObject({ kind: "job" });
    await expect(page).toHaveURL(/\/dossiers\/eu\/silvermoon\/ryun\?job=/);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM dossier_searches WHERE normalized_name = $1",
          [sibling.name]
        )
      ).rows
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM discovery_runs WHERE root_normalized_name = $1",
          [sibling.name]
        )
      ).rows
    ).toHaveLength(1);
  } finally {
    await pool.end();
  }
});

test("an opened WCL identity remains included when its shared alias is excluded", async ({
  page
}) => {
  const { root, sibling } = await seedGroup("wclselfalias");
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
  try {
    const repositories = createPostgresRepositories(pool);
    await repositories.manualConnections.add(root, sibling);
    await repositories.manualConnections.setExcluded(root, sibling, true);
    for (const key of [root, sibling])
      await pool.query(
        "INSERT INTO warcraft_logs_character_ids (region, realm_slug, normalized_name, character_id, resolved_at) VALUES ($1, $2, $3, 777777, now())",
        [key.region, key.realm, key.name]
      );
    await page.goto(`/dossiers/eu/silvermoon/${root.name}`);
    await expect(
      page.getByRole("heading", { name: /^Group root/, level: 1 })
    ).toBeVisible();
    const read = await page.request.get(
      `/api/dossiers/eu/silvermoon/${root.name}`
    );
    const body = applicantDossierSchema.parse(await read.json());
    expect(body.characters).toHaveLength(1);
    expect(body.characters[0]).toMatchObject({ key: root });
    expect(body.characters[0]?.excluded).not.toBe(true);
    expect(body.characters[0]?.warcraftLogsAliases).toContainEqual(sibling);
    await page.getByRole("button", { name: "Actions for Group root" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Include", exact: true })
    ).toHaveCount(0);
  } finally {
    await pool.end();
  }
});

test("automatic stale-group research creates work without entering recent searches", async ({
  page
}) => {
  const { sibling } = await seedGroup("profilecoldgroup", true);
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
  try {
    const started = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/dossiers"
    );
    await page.goto(`/dossiers/eu/silvermoon/${sibling.name}`);
    const answer = await started;
    expect(answer.ok()).toBeTruthy();
    expect(await answer.json()).toMatchObject({ kind: "job" });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM discovery_runs WHERE root_normalized_name = $1",
          [sibling.name]
        )
      ).rows
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM dossier_searches WHERE normalized_name = $1",
          [sibling.name]
        )
      ).rows
    ).toEqual([]);
    await expect(
      page
        .getByRole("region", { name: "Connected characters" })
        .getByText("Group root", { exact: true })
    ).toBeVisible();
  } finally {
    await pool.end();
  }
});

for (const failures of [0, 5]) {
  test(`a group sweep with a ${failures === 0 ? "live" : "abandoned"} continuation creates ${failures === 0 ? "no" : "one"} run`, async ({
    page
  }) => {
    const { root, sibling } = await seedGroup(
      `cursor${failures === 0 ? "live" : "abandoned"}`
    );
    const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
    try {
      await pool.query(
        "UPDATE fingerprint_sweep_states SET last_published_at = now() - interval '14 days', resume_after = 'cursor', continuation_failures = $4 WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3",
        [root.region, root.realm, root.name, failures]
      );
      const runCount = async () =>
        (
          await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM discovery_runs WHERE root_normalized_name = ANY($1::text[])",
            [[root.name, sibling.name]]
          )
        ).rows[0]!.count;
      const baseline = await runCount();
      await page.goto(`/dossiers/eu/silvermoon/${sibling.name}`);
      await expect(
        page
          .getByRole("region", { name: "Connected characters" })
          .getByText("Group root", { exact: true })
      ).toBeVisible();
      if (failures === 0) {
        // Repeat real page reads so all scheduler opportunities have occurred.
        for (let cycle = 0; cycle < 3; cycle += 1) {
          const read = await page.request.get(
            `/api/dossiers/eu/silvermoon/${sibling.name}`
          );
          expect(read.ok()).toBeTruthy();
          await page.reload();
          await expect(
            page.getByRole("heading", { name: "Group sibling", exact: true })
          ).toBeVisible();
        }
        expect(await runCount()).toBe(baseline);
      } else {
        await expect.poll(runCount).toBe(baseline + 1);
        const runs = await pool.query(
          "SELECT queue_job_id FROM discovery_runs WHERE root_normalized_name = ANY($1::text[]) AND queue_job_id IS NOT NULL",
          [[root.name, sibling.name]]
        );
        expect(runs.rows).toHaveLength(1);
      }
    } finally {
      await pool.end();
    }
  });
}

test("concurrent sibling page visits reserve one group sweep and one charge", async ({
  page
}) => {
  const root = {
    region: "eu",
    realm: "silvermoon",
    name: "profilecoldsweeproot"
  } as const;
  const sibling = { ...root, name: "profilecoldsweepalt" };
  await seedSnapshot({
    key: root,
    displayName: "Sweep root",
    refreshedAt: new Date(),
    characters: [
      { key: root, displayName: "Sweep root", className: "Mage", level: 80 },
      {
        key: sibling,
        displayName: "Sweep sibling",
        className: "Priest",
        level: 80
      }
    ]
  });
  for (const key of [root, sibling])
    await seedCharacterEvidence(key, { withSampleKills: false });
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
  const siblingPage = await page.context().newPage();
  const fixtureBaseUrl = process.env.E2E_RAIDER_IO_BASE_URL!;
  try {
    await pool.query(
      "INSERT INTO fingerprint_sweep_states (region, realm_slug, normalized_name, last_published_at) VALUES ($1, $2, $3, now() - interval '14 days') ON CONFLICT (region, realm_slug, normalized_name) DO UPDATE SET last_published_at = EXCLUDED.last_published_at, resume_after = NULL",
      [root.region, root.realm, root.name]
    );
    const runCount = async () =>
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM discovery_runs WHERE root_normalized_name = ANY($1::text[])",
          [[root.name, sibling.name]]
        )
      ).rows[0]!.count;
    const chargeCount = async () =>
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM rate_limit_events WHERE caller_bucket_hash = 'fingerprint-sweep-visit'"
        )
      ).rows[0]!.count;
    const baselineRuns = await runCount();
    const baselineCharges = await chargeCount();
    expect(
      (await fetch(`${fixtureBaseUrl}/__control/hold?profile=profilecoldsweep`))
        .ok
    ).toBeTruthy();
    await Promise.all([
      page.goto(`/dossiers/eu/silvermoon/${root.name}`),
      siblingPage.goto(`/dossiers/eu/silvermoon/${sibling.name}`)
    ]);
    for (const browserPage of [page, siblingPage])
      await expect(
        browserPage.getByRole("region", { name: "Connected characters" })
      ).toBeVisible();
    await expect.poll(runCount).toBe(baselineRuns + 1);
    await expect
      .poll(async () => {
        const stats = await fetch(`${fixtureBaseUrl}/__control/stats`).then(
          (response) => response.json() as Promise<FixtureStats>
        );
        return (
          (stats.characterRequests[
            `/api/characters/eu/silvermoon/${root.name}`
          ] ?? 0) +
          (stats.characterRequests[
            `/api/characters/eu/silvermoon/${sibling.name}`
          ] ?? 0)
        );
      })
      .toBeGreaterThan(0);
    // The provider stays held while both pages offer another scheduling chance.
    const reads = await Promise.all([
      page.request.get(`/api/dossiers/eu/silvermoon/${root.name}`),
      siblingPage.request.get(`/api/dossiers/eu/silvermoon/${sibling.name}`)
    ]);
    for (const read of reads) expect(read.ok()).toBeTruthy();
    expect(await runCount()).toBe(baselineRuns + 1);
    expect(await chargeCount()).toBe(baselineCharges + 1);
  } finally {
    await fetch(`${fixtureBaseUrl}/__control/release`);
    await siblingPage.close();
    await pool.end();
  }
});

test("a stale sibling page joins a running member after its initial read without another run or charge", async ({
  page
}) => {
  // Unique known provider names keep this race independent of other browser
  // searches. The first real read predates the member's run; the real POST
  // must then join that run rather than reserve one for the opened sibling.
  const { root, sibling } = await seedGroup("profilecoldjoinmember", true);
  const path = `/api/dossiers/eu/silvermoon/${sibling.name}`;
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
  try {
    const chargeCount = async () =>
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM rate_limit_events event JOIN discovery_runs run ON run.id = event.discovery_run_id WHERE run.root_normalized_name = ANY($1::text[])",
          [[root.name, sibling.name]]
        )
      ).rows[0]!.count;
    const baselineCharges = await chargeCount();
    let joinedRunId = "";
    let capturedFirstRead = false;
    let jobPolls = 0;
    await page.route(`**${path}`, async (route) => {
      if (capturedFirstRead) {
        await route.continue();
        return;
      }
      capturedFirstRead = true;
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      const beforeStart = applicantDossierSchema.parse(await response.json());
      expect(beforeStart.groupStale).toBe(true);
      const run = await createPostgresRepositories(pool).runs.createOrReuse(
        root,
        "anonymous"
      );
      joinedRunId = run.id;
      await pool.query(
        "UPDATE discovery_runs SET status = 'running', started_at = now() WHERE id = $1",
        [run.id]
      );
      await route.fulfill({ response, json: beforeStart });
    });
    await page.route("**/api/dossiers/jobs/*", async (route) => {
      jobPolls += 1;
      await route.continue();
    });
    const requests = starts(page);
    const started = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/dossiers"
    );
    await page.goto(`/dossiers/eu/silvermoon/${sibling.name}`);
    const answer = await started;
    expect(answer.status()).toBe(202);
    expect(await answer.json()).toMatchObject({
      kind: "job",
      jobId: joinedRunId,
      status: "running"
    });
    await expect
      .poll(() => jobPolls, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3);
    await expect(page).toHaveURL(`/dossiers/eu/silvermoon/${sibling.name}`);
    await expect(
      page.getByRole("heading", { name: "Group sibling", exact: true })
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Connected characters" })
        .getByText("Group root", { exact: true })
    ).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ startedFrom: "page" });
    const runs = await pool.query(
      "SELECT id FROM discovery_runs WHERE root_normalized_name = ANY($1::text[])",
      [[root.name, sibling.name]]
    );
    expect(runs.rows).toHaveLength(2); // the old publication and the joined run
    expect(runs.rows).toContainEqual({ id: joinedRunId });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM discovery_runs WHERE root_normalized_name = $1",
          [sibling.name]
        )
      ).rows
    ).toEqual([]);
    expect(await chargeCount()).toBe(baselineCharges);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM dossier_searches WHERE normalized_name = $1",
          [sibling.name]
        )
      ).rows
    ).toEqual([]);
  } finally {
    await pool.end();
  }
});
