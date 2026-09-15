import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applicantDossierSchema } from "@slashwho/contracts";

/**
 * Captures the live dossier for the demo character and stores the response
 * verbatim, so that re-running this script is how `/demo` picks up any new
 * shape or content the API has started returning.
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

  const response = await fetch(source, { cache: "no-store" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`demo_dossier_request_failed_${response.status}`);
  }

  const parsed = applicantDossierSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("demo_dossier_response_unexpected");
  }

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(body, null, 2)}\n`, "utf8");

  const { research, characters, raids, cuttingEdges } = parsed.data;
  process.stdout.write(
    `Captured ${region}/${realm}/${name} from ${baseUrl} ` +
      `(research ${research.state}, ${String(characters.length)} characters, ` +
      `${String(raids.length)} raids, ${String(cuttingEdges.length)} cutting edges) ` +
      `to ${output}\n`
  );
}

await main();
