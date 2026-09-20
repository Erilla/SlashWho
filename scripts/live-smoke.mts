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

function requiredPositiveIntegerEnvironment(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name.toLocaleLowerCase("en-US")}_invalid`);
  }
  return value;
}

type WorkerProbe = {
  status: "ready";
  lastSuccessfulRunAgeMs: number | null;
  queueDepth: number;
};

export type LiveSmokeResult = {
  worker: {
    lastSuccessfulRunAgeMs: number;
    queueDepth: number;
  };
  dossierJobPath: "passed" | "skipped_inconclusive";
};

function parseWorkerProbe(value: unknown): WorkerProbe {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("smoke_worker_probe_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "lastSuccessfulRunAgeMs" ||
    keys[1] !== "queueDepth" ||
    keys[2] !== "status" ||
    record.status !== "ready" ||
    (record.lastSuccessfulRunAgeMs !== null &&
      (typeof record.lastSuccessfulRunAgeMs !== "number" ||
        !Number.isFinite(record.lastSuccessfulRunAgeMs) ||
        record.lastSuccessfulRunAgeMs < 0)) ||
    typeof record.queueDepth !== "number" ||
    !Number.isSafeInteger(record.queueDepth) ||
    record.queueDepth < 0
  ) {
    throw new Error("smoke_worker_probe_invalid");
  }
  return record as WorkerProbe;
}

export async function runLiveSmoke(options: {
  workerBaseUrl: URL;
  workerMaxSuccessfulRunAgeMs: number;
  baseUrl: URL;
  characterUrl: string;
  authorization: string | null;
  fetch: typeof globalThis.fetch;
  sleep(milliseconds: number): Promise<void>;
}): Promise<LiveSmokeResult> {
  if (
    options.baseUrl.protocol !== "https:" ||
    options.workerBaseUrl.protocol !== "https:"
  ) {
    throw new Error("smoke_https_required");
  }
  const request = createDossierRequestSchema.parse({
    characterUrl: options.characterUrl
  });

  async function requireHealthy(
    url: URL,
    errorPrefix = "smoke_http"
  ): Promise<Response> {
    const response = await options.fetch(url, {
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`${errorPrefix}_${response.status}`);
    return response;
  }

  const workerResponse = await requireHealthy(
    new URL("/probe", options.workerBaseUrl),
    "smoke_worker_http"
  );
  const workerProbe = parseWorkerProbe(await workerResponse.json());
  if (workerProbe.lastSuccessfulRunAgeMs === null) {
    throw new Error("smoke_worker_never_succeeded");
  }
  if (
    workerProbe.lastSuccessfulRunAgeMs > options.workerMaxSuccessfulRunAgeMs
  ) {
    throw new Error("smoke_worker_stale");
  }
  const worker = {
    lastSuccessfulRunAgeMs: workerProbe.lastSuccessfulRunAgeMs,
    queueDepth: workerProbe.queueDepth
  };

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
  if (result.kind === "ready") {
    return { worker, dossierJobPath: "skipped_inconclusive" };
  }

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await options.sleep(2_000);
    const statusResponse = await requireHealthy(
      new URL(`/api/dossiers/jobs/${result.jobId}`, options.baseUrl)
    );
    const status = dossierResearchStatusSchema.parse(
      await statusResponse.json()
    );
    if (status.status === "complete") {
      return { worker, dossierJobPath: "passed" };
    }
    if (status.status === "failed") throw new Error("smoke_dossier_failed");
  }
  throw new Error("smoke_dossier_timeout");
}

async function main(): Promise<void> {
  const result = await runLiveSmoke({
    baseUrl: new URL(requiredEnvironment("SLASHWHO_BASE_URL")),
    workerBaseUrl: new URL(requiredEnvironment("SLASHWHO_WORKER_URL")),
    workerMaxSuccessfulRunAgeMs: requiredPositiveIntegerEnvironment(
      "SLASHWHO_WORKER_MAX_SUCCESSFUL_RUN_AGE_MS"
    ),
    characterUrl: requiredEnvironment("SLASHWHO_SMOKE_CHARACTER_URL"),
    authorization: process.env.SLASHWHO_BOT_API_KEY?.trim() || null,
    fetch,
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))
  });
  process.stdout.write(
    `Worker probe passed (last success ${result.worker.lastSuccessfulRunAgeMs}ms ago; queue depth ${result.worker.queueDepth}).\n`
  );
  process.stdout.write(
    result.dossierJobPath === "passed"
      ? "Dossier job path passed.\n"
      : "Dossier job path skipped/inconclusive (fresh snapshot).\n"
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  void main()
    .then(() => process.stdout.write("SlashWho live smoke finished.\n"))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "live_smoke_failed"}\n`
      );
      process.exitCode = 1;
    });
}
