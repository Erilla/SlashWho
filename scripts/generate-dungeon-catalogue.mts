import { fetchJournalDungeons } from "./dungeon-catalogue.mts";
import { blizzardAccessToken } from "./lib/blizzard.mts";
import { requiredEnvironment, runIfMain } from "./lib/cli.mts";
import { writeSnapshot } from "./lib/snapshot.mts";

async function main() {
  const region = process.env.SLASHWHO_DUNGEON_CATALOGUE_REGION?.trim() || "eu";
  const output = requiredEnvironment("SLASHWHO_DUNGEON_CATALOGUE_OUTPUT");
  const dungeons = await fetchJournalDungeons({
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
    dungeons
  });
  console.log(
    JSON.stringify({ output: outputPath, dungeonCount: dungeons.length })
  );
}

runIfMain(import.meta.url, main, "dungeon_catalogue_failed");
