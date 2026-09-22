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
