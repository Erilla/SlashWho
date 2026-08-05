import { loadWorkerConfig, type WorkerConfig } from "./config";
import {
  startHealthServer,
  type HealthServer,
  type HealthServerOptions
} from "./health-server";
import { createWorkerLogger } from "./logger";
import { createWorkerRuntime, type WorkerRuntime } from "./runtime";

type WorkerLogger = { info(value: object): void };

export type WorkerMainDependencies = {
  loadConfig(): WorkerConfig;
  createLogger(): WorkerLogger;
  createRuntime(config: WorkerConfig): Promise<WorkerRuntime>;
  startHealthServer(options: HealthServerOptions): Promise<HealthServer>;
};

const defaultDependencies: WorkerMainDependencies = {
  loadConfig: loadWorkerConfig,
  createLogger: createWorkerLogger,
  createRuntime: createWorkerRuntime,
  startHealthServer
};

export async function main(
  dependencies: WorkerMainDependencies = defaultDependencies
): Promise<void> {
  const config = dependencies.loadConfig();
  const logger = dependencies.createLogger();
  const runtime = await dependencies.createRuntime(config);
  let healthServer: HealthServer;
  try {
    healthServer = await dependencies.startHealthServer({
      port: config.port,
      health: () => runtime.health()
    });
  } catch (error) {
    await runtime.stop().catch(() => undefined);
    throw error;
  }
  let stopping: Promise<void> | undefined;
  const stop = (signal: "SIGTERM" | "SIGINT") => {
    stopping ??= (async () => {
      logger.info({ event: "worker_stopping", signal });
      await healthServer.stop();
      await runtime.stop();
      logger.info({ event: "worker_stopped" });
    })();
    return stopping;
  };

  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
  logger.info({ event: "worker_ready", port: healthServer.port });
}

if (process.env.NODE_ENV !== "test") {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
