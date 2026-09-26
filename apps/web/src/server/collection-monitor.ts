import { collectionProgress } from "@slashwho/application";
import {
  collectionMonitorResponseSchema,
  type CollectionMonitorResponse
} from "@slashwho/contracts";
import type { EvidenceRepository, Repositories } from "@slashwho/database";

/** How many discovery runs the monitor shows; the table is newest first. */
export const monitorDiscoveryRunLimit = 50;

const activeStatuses = new Set(["queued", "running", "retrying"]);

export type CollectionMonitorService = Readonly<{
  list(): Promise<CollectionMonitorResponse>;
}>;

export function createCollectionMonitorService(options: {
  evidence: Pick<EvidenceRepository, "listForMonitor">;
  runs: Pick<Repositories["runs"], "listRecent">;
  clock?: () => Date;
}): CollectionMonitorService {
  const clock = options.clock ?? (() => new Date());
  return {
    async list() {
      const generatedAt = clock();
      const [rows, discoveryRuns] = await Promise.all([
        options.evidence.listForMonitor(),
        options.runs.listRecent(monitorDiscoveryRunLimit)
      ]);
      const hasActiveRuns =
        rows.some((row) => activeStatuses.has(row.status)) ||
        discoveryRuns.some((run) => activeStatuses.has(run.status));
      const response: CollectionMonitorResponse = {
        generatedAt: generatedAt.toISOString(),
        hasActiveRuns,
        inFlight: [],
        completed: [],
        failed: [],
        // The run id, queue job and snapshot stay server-side.
        discoveryRuns: discoveryRuns.map((run) => ({
          character: run.rootKey,
          status: run.status,
          attempt: run.attempt,
          requestedAt: run.createdAt.toISOString(),
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
          errorCode: run.errorCode
        }))
      };

      for (const row of rows) {
        if (
          row.status === "queued" ||
          row.status === "running" ||
          row.status === "retrying"
        ) {
          const progress = collectionProgress(row.phases);
          response.inFlight.push({
            character: row.key,
            status: row.status,
            attempt: row.attempt,
            startedAt: row.startedAt?.toISOString() ?? null,
            elapsedSeconds:
              row.startedAt === null
                ? null
                : Math.max(
                    0,
                    Math.floor(
                      (generatedAt.getTime() - row.startedAt.getTime()) / 1_000
                    )
                  ),
            retryAfterAt: row.retryAfterAt?.toISOString() ?? null,
            ...(progress.length > 0 ? { collectionProgress: progress } : {})
          });
          continue;
        }

        if (row.status === "complete" || row.status === "partial") {
          response.completed.push({
            character: row.key,
            state: row.status,
            limitationCode: row.limitationCode,
            parseLimitationCode: row.parseLimitationCode,
            completedAt: row.completedAt?.toISOString() ?? null,
            evidenceVersion: row.evidenceVersion
          });
          continue;
        }

        response.failed.push({
          character: row.key,
          errorCode: row.errorCode,
          stoppedAt: row.completedAt?.toISOString() ?? null
        });
      }

      return collectionMonitorResponseSchema.parse(response);
    }
  };
}
