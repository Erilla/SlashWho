import type {
  CharacterMythicKillInput,
  DiscoveryWorkContext
} from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsGateway,
  WarcraftLogsLimitationCode,
  WarcraftLogsWipeEvidence
} from "@slashwho/warcraftlogs";

export type ApplicantEvidenceRun = Readonly<{
  id: string;
  key: CharacterKey;
  status: "queued" | "running" | "retrying" | "complete" | "partial" | "failed";
  createdAt: Date;
}>;

export type ApplicantEvidenceStore = {
  find(runId: string): Promise<ApplicantEvidenceRun | null>;
  claim(runId: string, attempt: number): Promise<ApplicantEvidenceRun | null>;
  publish(
    runId: string,
    result: Readonly<{
      state: "complete" | "partial";
      limitationCode: WarcraftLogsLimitationCode | null;
      kills: readonly CharacterMythicKillInput[];
      wipes: readonly WarcraftLogsWipeEvidence[];
      completedAt: Date;
    }>
  ): Promise<void>;
  fail(runId: string, code: WarcraftLogsLimitationCode): Promise<void>;
};

export type ApplicantEvidenceJobHandlerOptions = Readonly<{
  evidence: ApplicantEvidenceStore;
  warcraftLogs: Pick<WarcraftLogsGateway, "getFirstKillReports">;
  requestCap: number;
  parseRequestCap: number;
  now?: () => Date;
}>;

function toCharacterMythicKillInput(
  kill: WarcraftLogsFirstKillEvidence
): CharacterMythicKillInput {
  const {
    reportCode: _reportCode,
    fightId: _fightId,
    difficulty: _difficulty,
    ...normalizedKill
  } = kill;
  return normalizedKill;
}

/**
 * Collects one character's complete public Warcraft Logs history outside the
 * web request deadline. Only normalized gateway facts are handed to storage.
 */
export function createApplicantEvidenceJobHandler(
  options: ApplicantEvidenceJobHandlerOptions
) {
  const now = options.now ?? (() => new Date());

  return {
    async execute(
      runId: string,
      context?: DiscoveryWorkContext
    ): Promise<void> {
      const activeContext = context ?? {
        attempt: 1,
        maxAttempts: 1,
        signal: new AbortController().signal
      };
      const run = await options.evidence.claim(runId, activeContext.attempt);
      if (!run) return;

      activeContext.signal.throwIfAborted();
      const response = await options.warcraftLogs.getFirstKillReports(run.key, {
        requestCap: options.requestCap,
        parseRequestCap: options.parseRequestCap,
        signal: activeContext.signal
      });
      activeContext.signal.throwIfAborted();

      if (response.kind === "limitation") {
        await options.evidence.publish(run.id, {
          state: "partial",
          limitationCode: response.code,
          kills: [],
          wipes: [],
          completedAt: now()
        });
        return;
      }

      await options.evidence.publish(run.id, {
        state: response.limitation ? "partial" : "complete",
        limitationCode: response.limitation?.code ?? null,
        kills: response.kills.map(toCharacterMythicKillInput),
        wipes: response.wipes,
        completedAt: now()
      });
    }
  };
}

export type ApplicantEvidenceJobHandler = ReturnType<
  typeof createApplicantEvidenceJobHandler
>;
