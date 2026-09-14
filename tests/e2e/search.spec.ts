import { expect, test } from "playwright/test";

import { seedCharacterEvidence, seedSnapshot } from "./support/seed";

const applicantUrls = [
  "https://raider.io/characters/eu/silvermoon/Ryii",
  "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii"
] as const;

for (const applicantUrl of applicantUrls) {
  test(`researches an applicant dossier from ${new URL(applicantUrl).hostname}`, async ({
    page
  }) => {
    // Break caught: either supported URL form could still enter the retired
    // character/history journey instead of rendering dossier evidence.
    await seedSnapshot({
      key: { region: "eu", realm: "silvermoon", name: "ryii" },
      displayName: "Ryii",
      refreshedAt: new Date("2026-09-11T00:00:00.000Z")
    });
    await seedCharacterEvidence({
      region: "eu",
      realm: "silvermoon",
      name: "ryii"
    });
    await page.goto("/");
    await page.getByLabel("Applicant URL").fill(applicantUrl);
    await page.getByRole("button", { name: "Research applicant" }).click();

    await expect(page).toHaveURL(
      /\/dossiers\/eu\/silvermoon\/ryii(?:\?job=[\da-f-]+)?$/
    );
    await expect(
      page.getByRole("heading", { name: "Historic Cutting Edge" })
    ).toBeVisible();
    const raiderIoLink = page.getByRole("link", {
      name: "View Ryii on Raider.IO (opens in a new tab)"
    });
    await expect(raiderIoLink).toHaveAttribute(
      "href",
      /raider\.io\/characters\/eu\/silvermoon\/ryii$/
    );
    await expect(raiderIoLink).toHaveAttribute("target", "_blank");
    await expect(page.getByText("Queen Ansurek")).toBeVisible();
    const evidence = page.getByRole("group", {
      name: "Queen Ansurek evidence"
    });
    await expect(evidence.getByText("World #147")).toBeVisible();
    await evidence.getByText("View kill evidence").click();
    await expect
      .poll(() =>
        evidence
          .locator(".dossier-evidence time")
          .evaluateAll((times) =>
            times.map((time) => time.getAttribute("datetime"))
          )
      )
      .toEqual(["2025-01-13T21:31:40.000Z", "2025-01-13T22:31:40.000Z"]);
    await expect(
      evidence
        .getByRole("link", {
          name: "View Warcraft Logs report (opens in a new tab)"
        })
        .first()
    ).toBeVisible();
  });
}

test("shows submitted-character evidence while queued discovery is held", async ({
  page
}) => {
  await seedCharacterEvidence({
    region: "eu",
    realm: "silvermoon",
    name: "queued"
  });
  await fetch(`${process.env.E2E_RAIDER_IO_BASE_URL}/__control/hold`);
  await page.goto("/");
  await page
    .getByLabel("Applicant URL")
    .fill("https://raider.io/characters/eu/silvermoon/queued");
  await page.getByRole("button", { name: "Research applicant" }).click();

  await expect(page).toHaveURL(/\/dossiers\/eu\/silvermoon\/queued\?job=/);
  const initialDisclosure = page.getByText(
    "Linked-character research is still running; this evidence covers only the submitted character.",
    { exact: true }
  );
  await expect(initialDisclosure).toBeVisible();

  const evidence = page.getByRole("group", { name: "Queen Ansurek evidence" });
  await expect(evidence).toBeVisible();
  await fetch(`${process.env.E2E_RAIDER_IO_BASE_URL}/__control/release`);

  await expect(
    page.getByText("Linked-character research is complete.", { exact: true })
  ).toBeVisible();
  await expect(initialDisclosure).not.toBeVisible();
  await evidence.getByText("View kill evidence").click();
  await expect(
    evidence
      .getByRole("link", {
        name: "View Warcraft Logs report (opens in a new tab)"
      })
      .first()
  ).toHaveAttribute("href", /e2eReport#fight=9$/);
});

test("discloses that a partial snapshot may omit linked characters", async ({
  page
}) => {
  await seedSnapshot({
    key: { region: "eu", realm: "silvermoon", name: "partial" },
    displayName: "Partial",
    refreshedAt: new Date("2026-09-11T00:00:00.000Z"),
    state: "partial",
    limitationCode: "fingerprint_sweep_capped"
  });

  await page.goto("/dossiers/eu/silvermoon/partial");

  await expect(
    page.getByText(
      "Additional linked characters may exist; this dossier is not exhaustive.",
      { exact: true }
    )
  ).toBeVisible();
});
