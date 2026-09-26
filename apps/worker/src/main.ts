import { DiscoveryQueueStopTimeoutError } from "@slashwho/database";

import { loadWorkerConfig, type WorkerConfig } from "./config";
import {
  startHealthServer,
  type HealthServer,
  type HealthServerOptions
} from "./health-server";
import { createWorkerLogger } from "./logger";
import { errorName, installProcessErrorHandlers } from "./process-errors";
import { createWorkerRuntime, type WorkerRuntime } from "./runtime";

type WorkerLogger = { info(value: Record<string, unknown>): void };

export type WorkerMainDependencies = {
  loadConfig(): WorkerConfig;
  createLogger(): WorkerLogger;
  createRuntime(
    config: WorkerConfig,
    logger: WorkerLogger
  ): Promise<WorkerRuntime>;
  startHealthServer(options: HealthServerOptions): Promise<HealthServer>;
  terminate(exitCode: number): void;
};

const defaultDependencies: WorkerMainDependencies = {
  loadConfig: loadWorkerConfig,
  createLogger: createWorkerLogger,
  createRuntime: (config, logger) =>
    createWorkerRuntime(config, undefined, logger),
  startHealthServer,
  terminate: (exitCode) => process.exit(exitCode)
};

export async function main(
  dependencies: WorkerMainDependencies = defaultDependencies,
  logger: WorkerLogger = dependencies.createLogger()
): Promise<void> {
  const config = dependencies.loadConfig();
  const runtime = await dependencies.createRuntime(config, logger);
  const terminateAfterStopFailure = () => {
    logger.info({ event: "worker_stop_failed" });
    dependencies.terminate(1);
  };
  let healthServer: HealthServer;
  try {
    healthServer = await dependencies.startHealthServer({
      port: config.port,
      host: config.healthHost,
      health: () => runtime.health(),
      probe: () => runtime.probe()
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

type WorkerProcess = Parameters<typeof installProcessErrorHandlers>[0] & {
  exitCode?: number | string | null | undefined;
};

/**
 * The process entry point. The logger is created before the config is read,
 * so a config, database, or health-bind failure still leaves a record naming
 * the error class instead of a silent non-zero exit.
 */
export async function startWorker(
  dependencies: WorkerMainDependencies = defaultDependencies,
  target: WorkerProcess = process
): Promise<void> {
  const logger = dependencies.createLogger();
  installProcessErrorHandlers(target, logger, dependencies.terminate);
  try {
    await main(dependencies, logger);
  } catch (error) {
    logger.info({ event: "worker_start_failed", errorName: errorName(error) });
    target.exitCode = 1;
  }
}

if (process.env.NODE_ENV !== "test") {
  void startWorker();
}
