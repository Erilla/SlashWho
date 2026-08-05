import {
  createSearchRequestSchema,
  createSearchResponseSchema,
  jobStatusResponseSchema
} from "@slashwho/contracts";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLocaleLowerCase("en-US")}_required`);
  return value;
}

async function requireOk(url: URL): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`smoke_http_${response.status}`);
  return response;
}

async function main(): Promise<void> {
  const baseUrl = new URL(requiredEnvironment("SLASHWHO_BASE_URL"));
  if (baseUrl.protocol !== "https:") throw new Error("smoke_https_required");
  const characterUrl = requiredEnvironment("SLASHWHO_SMOKE_CHARACTER_URL");
  const request = createSearchRequestSchema.parse({ characterUrl });

  await requireOk(new URL("/health", baseUrl));
  await requireOk(new URL("/ready", baseUrl));

  const authorization = process.env.SLASHWHO_BOT_API_KEY?.trim();
  const response = await fetch(new URL("/api/v1/searches", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {})
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`smoke_search_http_${response.status}`);
  const result = createSearchResponseSchema.parse(await response.json());
  if (result.kind === "character") return;

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const statusResponse = await requireOk(new URL(result.statusUrl, baseUrl));
    const status = jobStatusResponseSchema.parse(await statusResponse.json());
    if (status.status === "complete") return;
    if (status.status === "failed") throw new Error("smoke_search_failed");
  }
  throw new Error("smoke_search_timeout");
}

void main()
  .then(() => process.stdout.write("SlashWho live smoke passed.\n"))
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "live_smoke_failed"}\n`
    );
    process.exitCode = 1;
  });
