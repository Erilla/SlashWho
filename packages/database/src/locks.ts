import type { CharacterKey } from "@slashwho/domain";
import type { Queryable } from "./sql";

export async function lockRoot(
  client: Queryable,
  key: CharacterKey
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `root:${key.region}:${key.realm}:${key.name}`
  ]);
}

export async function lockCharacterEvidence(
  client: Queryable,
  key: CharacterKey
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `character-evidence:${key.region}:${key.realm}:${key.name}`
  ]);
}

export async function lockFingerprintSweeps(client: Queryable): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    "fingerprint-sweeps"
  ]);
}
