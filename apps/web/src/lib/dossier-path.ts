import type { CharacterKey } from "@slashwho/domain";

/**
 * The dossier page for a character. Each segment is encoded so a name outside
 * ASCII reaches the page as its canonical key rather than bouncing through the
 * route's redirect.
 */
export function dossierPath(key: CharacterKey): string {
  return `/dossiers/${encodeURIComponent(key.region)}/${encodeURIComponent(key.realm)}/${encodeURIComponent(key.name)}`;
}
