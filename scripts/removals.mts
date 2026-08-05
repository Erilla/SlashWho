import { createPostgresRepositories } from "@slashwho/database";
import { parseRaiderIoCharacterUrl } from "@slashwho/domain";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const commands = ["add", "audit", "expire", "verify"] as const;

type Command = (typeof commands)[number];

export type RemovalOperation = Readonly<{
  command: Command;
  characterUrl: string;
  reason: string | null;
  expiresAt: Date | null;
}>;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function parseRemovalOperation(
  argv: readonly string[]
): RemovalOperation {
  // `corepack pnpm ops:removals -- add <url>` forwards the literal separator as
  // an argument, so the documented invocation must not be read as the command.
  const args = argv.filter((value) => value !== "--");
  const command = args[0] as Command | undefined;
  if (!command || !commands.includes(command)) {
    throw new Error("removal_command_required");
  }
  const characterUrl = args[1];
  if (!characterUrl) throw new Error("character_url_required");

  let reason: string | null = null;
  if (command === "add") {
    reason = option(args, "--reason")?.trim() ?? "";
    if (!reason || reason.length > 128) {
      throw new Error("removal_reason_invalid");
    }
  }

  const expiresValue = option(args, "--expires-at");
  const expiresAt = expiresValue ? new Date(expiresValue) : null;
  if (expiresAt && Number.isNaN(expiresAt.valueOf())) {
    throw new Error("removal_expiry_invalid");
  }

  return { command, characterUrl, reason, expiresAt };
}

function canonicalIdentity(key: {
  region: string;
  realm: string;
  name: string;
}): string {
  return `${key.region}/${key.realm}/${key.name}`;
}

async function main(): Promise<void> {
  const operation = parseRemovalOperation(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("database_url_required");
  const key = parseRaiderIoCharacterUrl(operation.characterUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const repositories = createPostgresRepositories(pool);
    if (operation.command === "add") {
      await repositories.suppressions.suppress(
        key,
        operation.reason ?? "",
        operation.expiresAt
      );
    } else if (operation.command === "expire") {
      await repositories.suppressions.suppress(
        key,
        "maintainer_expired",
        new Date(0)
      );
      await repositories.suppressions.cleanupExpired(new Date());
    }

    const active = await repositories.suppressions.isActive(key);
    process.stdout.write(
      `${JSON.stringify({ character: canonicalIdentity(key), active })}\n`
    );
    if (operation.command === "verify" && !active) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entrypoint === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "removal_operation_failed"}\n`
    );
    process.exitCode = 1;
  });
}
