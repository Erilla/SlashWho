import {
  createDossierRequestSchema,
  dossierResearchStatusSchema,
  dossierStartResponseSchema
} from "@slashwho/contracts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLocaleLowerCase("en-US")}_required`);
  return value;
}

export async function runLiveSmoke(options: {
  baseUrl: URL;
  characterUrl: string;
  authorization: string | null;
  fetch: typeof globalThis.fetch;
  sleep(milliseconds: number): Promise<void>;
}): Promise<void> {
  if (options.baseUrl.protocol !== "https:") {
    throw new Error("smoke_https_required");
  }
  const request = createDossierRequestSchema.parse({
    characterUrl: options.characterUrl
  });

  async function requireHealthy(url: URL): Promise<Response> {
    const response = await options.fetch(url, {
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`smoke_http_${response.status}`);
    return response;
  }

  await requireHealthy(new URL("/health", options.baseUrl));
  await requireHealthy(new URL("/ready", options.baseUrl));

  const response = await options.fetch(
    new URL("/api/dossiers", options.baseUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.authorization
          ? { authorization: `Bearer ${options.authorization}` }
          : {})
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15_000)
    }
  );
  if (!response.ok) throw new Error(`smoke_dossier_http_${response.status}`);
  const result = dossierStartResponseSchema.parse(await response.json());
  if (result.kind === "ready") return;

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await options.sleep(2_000);
    const statusResponse = await requireHealthy(
      new URL(`/api/dossiers/jobs/${result.jobId}`, options.baseUrl)
    );
    const status = dossierResearchStatusSchema.parse(
      await statusResponse.json()
    );
    if (status.status === "complete") return;
    if (status.status === "failed") throw new Error("smoke_dossier_failed");
  }
  throw new Error("smoke_dossier_timeout");
}

async function main(): Promise<void> {
  await runLiveSmoke({
    baseUrl: new URL(requiredEnvironment("SLASHWHO_BASE_URL")),
    characterUrl: requiredEnvironment("SLASHWHO_SMOKE_CHARACTER_URL"),
    authorization: process.env.SLASHWHO_BOT_API_KEY?.trim() || null,
    fetch,
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  void main()
    .then(() => process.stdout.write("SlashWho live smoke passed.\n"))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "live_smoke_failed"}\n`
      );
      process.exitCode = 1;
    });
}
