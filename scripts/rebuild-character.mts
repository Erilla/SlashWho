import {
  createDiscoveryQueue,
  createPostgresRepositories
} from "@slashwho/database";
import { refreshCharacter } from "@slashwho/application";
import { parseRaiderIoCharacterUrl } from "@slashwho/domain";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

/**
 * Forgets every terminal mark for one character, so its Warcraft Logs history
 * is collected again.
 *
 * This is the correction path for a collection fix that has to reach evidence
 * already stored indefinitely. It is a flag, not an action: it clears the
 * marks and returns, and the ordinary run, retry and points-budget machinery
 * drains the backlog across as many hourly windows as it takes. One character
 * on the reference dossier spans 353 reports, so a synchronous rebuild would
 * exhaust the allowance and abandon the character part-way.
 *
 * Operator-only, and deliberately not an HTTP route.
 * `/api/dossiers/.../refresh` is unauthenticated, which is tolerable at one
 * run per press and would not be if a press could re-collect a whole history.
 *
 * Scope is one character. A dossier-wide rebuild is every connected
 * character's history at once, which multiplies the cost tenfold on a dossier
 * like the reference one, and should follow separately.
 */
export type RebuildOperation = Readonly<{ characterUrl: string }>;

export function parseRebuildOperation(
  argv: readonly string[]
): RebuildOperation {
  // `corepack pnpm ops:rebuild -- <url>` forwards the literal separator as an
  // argument, so it must not be read as the character URL.
  const args = argv.filter((value) => value !== "--");
  const characterUrl = args[0];
  if (!characterUrl) throw new Error("character_url_required");
  return { characterUrl };
}

function canonicalIdentity(key: {
  region: string;
  realm: string;
  name: string;
}): string {
  return `${key.region}/${key.realm}/${key.name}`;
}

async function main(): Promise<void> {
  const operation = parseRebuildOperation(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("database_url_required");
  const key = parseRaiderIoCharacterUrl(operation.characterUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const queue = createDiscoveryQueue({ connectionString: databaseUrl });
  try {
    await queue.start();
    const repositories = createPostgresRepositories(pool);
    const result = await refreshCharacter({
      key,
      at: new Date(),
      // A rebuild ignores the cooldown by construction: the mode is chosen
      // here rather than derived from how recently the character was read.
      cooldownMs: 0,
      rebuild: true,
      repositories,
      queue
    });
    process.stdout.write(
      `${JSON.stringify({
        character: canonicalIdentity(key),
        mode: result.mode,
        clearedTiers: result.clearedTiers,
        lastCollectedAt: result.lastCollectedAt?.toISOString() ?? null
      })}\n`
    );
  } finally {
    await queue.stop({ graceful: true, timeoutMs: 15_000 }).catch(() => {});
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entrypoint === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "rebuild_failed"}\n`
    );
    process.exitCode = 1;
  });
}
