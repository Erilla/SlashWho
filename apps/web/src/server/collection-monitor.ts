import { collectionProgress } from "@slashwho/application";
import {
  collectionMonitorResponseSchema,
  type CollectionMonitorResponse
} from "@slashwho/contracts";
import type { EvidenceRepository } from "@slashwho/database";

export type CollectionMonitorService = Readonly<{
  list(): Promise<CollectionMonitorResponse>;
}>;

export function createCollectionMonitorService(options: {
  evidence: Pick<EvidenceRepository, "listForMonitor">;
  clock?: () => Date;
}): CollectionMonitorService {
  const clock = options.clock ?? (() => new Date());
  return {
    async list() {
      const generatedAt = clock();
      const rows = await options.evidence.listForMonitor();
      const hasActiveRuns = rows.some(
        (row) =>
          row.status === "queued" ||
          row.status === "running" ||
          row.status === "retrying"
      );
      const response: CollectionMonitorResponse = {
        generatedAt: generatedAt.toISOString(),
        hasActiveRuns,
        inFlight: [],
        completed: [],
        failed: []
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
