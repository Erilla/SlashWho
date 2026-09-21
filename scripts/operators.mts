import {
  createPostgresRepositories,
  type OperatorAuthRepository
} from "@slashwho/database";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const commands = ["provision", "rotate", "disable", "list"] as const;
type Command = (typeof commands)[number];
type CredentialHash = Readonly<{
  passwordHash: string;
  passwordSalt: string;
  scryptVersion: number;
  scryptCost: number;
}>;
type HiddenCredentialInput = Readonly<{
  isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  off(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}>;

export type OperatorOperation =
  | Readonly<{ command: "provision"; login: string }>
  | Readonly<{ command: "rotate"; operatorId: string }>
  | Readonly<{ command: "disable"; operatorId: string }>
  | Readonly<{ command: "list" }>;

function canonicalLogin(login: string): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(login) ? login.toLowerCase() : null;
}

export function parseOperatorOperation(
  argv: readonly string[]
): OperatorOperation {
  const args = argv.filter((value) => value !== "--");
  if (args.includes("--credential"))
    throw new Error("operator_credential_cli_forbidden");
  const command = args[0] as Command | undefined;
  if (!command || !commands.includes(command))
    throw new Error("operator_command_required");
  if (args.length !== (command === "list" ? 1 : 2))
    throw new Error("operator_arguments_invalid");
  if (command === "list") return { command };
  const value = args[1];
  if (!value)
    throw new Error(
      command === "provision"
        ? "operator_login_required"
        : "operator_id_required"
    );
  return command === "provision"
    ? { command, login: value }
    : { command, operatorId: value };
}

export async function runOperatorOperation(
  operation: OperatorOperation,
  dependencies: Readonly<{
    repository: Pick<
      OperatorAuthRepository,
      "provision" | "rotateCredential" | "disable" | "list"
    >;
    readCredential(): Promise<string>;
    hashCredential(credential: string): Promise<CredentialHash>;
    now(): Date;
  }>
): Promise<unknown> {
  if (operation.command === "list") return dependencies.repository.list();
  const at = dependencies.now();
  if (operation.command === "disable") {
    const operator = await dependencies.repository.disable(
      operation.operatorId,
      at
    );
    if (!operator) throw new Error("operator_not_found");
    return { action: "disable", operatorId: operator.id };
  }
  const credential = await dependencies.readCredential();
  if (credential.length < 20 || credential.length > 1024)
    throw new Error("invalid_operator_credential");
  const hash = await dependencies.hashCredential(credential);
  if (operation.command === "provision") {
    const canonical = canonicalLogin(operation.login);
    if (!canonical) throw new Error("invalid_operator_login");
    const operator = await dependencies.repository.provision({
      canonicalLogin: canonical,
      displayLogin: operation.login,
      ...hash,
      at
    });
    return { action: "provision", operatorId: operator.id };
  }
  const operator = await dependencies.repository.rotateCredential({
    operatorId: operation.operatorId,
    ...hash,
    at
  });
  if (!operator) throw new Error("operator_not_found");
  return { action: "rotate", operatorId: operator.id };
}

export async function readHiddenCredential(
  options: Readonly<{
    input: HiddenCredentialInput;
    output: Readonly<{ write(text: string): unknown }>;
  }>
): Promise<string> {
  const { input, output } = options;
  if (!input.isTTY || !input.setRawMode)
    throw new Error("operator_tty_required");
  output.write("Credential: ");
  input.setRawMode(true);
  return new Promise((resolve, reject) => {
    let credential = "";
    const finish = (error?: Error) => {
      input.off("data", receive);
      input.setRawMode!(false);
      output.write("\n");
      if (error) reject(error);
      else resolve(credential);
    };
    const receive = (chunk: string | Buffer) => {
      for (const character of chunk.toString()) {
        if (character === "\u0003")
          return finish(new Error("operator_prompt_cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\b" || character === "\u007f") {
          credential = credential.slice(0, -1);
        } else credential += character;
      }
    };
    input.on("data", receive);
  });
}

async function hashCredential(credential: string): Promise<CredentialHash> {
  const { hashOperatorCredential } =
    await import("../apps/web/src/server/operator-auth");
  return hashOperatorCredential(credential);
}

async function main(): Promise<void> {
  const operation = parseOperatorOperation(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("database_url_required");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await runOperatorOperation(operation, {
      repository: createPostgresRepositories(pool).operatorAuth,
      readCredential: () =>
        readHiddenCredential({ input: process.stdin, output: process.stderr }),
      hashCredential,
      now: () => new Date()
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entrypoint === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "operator_operation_failed"}\n`
    );
    process.exitCode = 1;
  });
}
