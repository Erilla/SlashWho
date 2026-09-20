import {
  AuthenticationError,
  classifyCaller,
  type ApplicationConfig
} from "@slashwho/application";
import {
  collectionMonitorResponseSchema,
  type CollectionMonitorResponse
} from "@slashwho/contracts";
import type { EvidenceRepository } from "@slashwho/database";

export type CollectionMonitorService = Readonly<{
  list(): Promise<CollectionMonitorResponse>;
}>;

export function isOperatorRequest(
  headers: Pick<Headers, "get">,
  config: ApplicationConfig
): boolean {
  try {
    return classifyCaller(headers, config).callerClass === "bot";
  } catch (error) {
    if (error instanceof AuthenticationError) return false;
    throw error;
  }
}

export function createCollectionMonitorService(options: {
  evidence: Pick<EvidenceRepository, "listForMonitor">;
  clock?: () => Date;
}): CollectionMonitorService {
  const clock = options.clock ?? (() => new Date());
  return {
    async list() {
      const generatedAt = clock();
      const rows = await options.evidence.listForMonitor();
      const response: CollectionMonitorResponse = {
        generatedAt: generatedAt.toISOString(),
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
            retryAfterAt: row.retryAfterAt?.toISOString() ?? null
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
