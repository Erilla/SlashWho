import { blizzardAccessToken } from "./lib/blizzard.mts";
import { requiredEnvironment, runIfMain } from "./lib/cli.mts";
import { writeSnapshot } from "./lib/snapshot.mts";
import { fetchJournalRaids } from "./raid-catalogue.mts";

async function main() {
  const region = process.env.SLASHWHO_RAID_CATALOGUE_REGION?.trim() || "eu";
  const output = requiredEnvironment("SLASHWHO_RAID_CATALOGUE_OUTPUT");
  const raids = await fetchJournalRaids({
    fetch,
    accessToken: await blizzardAccessToken(
      region,
      "blizzard_journal_token_failed"
    ),
    baseUrl: new URL(`https://${region}.api.blizzard.com`),
    region
  });
  const outputPath = await writeSnapshot(output, {
    source: "blizzard-journal",
    generatedAt: new Date().toISOString(),
    region,
    locale: "en_GB",
    raids
  });
  console.log(JSON.stringify({ output: outputPath, raidCount: raids.length }));
}

runIfMain(import.meta.url, main, "raid_catalogue_failed");
