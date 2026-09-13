import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { fetchCuttingEdgeAchievements } from "./cutting-edge-catalogue.mts";
import { isDirectExecution } from "./raid-catalogue.mts";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLocaleLowerCase("en-US")}_required`);
  return value;
}

async function accessToken(region: string): Promise<string> {
  const response = await fetch(`https://${region}.battle.net/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${requiredEnvironment("BLIZZARD_CLIENT_ID")}:${requiredEnvironment("BLIZZARD_CLIENT_SECRET")}`
      ).toString("base64")}`
    },
    body: "grant_type=client_credentials"
  });
  const body = (await response.json()) as { access_token?: unknown };
  if (
    !response.ok ||
    typeof body.access_token !== "string" ||
    !body.access_token
  ) {
    throw new Error("blizzard_cutting_edge_token_failed");
  }
  return body.access_token;
}

async function main() {
  const region =
    process.env.SLASHWHO_CUTTING_EDGE_CATALOGUE_REGION?.trim() || "eu";
  const output = requiredEnvironment("SLASHWHO_CUTTING_EDGE_CATALOGUE_OUTPUT");
  const achievements = await fetchCuttingEdgeAchievements({
    fetch,
    accessToken: await accessToken(region),
    baseUrl: new URL(`https://${region}.api.blizzard.com`),
    region
  });
  const snapshot = {
    source: "blizzard-achievement-category",
    generatedAt: new Date().toISOString(),
    region,
    locale: "en_GB",
    achievements
  };
  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({
      output: outputPath,
      achievementCount: achievements.length
    })
  );
}

if (isDirectExecution(import.meta.url, process.argv[1] ?? "")) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "cutting_edge_catalogue_failed"
    );
    process.exitCode = 1;
  });
}
