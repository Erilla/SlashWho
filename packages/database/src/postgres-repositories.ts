import type { Pool } from "pg";
import type { Repositories } from "./repositories";
import { createAccountRepositories } from "./accounts";
import { createOperatorRepositories } from "./operators";
import { createDiscoveryRunRepositories } from "./discovery-runs";
import { createSnapshotRepositories } from "./snapshots";
import { createFingerprintSweepRepositories } from "./fingerprint-sweeps";
import { createEvidenceRepositories } from "./evidence/repository";
import { createSmallStoreRepositories } from "./small-stores";
import { createCharacterConnectionRepositories } from "./character-connections";
import { createFingerprintDeliveryRepository } from "./fingerprint-delivery";

export function createPostgresRepositories(pool: Pool): Repositories {
  return {
    fingerprintDeliveries: createFingerprintDeliveryRepository(pool),
    ...createAccountRepositories(pool),
    ...createOperatorRepositories(pool),
    ...createDiscoveryRunRepositories(pool),
    ...createSnapshotRepositories(pool),
    ...createFingerprintSweepRepositories(pool),
    ...createEvidenceRepositories(pool),
    ...createSmallStoreRepositories(pool),
    ...createCharacterConnectionRepositories(pool)
  };
}
