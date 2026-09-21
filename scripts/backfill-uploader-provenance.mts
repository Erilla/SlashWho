import {
  createDiscoveryQueue,
  createPostgresRepositories,
  type DiscoveryQueue,
  type Repositories
} from "@slashwho/database";
import { refreshCharacter } from "@slashwho/application";
import { parseRaiderIoCharacterUrl } from "@slashwho/domain";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const minimumIntervalMs = 1_000;

export type UploaderProvenanceBackfillOperation = Readonly<{
  inputPath: string;
  intervalMs: number;
  limit: number;
}>;

function optionValue(
  args: readonly string[],
  option: string,
  errorCode: string
): string {
  const index = args.indexOf(option);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(errorCode);
  return value;
}

function positiveInteger(value: string, errorCode: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(errorCode);
  return parsed;
}

export function parseUploaderProvenanceBackfillOperation(
  argv: readonly string[]
): UploaderProvenanceBackfillOperation {
  const args = argv.filter((value) => value !== "--");
  const inputPath = optionValue(args, "--input", "backfill_input_required");
  const intervalMs = positiveInteger(
    optionValue(args, "--interval-ms", "backfill_interval_invalid"),
    "backfill_interval_invalid"
  );
  if (intervalMs < minimumIntervalMs) {
    throw new Error("backfill_interval_invalid");
  }
  const limit = positiveInteger(
    optionValue(args, "--limit", "backfill_limit_invalid"),
    "backfill_limit_invalid"
  );
  return { inputPath, intervalMs, limit };
}

export async function runUploaderProvenanceBackfill(
  characterUrls: readonly string[],
  operation: Pick<UploaderProvenanceBackfillOperation, "intervalMs" | "limit">,
  dependencies: Readonly<{
    rebuild(characterUrl: string): Promise<void>;
    sleep(milliseconds: number): Promise<void>;
  }>
): Promise<Readonly<{ scheduled: number }>> {
  if (characterUrls.length === 0) throw new Error("backfill_input_empty");
  if (characterUrls.length > operation.limit) {
    throw new Error("backfill_limit_exceeded");
  }

  for (const [index, characterUrl] of characterUrls.entries()) {
    if (index > 0) await dependencies.sleep(operation.intervalMs);
    await dependencies.rebuild(characterUrl);
  }
  return { scheduled: characterUrls.length };
}

export function createUploaderProvenanceBackfillDependencies(options: {
  repositories: Pick<Repositories, "evidence">;
  queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}): Readonly<{
  rebuild(characterUrl: string): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
}> {
  const now = options.now ?? (() => new Date());
  return {
    rebuild: async (characterUrl) => {
      await refreshCharacter({
        key: parseRaiderIoCharacterUrl(characterUrl),
        at: now(),
        cooldownMs: 0,
        rebuild: true,
        repositories: options.repositories,
        queue: options.queue
      });
    },
    sleep:
      options.sleep ??
      (async (milliseconds) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  };
}

function characterUrlsFrom(input: string): readonly string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function main(): Promise<void> {
  const operation = parseUploaderProvenanceBackfillOperation(
    process.argv.slice(2)
  );
  const characterUrls = characterUrlsFrom(
    await readFile(operation.inputPath, "utf8")
  );
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("database_url_required");

  const pool = new Pool({ connectionString: databaseUrl });
  const queue = createDiscoveryQueue({ connectionString: databaseUrl });
  try {
    await queue.start();
    const repositories = createPostgresRepositories(pool);
    const result = await runUploaderProvenanceBackfill(
      characterUrls,
      operation,
      createUploaderProvenanceBackfillDependencies({ repositories, queue })
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await queue.stop({ graceful: true, timeoutMs: 15_000 }).catch(() => {});
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entrypoint === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "backfill_failed"}\n`
    );
    process.exitCode = 1;
  });
}
