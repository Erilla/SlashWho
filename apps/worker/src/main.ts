import { DiscoveryQueueStopTimeoutError } from "@slashwho/database";

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
  terminate(exitCode: number): void;
};

const defaultDependencies: WorkerMainDependencies = {
  loadConfig: loadWorkerConfig,
  createLogger: createWorkerLogger,
  createRuntime: createWorkerRuntime,
  startHealthServer,
  terminate: (exitCode) => process.exit(exitCode)
};

export async function main(
  dependencies: WorkerMainDependencies = defaultDependencies
): Promise<void> {
  const config = dependencies.loadConfig();
  const logger = dependencies.createLogger();
  const runtime = await dependencies.createRuntime(config);
  const terminateAfterStopFailure = () => {
    logger.info({ event: "worker_stop_failed" });
    dependencies.terminate(1);
  };
  let healthServer: HealthServer;
  try {
    healthServer = await dependencies.startHealthServer({
      port: config.port,
      host: config.healthHost,
      health: () => runtime.health()
    });
  } catch (error) {
    try {
      await runtime.stop();
    } catch (stopError) {
      if (stopError instanceof DiscoveryQueueStopTimeoutError) {
        terminateAfterStopFailure();
      }
    }
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

  const requestStop = (signal: "SIGTERM" | "SIGINT") => {
    void stop(signal).catch(terminateAfterStopFailure);
  };
  process.once("SIGTERM", () => requestStop("SIGTERM"));
  process.once("SIGINT", () => requestStop("SIGINT"));
  logger.info({ event: "worker_ready", port: healthServer.port });
}

if (process.env.NODE_ENV !== "test") {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
