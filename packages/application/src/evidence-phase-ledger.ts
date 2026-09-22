/**
 * The only writer-facing model for collection progress. It deliberately holds
 * no provider result, cursor, report identifier, or character data: callers
 * can ask for a state change, but cannot manufacture a ledger row.
 */
export type EvidencePhaseId =
  | "warcraft_logs_history"
  | "warcraft_logs_tier_bests"
  | "warcraft_logs_fight_parses"
  | "warcraft_logs_ranking_identities"
  | "raiderio_rankings"
  | "blizzard_achievements"
  | "publication";

export type EvidencePhaseState =
  | "pending"
  | "active"
  | "completed"
  | "skipped"
  | "limited"
  | "failed"
  | "cancelled";

export type EvidencePhase = Readonly<{
  id: EvidencePhaseId;
  state: EvidencePhaseState;
  startedAt?: Date;
  completedAt?: Date;
  limitationCode?: string;
}>;

type EvidencePhasePlan = readonly EvidencePhaseId[];
type Persist = (phases: readonly EvidencePhase[]) => Promise<void>;

const terminalStates = new Set<EvidencePhaseState>([
  "completed",
  "skipped",
  "limited",
  "failed",
  "cancelled"
]);

function isLegalTransition(
  current: EvidencePhaseState,
  next: EvidencePhaseState
): boolean {
  if (current === next) return true;
  if (current === "pending") return next === "active" || next === "skipped";
  if (current === "active") return terminalStates.has(next);
  return false;
}

function phase(id: EvidencePhaseId): EvidencePhase {
  return { id, state: "pending" };
}

export const evidencePhasePlans = {
  warcraftLogs(input: {
    scan: boolean;
    tierBests: boolean;
    fightParses: boolean;
  }): EvidencePhasePlan {
    return [
      ...(input.scan ? (["warcraft_logs_history"] as const) : []),
      ...(input.tierBests ? (["warcraft_logs_tier_bests"] as const) : []),
      ...(input.fightParses
        ? ([
            "warcraft_logs_fight_parses",
            "warcraft_logs_ranking_identities"
          ] as const)
        : []),
      "publication"
    ];
  },
  providers(input: {
    raiderIo: boolean;
    blizzard: boolean;
  }): EvidencePhasePlan {
    return [
      ...(input.raiderIo ? (["raiderio_rankings"] as const) : []),
      ...(input.blizzard ? (["blizzard_achievements"] as const) : []),
      "publication"
    ];
  },
  collection(input: {
    scan: boolean;
    tierBests: boolean;
    fightParses: boolean;
    raiderIo: boolean;
    blizzard: boolean;
  }): EvidencePhasePlan {
    return [
      ...(input.scan ? (["warcraft_logs_history"] as const) : []),
      ...(input.tierBests ? (["warcraft_logs_tier_bests"] as const) : []),
      ...(input.fightParses
        ? ([
            "warcraft_logs_fight_parses",
            "warcraft_logs_ranking_identities"
          ] as const)
        : []),
      ...(input.raiderIo ? (["raiderio_rankings"] as const) : []),
      ...(input.blizzard ? (["blizzard_achievements"] as const) : []),
      "publication"
    ];
  }
} as const;

/** Every ordinary evidence reservation uses these real worker stages. */
export function fullEvidencePhasePlan(): EvidencePhasePlan {
  return evidencePhasePlans.collection({
    scan: true,
    tierBests: true,
    fightParses: true,
    raiderIo: true,
    blizzard: true
  });
}

export function createEvidencePhaseLedger(options: {
  plan: EvidencePhasePlan;
  now: () => Date;
  persist: Persist;
}) {
  const phases = new Map(options.plan.map((id) => [id, phase(id)]));
  let seeded = false;

  function ordered(ids: readonly EvidencePhaseId[]): EvidencePhase[] {
    return ids.map((id) => phases.get(id)!);
  }

  function previousPhasesAreTerminal(id: EvidencePhaseId): boolean {
    for (const phaseId of options.plan) {
      if (phaseId === id) return true;
      if (!terminalStates.has(phases.get(phaseId)!.state)) return false;
    }
    return false;
  }

  return {
    async seed(): Promise<void> {
      if (seeded) return;
      seeded = true;
      await options.persist(ordered(options.plan));
    },

    async transition(
      id: EvidencePhaseId,
      state: Exclude<EvidencePhaseState, "pending">,
      limitationCode?: string
    ): Promise<void> {
      const current = phases.get(id);
      if (!current) throw new Error("evidence_phase_unknown");
      if (
        state !== "skipped" &&
        state !== "active" &&
        !previousPhasesAreTerminal(id)
      ) {
        throw new Error("evidence_phase_transition_invalid");
      }
      if (!isLegalTransition(current.state, state)) {
        throw new Error("evidence_phase_transition_invalid");
      }
      if (
        current.state === state &&
        current.limitationCode === limitationCode
      ) {
        return;
      }
      const at = options.now();
      const next: EvidencePhase = {
        id,
        state,
        ...(current.startedAt || state === "active"
          ? { startedAt: current.startedAt ?? at }
          : {}),
        ...(terminalStates.has(state) ? { completedAt: at } : {}),
        ...(limitationCode ? { limitationCode } : {})
      };
      phases.set(id, next);
      await options.persist([next]);
    },

    /** An unexpected process loss has no durable fact beyond the active row. */
    async unknownStop(): Promise<void> {},

    async cancelActive(): Promise<void> {
      const active = options.plan.find(
        (id) => phases.get(id)!.state === "active"
      );
      if (active) await this.transition(active, "cancelled");
    },

    async failActive(limitationCode?: string): Promise<void> {
      const active = options.plan.find(
        (id) => phases.get(id)!.state === "active"
      );
      if (active) await this.transition(active, "failed", limitationCode);
    },

    async skipPending(): Promise<void> {
      for (const id of options.plan) {
        if (id !== "publication" && phases.get(id)!.state === "pending")
          await this.transition(id, "skipped");
      }
    },

    /** Settles only the planned work before a later provider boundary. */
    async skipPendingBefore(until: EvidencePhaseId): Promise<void> {
      for (const id of options.plan) {
        if (id === until) return;
        if (id !== "publication" && phases.get(id)!.state === "pending")
          await this.transition(id, "skipped");
      }
    }
  };
}
