import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { captureDemoDossier } from "./demo-dossier-capture.mts";

/**
 * Captures the live dossier for the demo character, redacting personal email
 * uploader values before storing it for `/demo`.
 */

const defaultBaseUrl = "https://web-test-7765.up.railway.app";
const defaultOutput = resolve(
  import.meta.dirname,
  "../apps/web/src/app/demo/ryii-dossier.json"
);
const demoCharacter = { region: "eu", realm: "silvermoon", name: "ryii" };
async function main() {
  const baseUrl =
    process.env.SLASHWHO_DEMO_DOSSIER_BASE_URL?.trim() || defaultBaseUrl;
  const output =
    process.env.SLASHWHO_DEMO_DOSSIER_OUTPUT?.trim() || defaultOutput;
  const { region, realm, name } = demoCharacter;
  const source = new URL(`/api/dossiers/${region}/${realm}/${name}`, baseUrl);

  const dossier = await captureDemoDossier(source, output, {
    fetch,
    mkdir,
    writeFile
  });

  const { research, characters, raids, cuttingEdges } = dossier;
  process.stdout.write(
    `Captured ${region}/${realm}/${name} from ${baseUrl} ` +
      `(research ${research.state}, ${String(characters.length)} characters, ` +
      `${String(raids.length)} raids, ${String(cuttingEdges.length)} cutting edges) ` +
      `to ${output}\n`
  );
}

await main();
