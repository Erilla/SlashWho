import {
  canonicalCharacterId,
  fingerprintDecision,
  raiderIoDecision,
  type CharacterKey,
  type DiscoveredCharacter,
  type FingerprintSweepOutcome,
  type ObservationSource
} from "@slashwho/domain";
import type {
  FamilyObservationWrite,
  ObservationWriteInput
} from "@slashwho/database";

/**
 * The sweep facts a write reads, picked from the domain outcome so a renamed
 * flag fails to compile rather than silently reading as absent.
 */
export type SweepForWrite =
  | Readonly<
      Pick<
        Extract<FingerprintSweepOutcome, { kind: "matched" }>,
        "kind" | "characters" | "unreadRoot" | "skippedHistoricalGuilds"
      >
    >
  | Readonly<
      Pick<
        Extract<FingerprintSweepOutcome, { kind: "capped" }>,
        "kind" | "characters" | "skippedHistoricalGuilds"
      >
    >;

/** A run's characters as observations, minus the root itself. */
function observed(
  rootKey: CharacterKey,
  characters: readonly DiscoveredCharacter[]
) {
  const root = canonicalCharacterId(rootKey);
  return characters
    .filter(
      (character) =>
        character.source !== "input" &&
        canonicalCharacterId(character.key) !== root
    )
    .map((character) => ({
      key: character.key,
      source: character.source as ObservationSource
    }));
}

function raiderIoFamily(
  rootKey: CharacterKey,
  characters: readonly DiscoveredCharacter[],
  limitationCode: string | null
): FamilyObservationWrite {
  return {
    family: "raiderio",
    ...raiderIoDecision(limitationCode),
    sweepReservationId: null,
    observed: observed(rootKey, characters)
  };
}

function fingerprintFamily(
  rootKey: CharacterKey,
  sweep: SweepForWrite,
  characters: readonly DiscoveredCharacter[],
  reservationId: string
): FamilyObservationWrite {
  return {
    family: "fingerprint",
    ...fingerprintDecision({
      kind: sweep.kind,
      unreadRoot: sweep.kind === "matched" && sweep.unreadRoot === true,
      skippedHistoricalGuilds: sweep.skippedHistoricalGuilds ?? 0
    }),
    sweepReservationId: reservationId,
    observed: observed(rootKey, characters)
  };
}

/** `snapshots.create`: a Raider.IO-only publication, `not_due` or no sweep configured. */
export function raiderIoPublicationWrite(input: {
  runId: string;
  rootKey: CharacterKey;
  characters: readonly DiscoveredCharacter[];
  limitationCode: string | null;
}): ObservationWriteInput {
  return {
    runId: input.runId,
    observerKey: input.rootKey,
    families: [
      raiderIoFamily(input.rootKey, input.characters, input.limitationCode)
    ]
  };
}

/** `createAndFinishFingerprintSweep`: cycle 1, both families. */
export function firstSweepCycleWrite(input: {
  runId: string;
  rootKey: CharacterKey;
  raiderIoCharacters: readonly DiscoveredCharacter[];
  raiderIoLimitation: string | null;
  sweep: SweepForWrite;
  excludedTournamentIds: ReadonlySet<string>;
  reservationId: string;
}): ObservationWriteInput {
  const matches = input.sweep.characters.filter(
    (character) =>
      !input.excludedTournamentIds.has(canonicalCharacterId(character.key))
  );
  return {
    runId: input.runId,
    observerKey: input.rootKey,
    families: [
      raiderIoFamily(
        input.rootKey,
        input.raiderIoCharacters,
        input.raiderIoLimitation
      ),
      fingerprintFamily(
        input.rootKey,
        input.sweep,
        matches,
        input.reservationId
      )
    ]
  };
}

/** `amendAndFinishFingerprintSweep`: a continuation cycle or seal, fingerprint only. */
export function continuationCycleWrite(input: {
  runId: string;
  rootKey: CharacterKey;
  sweep: SweepForWrite;
  reservationId: string;
}): ObservationWriteInput {
  return {
    runId: input.runId,
    observerKey: input.rootKey,
    families: [
      fingerprintFamily(
        input.rootKey,
        input.sweep,
        input.sweep.characters,
        input.reservationId
      )
    ]
  };
}

/** `completeWithLiveSweepSnapshot`: Raider.IO observations only, never retracting. */
export function liveSweepCompletionWrite(input: {
  runId: string;
  rootKey: CharacterKey;
  characters: readonly DiscoveredCharacter[];
}): ObservationWriteInput {
  return {
    runId: input.runId,
    observerKey: input.rootKey,
    families: [
      {
        family: "raiderio",
        decision: "added_only",
        reason: "live_sweep_completion",
        sweepReservationId: null,
        observed: observed(input.rootKey, input.characters)
      }
    ]
  };
}
