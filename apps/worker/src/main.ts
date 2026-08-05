import { loadWorkerConfig } from "./config";
import { startHealthServer } from "./health-server";
import { createWorkerLogger } from "./logger";
import { createWorkerRuntime } from "./runtime";

export async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = createWorkerLogger();
  const runtime = await createWorkerRuntime(config);
  const healthServer = await startHealthServer({
    port: config.port,
    health: () => runtime.health()
  });
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
