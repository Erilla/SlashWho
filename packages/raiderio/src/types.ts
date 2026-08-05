import type { CharacterKey } from "@slashwho/domain";

export interface RaiderIoCharacter {
  readonly key: CharacterKey;
  readonly displayName: string;
  readonly className: string;
  readonly level: number;
  readonly ownerId: string | null;
  readonly profileGuess: string | null;
  readonly declaredMain: CharacterKey | null;
  /**
   * True when the upstream payload named at least one related character this
   * system cannot represent, so anything derived from it is knowingly incomplete.
   */
  readonly omittedMembers?: boolean;
}

export interface RaiderIoProfile {
  readonly characters: readonly RaiderIoCharacter[];
  /** See {@link RaiderIoCharacter.omittedMembers}. */
  readonly omittedMembers?: boolean;
}

export interface RaiderIoGateway {
  getCharacter(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<RaiderIoCharacter>;
  getClaimedCharacters(
    ownerId: string,
    signal?: AbortSignal
  ): Promise<RaiderIoProfile>;
  resolveProfileGuess(
    value: string,
    signal?: AbortSignal
  ): Promise<RaiderIoProfile | null>;
}
