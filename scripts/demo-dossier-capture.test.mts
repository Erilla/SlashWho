import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";

import { captureDemoDossier } from "./demo-dossier-capture.mts";

it("redacts padded email uploaders while preserving public uploader labels", async () => {
  // Break caught: a live report uploader can be an email address padded with
  // whitespace; capturing it would publish a personal identity in `/demo`.
  const fixturePath = resolve(
    import.meta.dirname,
    "../apps/web/src/app/demo/ryii-dossier.json"
  );
  const dossier = JSON.parse(await readFile(fixturePath, "utf8")) as {
    raids: Array<{
      bosses: Array<{
        bossName: string;
        firstKill: { reports?: Array<{ uploader: string | null }> };
      }>;
    }>;
  };
  const twinFangs = dossier.raids
    .flatMap((raid) => raid.bosses)
    .find((boss) => boss.bossName === "The Twin Fangs");
  if (!twinFangs?.firstKill.reports) {
    throw new Error("twin_fangs_reports_unavailable");
  }
  twinFangs.firstKill.reports[0]!.uploader = " olivercherif@yahoo.de ";

  let written = "";
  await captureDemoDossier(
    new URL("https://demo-source.invalid/api/dossiers/eu/silvermoon/ryii"),
    "demo.json",
    {
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(dossier), { status: 200 })
        ),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn(async (_path, data) => {
        written = String(data);
      }) as never
    }
  );

  const captured = JSON.parse(written) as typeof dossier;
  const reports = captured.raids
    .flatMap((raid) => raid.bosses)
    .find((boss) => boss.bossName === "The Twin Fangs")?.firstKill.reports;
  expect(reports?.map((report) => report.uploader)).toEqual([
    null,
    "Lflilkitty",
    "d4mnBoY"
  ]);
});

it("writes the capture minified, with wiped pulls folded as the live page folds them", async () => {
  // Break caught: the capture was written pretty-printed with every wiped pull
  // the source returned, a thousand or more per progression boss, so the demo
  // shipped megabytes of pulls to the browser that the page never shows.
  const pull = (attemptedAt: string) => ({
    attemptedAt,
    reportUrl: "https://www.warcraftlogs.com/reports/AbCdEf123456#fight=1",
    source: "personal_log",
    uploader: "laotl",
    guild: null,
    characters: [{ region: "eu", realm: "silvermoon", name: "ryii" }]
  });
  const fixture = JSON.parse(
    await readFile(
      resolve(
        import.meta.dirname,
        "../apps/web/src/app/demo/ryii-dossier.json"
      ),
      "utf8"
    )
  ) as object;
  const dossier = {
    ...fixture,
    raids: [
      {
        raidId: "1",
        raidName: "Demo Raid",
        imageUrl: null,
        cuttingEdge: null,
        bosses: [
          {
            bossId: "1",
            bossName: "Demo Boss",
            bossOrder: 1,
            imageUrl: null,
            state: "wipe",
            wipe: pull("2026-08-30T21:00:00.000Z"),
            wipes: [
              pull("2026-08-30T20:00:00.000Z"),
              pull("2026-08-30T21:00:00.000Z")
            ]
          }
        ]
      }
    ]
  };

  let written = "";
  await captureDemoDossier(
    new URL("https://demo-source.invalid/api/dossiers/eu/silvermoon/ryii"),
    "demo.json",
    {
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(dossier), { status: 200 })
        ),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn(async (_path, data) => {
        written = String(data);
      }) as never
    }
  );

  expect(written.trimEnd()).not.toContain("\n");
  const captured = JSON.parse(written) as typeof dossier;
  expect(
    captured.raids[0]!.bosses[0]!.wipes.map((wipe) => wipe.attemptedAt)
  ).toEqual(["2026-08-30T21:00:00.000Z"]);
});
