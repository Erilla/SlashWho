import { fetchCuttingEdgeAchievements } from "./cutting-edge-catalogue.mts";
import { blizzardAccessToken } from "./lib/blizzard.mts";
import { requiredEnvironment, runIfMain } from "./lib/cli.mts";
import { writeSnapshot } from "./lib/snapshot.mts";

async function main() {
  const region =
    process.env.SLASHWHO_CUTTING_EDGE_CATALOGUE_REGION?.trim() || "eu";
  const output = requiredEnvironment("SLASHWHO_CUTTING_EDGE_CATALOGUE_OUTPUT");
  const achievements = await fetchCuttingEdgeAchievements({
    fetch,
    accessToken: await blizzardAccessToken(
      region,
      "blizzard_cutting_edge_token_failed"
    ),
    baseUrl: new URL(`https://${region}.api.blizzard.com`),
    region
  });
  const outputPath = await writeSnapshot(output, {
    source: "blizzard-achievement-category",
    generatedAt: new Date().toISOString(),
    region,
    locale: "en_GB",
    achievements
  });
  console.log(
    JSON.stringify({
      output: outputPath,
      achievementCount: achievements.length
    })
  );
}

runIfMain(import.meta.url, main, "cutting_edge_catalogue_failed");
