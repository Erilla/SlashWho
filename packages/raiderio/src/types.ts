import type { CharacterKey } from "@slashwho/domain";

export interface RaiderIoCharacter {
  readonly key: CharacterKey;
  readonly displayName: string;
  readonly className: string;
  readonly level: number;
  readonly ownerId: string | null;
  readonly profileGuess: string | null;
  readonly declaredMain: CharacterKey | null;
}

export interface RaiderIoProfile {
  readonly characters: readonly RaiderIoCharacter[];
}

export interface RaiderIoGateway {
  getCharacter(key: CharacterKey): Promise<RaiderIoCharacter>;
  getClaimedCharacters(ownerId: string): Promise<readonly RaiderIoCharacter[]>;
  resolveProfileGuess(value: string): Promise<RaiderIoProfile | null>;
}
