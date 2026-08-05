import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer
} from "@testcontainers/postgresql";
import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

import { startFakeRaiderIo } from "./fake-raiderio";

type ManagedProcess = Readonly<{
  child: ChildProcess;
  output(): string;
}>;

const webBaseUrl = "http://127.0.0.1:3100";
const workerBaseUrl = "http://127.0.0.1:3101";

function startPnpm(
  args: string[],
  environment: NodeJS.ProcessEnv
): ManagedProcess {
  const windows = process.platform === "win32";
  const child = windows
    ? spawn("cmd.exe", ["/d", "/s", "/c", "corepack", "pnpm", ...args], {
        cwd: process.cwd(),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      })
    : spawn("corepack", ["pnpm", ...args], {
        cwd: process.cwd(),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      });
  let output = "";
  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-16_384);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return { child, output: () => output };
}

async function waitForReady(
  url: string,
  processHandle: ManagedProcess
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (processHandle.child.exitCode !== null) {
      throw new Error(`process_exited_before_ready\n${processHandle.output()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Startup polling is intentionally quiet; the collected process output is
      // included if the readiness deadline expires.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`readiness_timeout:${url}\n${processHandle.output()}`);
}

async function stopProcess(processHandle: ManagedProcess): Promise<void> {
  const { child } = processHandle;
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore"
        }
      );
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  let postgres: StartedPostgreSqlContainer | undefined;
  let fixture: Awaited<ReturnType<typeof startFakeRaiderIo>> | undefined;
  const processes: ManagedProcess[] = [];

  try {
    postgres = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("slashwho_e2e")
      .withUsername("slashwho")
      .withPassword("slashwho")
      .start();
    fixture = await startFakeRaiderIo();
    const databaseUrl = postgres.getConnectionUri();
    process.env.E2E_DATABASE_URL = databaseUrl;
    process.env.E2E_RAIDER_IO_BASE_URL = fixture.baseUrl;

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "development",
      DATABASE_URL: databaseUrl,
      BOT_API_KEY: "e2e-bot-key-that-is-longer-than-32-characters",
      RATE_LIMIT_HASH_SECRET:
        "e2e-rate-secret-that-is-longer-than-32-characters",
      ANONYMOUS_SEARCHES_PER_HOUR: "1000",
      PUBLIC_READS_PER_MINUTE: "1000",
      FRESHNESS_HOURS: "24",
      NEGATIVE_CACHE_MINUTES: "1",
      DISCOVERY_REQUEST_CAP: "12",
      RAIDER_IO_BASE_URL: fixture.baseUrl,
      RAIDER_IO_TIMEOUT_MS: "30000",
      DATABASE_STARTUP_ATTEMPTS: "10",
      DATABASE_STARTUP_RETRY_MS: "250"
    };

    const worker = startPnpm(["--filter", "@slashwho/worker", "dev"], {
      ...environment,
      PORT: "3101"
    });
    const web = startPnpm(
      [
        "--filter",
        "@slashwho/web",
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        "3100"
      ],
      environment
    );
    processes.push(worker, web);

    await Promise.all([
      waitForReady(`${workerBaseUrl}/ready`, worker),
      waitForReady(`${webBaseUrl}/ready`, web)
    ]);

    return async () => {
      await Promise.allSettled(processes.map(stopProcess));
      await Promise.allSettled([fixture!.close(), postgres!.stop()]);
    };
  } catch (error) {
    await Promise.allSettled(processes.map(stopProcess));
    await Promise.allSettled([
      ...(fixture ? [fixture.close()] : []),
      ...(postgres ? [postgres.stop()] : [])
    ]);
    throw error;
  }
}
