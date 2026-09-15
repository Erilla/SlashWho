# User-supplied API keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a visitor supply their own Blizzard, Raider.IO, and WarcraftLogs API credentials from a browser-local settings page, so their searches use their own upstream rate-limit budget.

**Architecture:** Blizzard and Raider.IO calls happen synchronously inside a dossier GET request, so the browser attaches them as request headers and the route builds a per-request gateway. WarcraftLogs only runs from a queued worker job created during that same GET request, so its credentials are encrypted and stored on the `character_evidence_runs` row at creation, decrypted by the worker when it claims the run, and wiped on any terminal state.

**Tech Stack:** Next.js (apps/web), Node worker (apps/worker), Postgres via Drizzle (packages/database), Zod, Vitest, node:crypto (AES-256-GCM).

**Spec:** `docs/superpowers/specs/2026-09-15-user-supplied-api-keys-design.md`

## Global Constraints

- Credential headers (`X-Blizzard-Client-Id`, `X-Blizzard-Client-Secret`, `X-RaiderIO-Access-Key`, `X-WCL-Client-Id`, `X-WCL-Client-Secret`) must never be logged and never echoed back in a response body.
- No credential is ever persisted server-side except the WarcraftLogs pair, which is encrypted at rest on `character_evidence_runs` and cleared the moment the run reaches `complete`, `partial`, or `failed`.
- Absent headers must behave exactly as today (fall back to the server's own `BLIZZARD_CLIENT_ID`/`_SECRET`, `WARCRAFT_LOGS_CLIENT_ID`/`_SECRET`, and unauthenticated Raider.IO).
- `EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY` must be set identically in both the web and worker environments (same 32-byte key, hex-encoded, 64 hex characters).

---

### Task 1: Raider.IO client accepts an optional access key

**Files:**
- Modify: `packages/raiderio/src/client.ts`
- Test: `packages/raiderio/src/client.test.ts`

**Interfaces:**
- Produces: `CreateRaiderIoClientOptions.accessKey?: string` — when set, every request carries `?access_key=<value>` (in addition to any existing query params).

- [ ] **Step 1: Write the failing test**

Add to `packages/raiderio/src/client.test.ts` (mirror the existing fetch-assertion style already used in that file for other options):

```ts
it("attaches the configured access key to every request", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ characters: [], validationName: "Foo" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  );
  const client = createRaiderIoClient({
    fetch: fetchMock,
    baseUrl: "https://raider.io",
    timeoutMs: 5_000,
    accessKey: "test-access-key"
  });

  await client.getClaimedCharacters("Foo");

  const requestedUrl = new URL((fetchMock.mock.calls[0]![0] as URL).toString());
  expect(requestedUrl.searchParams.get("access_key")).toBe("test-access-key");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @slashwho/raiderio test -- client.test.ts`
Expected: FAIL — `accessKey` is not a recognized option / access_key param absent.

- [ ] **Step 3: Implement**

In `packages/raiderio/src/client.ts`:

```ts
export type CreateRaiderIoClientOptions = {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  timeoutMs: number;
  accessKey?: string;
};
```

Inside `createRaiderIoClient`, capture `options.accessKey` and apply it in the shared `request` helper before every fetch:

```ts
async function request<T>(
  url: URL,
  normalize: (value: unknown) => T,
  signal?: AbortSignal
): Promise<T> {
  if (options.accessKey) url.searchParams.set("access_key", options.accessKey);
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  // ...unchanged below
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @slashwho/raiderio test -- client.test.ts`
Expected: PASS, and the full existing suite in that file still passes (no accessKey means no param added).

- [ ] **Step 5: Commit**

```bash
git add packages/raiderio/src/client.ts packages/raiderio/src/client.test.ts
git commit -m "feat(raiderio): support an optional access key on every request"
```

---

### Task 2: Credential encryption utility

**Files:**
- Create: `packages/application/src/credential-encryption.ts`
- Test: `packages/application/src/credential-encryption.test.ts`

**Interfaces:**
- Produces: `encryptCredential(plaintext: string, key: Buffer): string` and `decryptCredential(ciphertext: string, key: Buffer): string`, plus `parseEncryptionKey(hex: string): Buffer` (validates a 64-hex-char / 32-byte key, throws `invalid_credential_encryption_key` otherwise).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  decryptCredential,
  encryptCredential,
  parseEncryptionKey
} from "./credential-encryption";

const key = parseEncryptionKey("a".repeat(64));

describe("credential-encryption", () => {
  it("round-trips a plaintext credential", () => {
    const ciphertext = encryptCredential("super-secret-client-id", key);
    expect(ciphertext).not.toContain("super-secret-client-id");
    expect(decryptCredential(ciphertext, key)).toBe("super-secret-client-id");
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => parseEncryptionKey("too-short")).toThrow(
      "invalid_credential_encryption_key"
    );
  });

  it("fails to decrypt with the wrong key", () => {
    const otherKey = parseEncryptionKey("b".repeat(64));
    const ciphertext = encryptCredential("value", key);
    expect(() => decryptCredential(ciphertext, otherKey)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @slashwho/application test -- credential-encryption.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

export function parseEncryptionKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("invalid_credential_encryption_key");
  }
  return Buffer.from(hex, "hex");
}

export function encryptCredential(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptCredential(ciphertext: string, key: Buffer): string {
  const raw = Buffer.from(ciphertext, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8"
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @slashwho/application test -- credential-encryption.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/application/src/credential-encryption.ts packages/application/src/credential-encryption.test.ts
git commit -m "feat(application): add AES-256-GCM credential encryption helper"
```

---

### Task 3: Encryption key in web and worker config

**Files:**
- Modify: `apps/web/src/server/config.ts`
- Modify: `apps/web/src/server/config.test.ts`
- Modify: `apps/worker/src/config.ts`
- Modify: `apps/worker/src/config.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `WebConfig.dossier.evidenceJobCredentialEncryptionKey: Buffer` and `WorkerConfig.evidenceJobCredentialEncryptionKey: Buffer` — both parsed via `parseEncryptionKey` from Task 2.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/server/config.test.ts`, add a case alongside the existing `blizzardClientId`-style assertions:

```ts
it("throws when EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY is missing", () => {
  const { EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY, ...rest } = validEnv;
  expect(() => loadWebConfig(rest)).toThrow(
    "evidence_job_credential_encryption_key_required"
  );
});
```

(Add `EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64)` to the file's shared `validEnv` fixture so the existing happy-path tests keep passing.)

Mirror the same case in `apps/worker/src/config.test.ts` against `loadWorkerConfig`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @slashwho/web test -- config.test.ts` and (from the repo root, since `apps/worker` has no `test` script of its own) `pnpm vitest run --project unit apps/worker/src/config.test.ts`.
Expected: FAIL — property does not exist / throw message not produced.

- [ ] **Step 3: Implement (web)**

In `apps/web/src/server/config.ts`, import `parseEncryptionKey` from `@slashwho/application` (re-export it from `packages/application/src/index.ts` if not already exported) and extend `WebConfig.dossier`:

```ts
dossier: Readonly<{
  raiderIoBaseUrl: string;
  raiderIoTimeoutMs: number;
  blizzardClientId: string;
  blizzardClientSecret: string;
  evidenceJobCredentialEncryptionKey: Buffer;
}>;
```

```ts
function requiredEncryptionKey(value: string | undefined): Buffer {
  const secret = value?.trim();
  if (!secret) {
    throw new Error("evidence_job_credential_encryption_key_required");
  }
  return parseEncryptionKey(secret);
}
```

Add `evidenceJobCredentialEncryptionKey: requiredEncryptionKey(environment.EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY)` inside the `dossier` object returned from `loadWebConfig`.

- [ ] **Step 4: Implement (worker)**

In `apps/worker/src/config.ts`, import `parseEncryptionKey` from `@slashwho/application`, add `evidenceJobCredentialEncryptionKey: Buffer` to `WorkerConfig`, and in `loadWorkerConfig` add:

```ts
const evidenceJobCredentialEncryptionKey = (() => {
  const secret = environment.EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!secret) {
    throw new Error("evidence_job_credential_encryption_key_required");
  }
  return parseEncryptionKey(secret);
})();
```

...and include `evidenceJobCredentialEncryptionKey` in the returned object.

- [ ] **Step 5: Document the env var**

In `.env.example`, add near the WarcraftLogs section:

```
# Shared between web and worker: encrypts a visitor-supplied WarcraftLogs key
# while its evidence job is queued. Must be identical in both environments.
# 64 hex characters (32 bytes). Generate with: openssl rand -hex 32
EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY=replace-with-64-hex-characters
```

- [ ] **Step 6: Run tests to verify they pass**

Run the same two test commands from Step 2.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/config.ts apps/web/src/server/config.test.ts apps/worker/src/config.ts apps/worker/src/config.test.ts .env.example packages/application/src/index.ts
git commit -m "feat(config): add shared evidence-job credential encryption key"
```

---

### Task 4: Schema and repository support for encrypted WCL credentials

**Files:**
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/drizzle/0014_evidence_run_credentials.sql` (via generation, see Step 3)
- Modify: `packages/database/src/repositories.ts`
- Modify: `packages/database/src/postgres-repositories.ts`
- Modify: `packages/database/src/postgres-repositories.test.ts` (or the file that already covers `reserve`/`claim`/`publish`/`fail` — locate it with `grep -rl "evidence.reserve" packages/database/src` first)

**Interfaces:**
- Produces: `CharacterEvidenceRun.wclClientIdEncrypted: string | null`, `CharacterEvidenceRun.wclClientSecretEncrypted: string | null`.
- Produces: `EvidenceRepository.reserve(input)` gains an optional `credentials?: { wclClientIdEncrypted: string; wclClientSecretEncrypted: string } | null`, applied only when the call creates a new row.
- Consumes: nothing new from other tasks; this is pure schema/data-access.

- [ ] **Step 1: Write the failing test**

Add to the evidence repository test file (found via the grep above):

```ts
it("stores encrypted WCL credentials only when the reservation creates a new run", async () => {
  const key = { region: "eu", realm: "silvermoon", name: "Testcharacter" };
  const reservation = await repositories.evidence.reserve({
    key,
    freshnessCutoff: new Date(0),
    at: new Date(),
    credentials: {
      wclClientIdEncrypted: "encrypted-id",
      wclClientSecretEncrypted: "encrypted-secret"
    }
  });
  expect(reservation.kind).toBe("reserved");
  expect(reservation.run.wclClientIdEncrypted).toBe("encrypted-id");
  expect(reservation.run.wclClientSecretEncrypted).toBe("encrypted-secret");
});

it("clears encrypted WCL credentials when a run is published", async () => {
  const key = { region: "eu", realm: "silvermoon", name: "Testcharacter2" };
  const reservation = await repositories.evidence.reserve({
    key,
    freshnessCutoff: new Date(0),
    at: new Date(),
    credentials: {
      wclClientIdEncrypted: "encrypted-id",
      wclClientSecretEncrypted: "encrypted-secret"
    }
  });
  await repositories.evidence.claim(reservation.run.id, 1);
  await repositories.evidence.publish(reservation.run.id, {
    state: "complete",
    limitationCode: null,
    parseLimitationCode: null,
    kills: [],
    wipes: [],
    completedAt: new Date()
  });
  const found = await repositories.evidence.find(reservation.run.id);
  expect(found?.wclClientIdEncrypted).toBeNull();
  expect(found?.wclClientSecretEncrypted).toBeNull();
});

it("clears encrypted WCL credentials when a run fails", async () => {
  const key = { region: "eu", realm: "silvermoon", name: "Testcharacter3" };
  const reservation = await repositories.evidence.reserve({
    key,
    freshnessCutoff: new Date(0),
    at: new Date(),
    credentials: {
      wclClientIdEncrypted: "encrypted-id",
      wclClientSecretEncrypted: "encrypted-secret"
    }
  });
  await repositories.evidence.claim(reservation.run.id, 1);
  await repositories.evidence.fail(reservation.run.id, "some_error");
  const found = await repositories.evidence.find(reservation.run.id);
  expect(found?.wclClientIdEncrypted).toBeNull();
  expect(found?.wclClientSecretEncrypted).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

`packages/database` has no `test` script of its own; run it from the repo root against the `unit` project, scoped to the file found above:

Run: `pnpm vitest run --project unit <matching test file path>`
Expected: FAIL — `credentials` not accepted, `wclClientIdEncrypted` undefined.

- [ ] **Step 3: Update schema and generate migration**

In `packages/database/src/schema.ts`, inside the `characterEvidenceRuns` column list (after `parseLimitationCode`), add:

```ts
wclClientIdEncrypted: text("wcl_client_id_encrypted"),
wclClientSecretEncrypted: text("wcl_client_secret_encrypted"),
```

Generate the migration:

```bash
cd packages/database && npx drizzle-kit generate
```

This produces `packages/database/drizzle/0014_<generated-name>.sql` (drizzle-kit names it; rename is not required). Confirm it contains exactly:

```sql
ALTER TABLE "character_evidence_runs" ADD COLUMN "wcl_client_id_encrypted" text;
ALTER TABLE "character_evidence_runs" ADD COLUMN "wcl_client_secret_encrypted" text;
```

- [ ] **Step 4: Update the repository interface**

In `packages/database/src/repositories.ts`:

```ts
export interface CharacterEvidenceRun {
  id: string;
  key: CharacterKey;
  queueJobId: string | null;
  status: EvidenceRunStatus;
  attempt: number;
  limitationCode: string | null;
  parseLimitationCode: string | null;
  retryAfterAt: Date | null;
  errorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  wclClientIdEncrypted: string | null;
  wclClientSecretEncrypted: string | null;
}
```

```ts
export interface EvidenceRepository {
  reserve(input: {
    key: CharacterKey;
    freshnessCutoff: Date;
    at: Date;
    credentials?: {
      wclClientIdEncrypted: string;
      wclClientSecretEncrypted: string;
    } | null;
  }): Promise<EvidenceReservationResult>;
  // ...rest unchanged
```

- [ ] **Step 5: Update the Postgres implementation**

In `packages/database/src/postgres-repositories.ts`:

1. Add both columns to every `SELECT`/`RETURNING` column list that already selects `character_evidence_runs` columns for `EvidenceRunRow` (the `active` query, the `INSERT ... RETURNING`, `find`, and `claim` — four call sites; grep `FROM character_evidence_runs` and `RETURNING id, region` to find them all).
2. Update `mapEvidenceRun` to read them:

```ts
function mapEvidenceRun(row: EvidenceRunRow): CharacterEvidenceRun {
  return {
    // ...existing fields
    wclClientIdEncrypted: row.wcl_client_id_encrypted,
    wclClientSecretEncrypted: row.wcl_client_secret_encrypted
  };
}
```

3. Update the `EvidenceRunRow` type (wherever it's declared near the top of the file) to include `wcl_client_id_encrypted: string | null; wcl_client_secret_encrypted: string | null;`.
4. Update the `INSERT` in `reserve` to write the credentials when supplied:

```ts
const inserted = await client.query<EvidenceRunRow>(
  `INSERT INTO character_evidence_runs
    (region, realm_slug, normalized_name, wcl_client_id_encrypted, wcl_client_secret_encrypted)
   VALUES ($1, $2, $3, $4, $5)
   RETURNING id, region, realm_slug, normalized_name, queue_job_id, status,
             attempt, limitation_code, parse_limitation_code, retry_after_at, error_code, created_at, started_at,
             completed_at, wcl_client_id_encrypted, wcl_client_secret_encrypted`,
  [
    key.region,
    key.realm,
    key.name,
    input.credentials?.wclClientIdEncrypted ?? null,
    input.credentials?.wclClientSecretEncrypted ?? null
  ]
);
```

5. Add credential-clearing to the `publish` UPDATE and the `fail` UPDATE:

```ts
// publish:
`UPDATE character_evidence_runs
 SET status = $2, limitation_code = $3, parse_limitation_code = $4,
     retry_after_at = $5, error_code = NULL, completed_at = $6, evidence_version = $7,
     wcl_client_id_encrypted = NULL, wcl_client_secret_encrypted = NULL
 WHERE id = $1 AND status IN ('queued', 'running', 'retrying')`,
```

```ts
// fail:
`UPDATE character_evidence_runs
 SET status = 'failed', error_code = $2, completed_at = now(),
     wcl_client_id_encrypted = NULL, wcl_client_secret_encrypted = NULL
 WHERE id = $1 AND status IN ('queued', 'running', 'retrying')`,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run --project unit <matching test file path>`
Expected: PASS. Also run `pnpm vitest run --project unit packages/database/src` in full to confirm no other test asserting on the full column list broke.

- [ ] **Step 7: Commit**

```bash
git add packages/database/src/schema.ts packages/database/drizzle packages/database/src/repositories.ts packages/database/src/postgres-repositories.ts packages/database/src/postgres-repositories.test.ts
git commit -m "feat(database): store encrypted WCL credentials on character_evidence_runs"
```

---

### Task 5: Thread WCL credentials from evidence gathering into `reserve`

**Files:**
- Modify: `packages/application/src/applicant-dossier-service.ts`
- Modify: `packages/application/src/applicant-dossier-service.test.ts`

**Interfaces:**
- Consumes: `EvidenceRepository.reserve`'s new `credentials` field (Task 4); `encryptCredential`/`parseEncryptionKey` (Task 2).
- Produces: `gatherCharacterEvidence` and `assembleDossier` accept an optional `wclCredentials?: { clientId: string; clientSecret: string } | null`, threaded down from `read`/`readInitial`.

- [ ] **Step 1: Write the failing test**

In `applicant-dossier-service.test.ts`, find the existing test(s) asserting on `enqueueCharacterEvidence`/`reserve` calls during a `read` with a stale/absent evidence run, and add:

```ts
it("encrypts and stores supplied WCL credentials when reserving a new evidence run", async () => {
  const reserve = vi.fn().mockResolvedValue({
    kind: "reserved",
    run: { id: "run-1", /* ...other required CharacterEvidenceRun fields matching this file's existing fixtures */ },
    completed: null
  });
  // wire `reserve` into this test's repositories.evidence mock, matching
  // this file's existing container-building pattern
  const service = createApplicantDossierService({
    /* ...existing fixture options */,
    config: { ...baseConfig, EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: encryptionKey }
  });

  await service.read(rootKey, undefined, {
    wclCredentials: { clientId: "user-client-id", clientSecret: "user-secret" }
  });

  const credentials = reserve.mock.calls[0]![0].credentials;
  expect(credentials.wclClientIdEncrypted).not.toBe("user-client-id");
  expect(decryptCredential(credentials.wclClientIdEncrypted, encryptionKey)).toBe(
    "user-client-id"
  );
});
```

Match this test's mock shape and imports exactly to whatever fixtures already exist earlier in the file — read the file first and adapt variable names accordingly; the assertions (call args, encryption round-trip) are what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @slashwho/application test -- applicant-dossier-service.test.ts`
Expected: FAIL — `read` does not accept a third `options` argument / `credentials` never passed to `reserve`.

- [ ] **Step 3: Implement**

In `packages/application/src/applicant-dossier-service.ts`:

1. Extend the public interface:

```ts
export interface ApplicantDossierService {
  start(input: CreateDossierCommand): Promise<CreateDossierResult>;
  addConnectedCharacter(
    root: CharacterKey,
    input: CreateDossierCommand
  ): Promise<CreateSearchResult | { kind: "linked" | "duplicate" }>;
  readInitial(
    key: CharacterKey,
    signal?: AbortSignal,
    overrides?: DossierGatewayOverrides
  ): Promise<ReadDossierResult>;
  read(
    key: CharacterKey,
    signal?: AbortSignal,
    overrides?: DossierGatewayOverrides
  ): Promise<ReadDossierResult>;
}

export type DossierGatewayOverrides = Readonly<{
  blizzard?: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderio?: Pick<RaiderIoGateway, "getMythicBossRankings" | "getCharacter">;
  wclCredentials?: Readonly<{ clientId: string; clientSecret: string }> | null;
}>;
```

2. Import `encryptCredential` from `./credential-encryption`.

3. Give `gatherCharacterEvidence` a `wclCredentials` + `encryptionKey` option and have it build the `credentials` argument for `reserve`:

```ts
async function gatherCharacterEvidence(
  character: DossierSubject,
  options: {
    repositories: Pick<Repositories, "evidence">;
    queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
    freshnessCutoff: Date;
    signal?: AbortSignal;
    wclCredentials?: Readonly<{ clientId: string; clientSecret: string }> | null;
    encryptionKey: Buffer;
  }
): Promise<EvidenceResult & { gathering: boolean }> {
  const reservation = await options.repositories.evidence.reserve({
    key: character.key,
    freshnessCutoff: options.freshnessCutoff,
    at: new Date(),
    credentials: options.wclCredentials
      ? {
          wclClientIdEncrypted: encryptCredential(
            options.wclCredentials.clientId,
            options.encryptionKey
          ),
          wclClientSecretEncrypted: encryptCredential(
            options.wclCredentials.clientSecret,
            options.encryptionKey
          )
        }
      : null
  });
  // ...unchanged below
```

4. Thread `wclCredentials` and `encryptionKey` through `assembleDossier`'s options and its call to `gatherCharacterEvidence` (mirror the existing `freshnessCutoff`/`signal` threading at the call site around line 529).

5. In `assembleDossier`'s options, add `blizzard`/`raiderio` overrides too — when present, use them directly in place of the closed-over cached `options.blizzard`/`options.raiderio` for that call only (do not push override results into the shared `achievements`/`rankings` caches from Task-adjacent code in `createApplicantDossierService`):

```ts
async function assembleDossier(options: {
  // ...existing fields
  blizzardOverride?: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderioOverride?: Pick<RaiderIoGateway, "getMythicBossRankings" | "getCharacter">;
}): Promise<ContractApplicantDossier> {
  const blizzard = options.blizzardOverride ?? options.blizzard;
  const raiderio = options.raiderioOverride ?? options.raiderio;
  // use `blizzard`/`raiderio` in place of `options.blizzard`/`options.raiderio`
  // for the calls to gatherCuttingEdgeEvidence and enrichHistoricRanks below
```

6. In `createApplicantDossierService`'s returned `read`/`readInitial` implementations, accept the new `overrides` parameter and pass `overrides?.blizzard` as `blizzardOverride`, `overrides?.raiderio` as `raiderioOverride`, `overrides?.wclCredentials` as `wclCredentials`, and `options.config.EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY` as `encryptionKey` into `assembleDossier`.

7. Add `EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: z.string().min(32)` — actually a `Buffer`, so instead accept it as a constructor option rather than through the Zod-validated `ApplicationConfig` (that schema only validates env strings): extend `createApplicantDossierService`'s `options` type with `evidenceJobCredentialEncryptionKey: Buffer` and use that directly. Update the one production call site in `apps/web/src/server/container.ts` to pass `config.dossier.evidenceJobCredentialEncryptionKey`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @slashwho/application test -- applicant-dossier-service.test.ts`
Expected: PASS. Then run the full package test suite to confirm the signature change didn't break other callers: `pnpm --filter @slashwho/application test`.

- [ ] **Step 5: Commit**

```bash
git add packages/application/src/applicant-dossier-service.ts packages/application/src/applicant-dossier-service.test.ts apps/web/src/server/container.ts
git commit -m "feat(application): accept per-call Blizzard/Raider.IO/WCL credential overrides"
```

---

### Task 6: Web routes read credential headers and build per-request gateways

**Files:**
- Modify: `apps/web/src/app/api/dossiers/[region]/[realm]/[name]/route.ts`
- Modify: `apps/web/src/app/api/dossiers/api-contract.test.ts` (or wherever this route's tests live — confirm with `grep -rl "dossiers/\[region\]" apps/web/src/app`)
- Create: `apps/web/src/server/credential-headers.ts`
- Create: `apps/web/src/server/credential-headers.test.ts`

**Interfaces:**
- Consumes: `createBlizzardClient` (`@slashwho/blizzard`), `createRaiderIoClient` (`@slashwho/raiderio`), `DossierGatewayOverrides` (Task 5).
- Produces: `readCredentialOverrides(headers: Headers, config: WebConfig): DossierGatewayOverrides` — pure header parsing plus gateway construction, so the route stays thin.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { readCredentialOverrides } from "./credential-headers";
import { loadWebConfig } from "./config";

const config = loadWebConfig({ /* the same minimal valid env used by config.test.ts */ });

describe("readCredentialOverrides", () => {
  it("returns no overrides when no credential headers are present", () => {
    const overrides = readCredentialOverrides(new Headers(), config);
    expect(overrides.blizzard).toBeUndefined();
    expect(overrides.raiderio).toBeUndefined();
    expect(overrides.wclCredentials).toBeUndefined();
  });

  it("builds a Blizzard gateway when both header values are present", () => {
    const headers = new Headers({
      "x-blizzard-client-id": "user-id",
      "x-blizzard-client-secret": "user-secret"
    });
    const overrides = readCredentialOverrides(headers, config);
    expect(overrides.blizzard).toBeDefined();
  });

  it("ignores a Blizzard header pair with only one value present", () => {
    const headers = new Headers({ "x-blizzard-client-id": "user-id" });
    const overrides = readCredentialOverrides(headers, config);
    expect(overrides.blizzard).toBeUndefined();
  });

  it("passes the Raider.IO access key through unchanged", () => {
    const headers = new Headers({ "x-raiderio-access-key": "user-key" });
    const overrides = readCredentialOverrides(headers, config);
    expect(overrides.raiderio).toBeDefined();
  });

  it("returns WCL credentials as plain data, not a gateway", () => {
    const headers = new Headers({
      "x-wcl-client-id": "user-id",
      "x-wcl-client-secret": "user-secret"
    });
    const overrides = readCredentialOverrides(headers, config);
    expect(overrides.wclCredentials).toEqual({
      clientId: "user-id",
      clientSecret: "user-secret"
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @slashwho/web test -- credential-headers.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
import { createBlizzardClient } from "@slashwho/blizzard";
import { createRaiderIoClient } from "@slashwho/raiderio";
import type { DossierGatewayOverrides } from "@slashwho/application";

import type { WebConfig } from "./config";

export function readCredentialOverrides(
  headers: Headers,
  config: WebConfig
): DossierGatewayOverrides {
  const overrides: {
    blizzard?: DossierGatewayOverrides["blizzard"];
    raiderio?: DossierGatewayOverrides["raiderio"];
    wclCredentials?: DossierGatewayOverrides["wclCredentials"];
  } = {};

  const blizzardClientId = headers.get("x-blizzard-client-id")?.trim();
  const blizzardClientSecret = headers.get("x-blizzard-client-secret")?.trim();
  if (blizzardClientId && blizzardClientSecret) {
    overrides.blizzard = createBlizzardClient({
      fetch: globalThis.fetch,
      clientId: blizzardClientId,
      clientSecret: blizzardClientSecret
    });
  }

  const raiderIoAccessKey = headers.get("x-raiderio-access-key")?.trim();
  if (raiderIoAccessKey) {
    overrides.raiderio = createRaiderIoClient({
      fetch: globalThis.fetch,
      baseUrl: config.dossier.raiderIoBaseUrl,
      timeoutMs: config.dossier.raiderIoTimeoutMs,
      accessKey: raiderIoAccessKey
    });
  }

  const wclClientId = headers.get("x-wcl-client-id")?.trim();
  const wclClientSecret = headers.get("x-wcl-client-secret")?.trim();
  if (wclClientId && wclClientSecret) {
    overrides.wclCredentials = {
      clientId: wclClientId,
      clientSecret: wclClientSecret
    };
  }

  return overrides;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @slashwho/web test -- credential-headers.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the route**

In `apps/web/src/app/api/dossiers/[region]/[realm]/[name]/route.ts`, import `readCredentialOverrides` and pass it through:

```ts
const { dossiers, searches } = await getContainer();
const denied = publicReadAuthorizationResponse(
  await searches.authorizePublicRead(request.headers)
);
if (denied) return denied;
const { loadWebConfig } = await import("../../../../../../server/config");
const overrides = readCredentialOverrides(request.headers, loadWebConfig());
const result =
  new URL(request.url).searchParams.get("scope") === "initial"
    ? await dossiers.readInitial(parsed.key, request.signal, overrides)
    : await dossiers.read(parsed.key, request.signal, overrides);
```

(Prefer importing `loadWebConfig` at the top of the file alongside the route's other imports rather than a dynamic import — check whether `getContainer` already exposes the resolved `WebConfig`; if it does, use that instead of calling `loadWebConfig()` a second time. Read `apps/web/src/server/container.ts`'s exports before deciding.)

- [ ] **Step 6: Update the route's existing tests**

In the route's test file, add a case asserting that when `x-blizzard-client-id`/`x-blizzard-client-secret` headers are sent, `dossiers.read`/`readInitial` is called with a `blizzard` override present (mock `getContainer` the same way this file's existing tests already do, and assert on the mock's call arguments).

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @slashwho/web test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/server/credential-headers.ts apps/web/src/server/credential-headers.test.ts apps/web/src/app/api/dossiers/[region]/[realm]/[name]/route.ts apps/web/src/app/api/dossiers/api-contract.test.ts
git commit -m "feat(web): build per-request gateways from visitor-supplied credential headers"
```

---

### Task 7: Worker decrypts and uses per-run WCL credentials

**Files:**
- Modify: `packages/application/src/applicant-evidence-job-handler.ts`
- Modify: `packages/application/src/applicant-evidence-job-handler.test.ts`
- Modify: `apps/worker/src/runtime.ts`
- Modify: `apps/worker/src/runtime.test.ts`

**Interfaces:**
- Consumes: `decryptCredential` (Task 2), `CharacterEvidenceRun.wclClientIdEncrypted`/`wclClientSecretEncrypted` (Task 4).
- Produces: `ApplicantEvidenceJobHandlerOptions.createWarcraftLogsGateway?: (credentials: { clientId: string; clientSecret: string }) => Pick<WarcraftLogsGateway, "getFirstKillReports">` and `ApplicantEvidenceJobHandlerOptions.decryptionKey?: Buffer`.

- [ ] **Step 1: Write the failing test**

In `applicant-evidence-job-handler.test.ts`, find the existing `execute` happy-path test and add:

```ts
it("builds a per-run gateway from encrypted run credentials when present", async () => {
  const perRunGateway = {
    getFirstKillReports: vi.fn().mockResolvedValue({
      kind: "evidence",
      kills: [],
      wipes: [],
      limitation: null,
      parseLimitation: null
    })
  };
  const createWarcraftLogsGateway = vi.fn().mockReturnValue(perRunGateway);
  const evidence = {
    claim: vi.fn().mockResolvedValue({
      id: "run-1",
      key: { region: "eu", realm: "silvermoon", name: "Testcharacter" },
      status: "running",
      createdAt: new Date(),
      wclClientIdEncrypted: encryptCredential("user-id", encryptionKey),
      wclClientSecretEncrypted: encryptCredential("user-secret", encryptionKey)
    }),
    publish: vi.fn().mockResolvedValue(undefined),
    find: vi.fn(),
    fail: vi.fn()
  };
  const handler = createApplicantEvidenceJobHandler({
    evidence,
    warcraftLogs: { getFirstKillReports: vi.fn() }, // must NOT be called
    createWarcraftLogsGateway,
    decryptionKey: encryptionKey,
    requestCap: 80,
    parseRequestCap: 8
  });

  await handler.execute("run-1", {
    attempt: 1,
    maxAttempts: 1,
    signal: new AbortController().signal
  });

  expect(createWarcraftLogsGateway).toHaveBeenCalledWith({
    clientId: "user-id",
    clientSecret: "user-secret"
  });
  expect(perRunGateway.getFirstKillReports).toHaveBeenCalled();
});
```

Add the matching `import { encryptCredential } from "./credential-encryption";` and a shared `encryptionKey` fixture (`parseEncryptionKey("a".repeat(64))`) near the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @slashwho/application test -- applicant-evidence-job-handler.test.ts`
Expected: FAIL — `createWarcraftLogsGateway` unused, `options.warcraftLogs` called instead.

- [ ] **Step 3: Implement**

In `packages/application/src/applicant-evidence-job-handler.ts`:

```ts
import { decryptCredential } from "./credential-encryption";

export type ApplicantEvidenceJobHandlerOptions = Readonly<{
  evidence: ApplicantEvidenceStore;
  warcraftLogs: Pick<WarcraftLogsGateway, "getFirstKillReports">;
  createWarcraftLogsGateway?: (credentials: {
    clientId: string;
    clientSecret: string;
  }) => Pick<WarcraftLogsGateway, "getFirstKillReports">;
  decryptionKey?: Buffer;
  requestCap: number;
  parseRequestCap: number;
  now?: () => Date;
}>;
```

Also extend `ApplicantEvidenceRun` with the two nullable encrypted fields so `run` (returned from `claim`) carries them:

```ts
export type ApplicantEvidenceRun = Readonly<{
  id: string;
  key: CharacterKey;
  status: "queued" | "running" | "retrying" | "complete" | "partial" | "failed";
  createdAt: Date;
  wclClientIdEncrypted: string | null;
  wclClientSecretEncrypted: string | null;
}>;
```

In `execute`, after `const run = await options.evidence.claim(...)`, resolve the gateway to use:

```ts
const run = await options.evidence.claim(runId, activeContext.attempt);
if (!run) return;

const gateway =
  run.wclClientIdEncrypted &&
  run.wclClientSecretEncrypted &&
  options.createWarcraftLogsGateway &&
  options.decryptionKey
    ? options.createWarcraftLogsGateway({
        clientId: decryptCredential(run.wclClientIdEncrypted, options.decryptionKey),
        clientSecret: decryptCredential(
          run.wclClientSecretEncrypted,
          options.decryptionKey
        )
      })
    : options.warcraftLogs;

activeContext.signal.throwIfAborted();
const response = await gateway.getFirstKillReports(run.key, {
  requestCap: options.requestCap,
  parseRequestCap: options.parseRequestCap,
  signal: activeContext.signal
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @slashwho/application test -- applicant-evidence-job-handler.test.ts`
Expected: PASS. Also run the full package suite to confirm the `ApplicantEvidenceRun` shape change didn't break other callers.

- [ ] **Step 5: Wire the worker runtime**

In `apps/worker/src/runtime.ts`, alongside the existing `createEvidenceGateway` dependency, add a factory that builds a per-run gateway from decrypted credentials, and pass it plus the decryption key into the handler:

```ts
createEvidenceHandler: createApplicantEvidenceJobHandler, // unchanged
```

At the `dependencies.createEvidenceHandler({...})` call site (around the existing `warcraftLogs: dependencies.createEvidenceGateway(config)` line):

```ts
const evidenceHandler = dependencies.createEvidenceHandler({
  evidence,
  warcraftLogs: dependencies.createEvidenceGateway(config),
  createWarcraftLogsGateway: (credentials) =>
    createWarcraftLogsClient({
      fetch: globalThis.fetch,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret
    }),
  decryptionKey: config.evidenceJobCredentialEncryptionKey,
  requestCap: config.evidenceRequestCap,
  parseRequestCap: config.evidenceParseRequestCap
});
```

`createWarcraftLogsClient` is already imported in this file (it's used two lines above for `createEvidenceGateway`).

- [ ] **Step 6: Update runtime test**

In `apps/worker/src/runtime.test.ts`, find the test(s) asserting on `createEvidenceHandler`'s call arguments and extend the expectation to include `createWarcraftLogsGateway` (a function) and `decryptionKey` (the fixture's encryption key buffer).

- [ ] **Step 7: Run tests to verify they pass**

`apps/worker` has no `test` script of its own; run it from the repo root:

Run: `pnpm vitest run --project unit apps/worker/src`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/application/src/applicant-evidence-job-handler.ts packages/application/src/applicant-evidence-job-handler.test.ts apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts
git commit -m "feat(worker): decrypt and use per-run WCL credentials when present"
```

---

### Task 8: Settings page and localStorage credential store

**Files:**
- Create: `apps/web/src/lib/api-credentials.ts`
- Create: `apps/web/src/lib/api-credentials.test.ts`
- Create: `apps/web/src/app/settings/page.tsx`
- Create: `apps/web/src/app/settings/page.test.tsx`
- Modify: `apps/web/src/components/site-header.tsx`

**Interfaces:**
- Produces: `readStoredCredentials(): StoredApiCredentials`, `writeStoredCredentials(value: StoredApiCredentials): void`, `clearStoredCredentials(): void`, and `type StoredApiCredentials = { blizzardClientId: string; blizzardClientSecret: string; raiderIoAccessKey: string; wclClientId: string; wclClientSecret: string }` (all fields default to `""`), plus `credentialHeaders(credentials: StoredApiCredentials): HeadersInit` for Task 9 to reuse.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  clearStoredCredentials,
  credentialHeaders,
  readStoredCredentials,
  writeStoredCredentials
} from "./api-credentials";

afterEach(() => {
  clearStoredCredentials();
});

describe("api-credentials", () => {
  it("returns empty strings when nothing is stored", () => {
    expect(readStoredCredentials()).toEqual({
      blizzardClientId: "",
      blizzardClientSecret: "",
      raiderIoAccessKey: "",
      wclClientId: "",
      wclClientSecret: ""
    });
  });

  it("round-trips written credentials", () => {
    writeStoredCredentials({
      blizzardClientId: "id",
      blizzardClientSecret: "secret",
      raiderIoAccessKey: "key",
      wclClientId: "wid",
      wclClientSecret: "wsecret"
    });
    expect(readStoredCredentials()).toEqual({
      blizzardClientId: "id",
      blizzardClientSecret: "secret",
      raiderIoAccessKey: "key",
      wclClientId: "wid",
      wclClientSecret: "wsecret"
    });
  });

  it("omits headers for empty fields and includes headers for filled ones", () => {
    const headers = credentialHeaders({
      blizzardClientId: "id",
      blizzardClientSecret: "secret",
      raiderIoAccessKey: "",
      wclClientId: "",
      wclClientSecret: ""
    });
    expect(headers).toEqual({
      "x-blizzard-client-id": "id",
      "x-blizzard-client-secret": "secret"
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @slashwho/web test -- api-credentials.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
const STORAGE_KEY = "slashwho:api-credentials";

export type StoredApiCredentials = {
  blizzardClientId: string;
  blizzardClientSecret: string;
  raiderIoAccessKey: string;
  wclClientId: string;
  wclClientSecret: string;
};

const empty: StoredApiCredentials = {
  blizzardClientId: "",
  blizzardClientSecret: "",
  raiderIoAccessKey: "",
  wclClientId: "",
  wclClientSecret: ""
};

export function readStoredCredentials(): StoredApiCredentials {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...empty };
    const parsed = JSON.parse(raw) as Partial<StoredApiCredentials>;
    return {
      blizzardClientId: parsed.blizzardClientId ?? "",
      blizzardClientSecret: parsed.blizzardClientSecret ?? "",
      raiderIoAccessKey: parsed.raiderIoAccessKey ?? "",
      wclClientId: parsed.wclClientId ?? "",
      wclClientSecret: parsed.wclClientSecret ?? ""
    };
  } catch {
    return { ...empty };
  }
}

export function writeStoredCredentials(value: StoredApiCredentials): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable (private browsing, quota). Credentials simply
    // won't persist across reloads; nothing else depends on this write.
  }
}

export function clearStoredCredentials(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // See writeStoredCredentials.
  }
}

export function credentialHeaders(
  credentials: StoredApiCredentials
): HeadersInit {
  const headers: Record<string, string> = {};
  if (credentials.blizzardClientId && credentials.blizzardClientSecret) {
    headers["x-blizzard-client-id"] = credentials.blizzardClientId;
    headers["x-blizzard-client-secret"] = credentials.blizzardClientSecret;
  }
  if (credentials.raiderIoAccessKey) {
    headers["x-raiderio-access-key"] = credentials.raiderIoAccessKey;
  }
  if (credentials.wclClientId && credentials.wclClientSecret) {
    headers["x-wcl-client-id"] = credentials.wclClientId;
    headers["x-wcl-client-secret"] = credentials.wclClientSecret;
  }
  return headers;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @slashwho/web test -- api-credentials.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the settings page**

Read `apps/web/src/app/changelog/page.tsx` first to match this app's existing page-component conventions (heading structure, CSS class naming) before writing markup. Then create `apps/web/src/app/settings/page.tsx` as a client component:

```tsx
"use client";

import { useEffect, useState } from "react";

import {
  readStoredCredentials,
  writeStoredCredentials,
  clearStoredCredentials,
  type StoredApiCredentials
} from "../../lib/api-credentials";

const emptyCredentials: StoredApiCredentials = {
  blizzardClientId: "",
  blizzardClientSecret: "",
  raiderIoAccessKey: "",
  wclClientId: "",
  wclClientSecret: ""
};

export default function SettingsPage() {
  const [credentials, setCredentials] = useState(emptyCredentials);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setCredentials(readStoredCredentials());
  }, []);

  function field(
    key: keyof StoredApiCredentials
  ): { value: string; onChange: (event: React.ChangeEvent<HTMLInputElement>) => void } {
    return {
      value: credentials[key],
      onChange: (event) => {
        setSaved(false);
        setCredentials((current) => ({ ...current, [key]: event.target.value }));
      }
    };
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    writeStoredCredentials(credentials);
    setSaved(true);
  }

  function onClear() {
    clearStoredCredentials();
    setCredentials(emptyCredentials);
    setSaved(false);
  }

  return (
    <main className="settings-page">
      <h1>Your API keys</h1>
      <p>
        Supply your own Blizzard, Raider.IO, and Warcraft Logs API credentials
        to use your own upstream rate-limit budget instead of SlashWho&apos;s
        shared one. These are stored only in this browser and are never sent
        anywhere except to the matching provider&apos;s API.
      </p>
      <form onSubmit={onSubmit}>
        <fieldset>
          <legend>Blizzard</legend>
          <label>
            Client ID
            <input type="text" autoComplete="off" {...field("blizzardClientId")} />
          </label>
          <label>
            Client secret
            <input type="password" autoComplete="off" {...field("blizzardClientSecret")} />
          </label>
        </fieldset>
        <fieldset>
          <legend>Raider.IO</legend>
          <label>
            Access key
            <input type="password" autoComplete="off" {...field("raiderIoAccessKey")} />
          </label>
        </fieldset>
        <fieldset>
          <legend>Warcraft Logs</legend>
          <label>
            Client ID
            <input type="text" autoComplete="off" {...field("wclClientId")} />
          </label>
          <label>
            Client secret
            <input type="password" autoComplete="off" {...field("wclClientSecret")} />
          </label>
        </fieldset>
        <button type="submit">Save</button>
        <button type="button" onClick={onClear}>
          Clear all
        </button>
        {saved ? <p role="status">Saved.</p> : null}
      </form>
    </main>
  );
}
```

- [ ] **Step 6: Write a page test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import SettingsPage from "./page";
import { clearStoredCredentials, readStoredCredentials } from "../../lib/api-credentials";

afterEach(() => {
  clearStoredCredentials();
});

describe("SettingsPage", () => {
  it("saves entered credentials to local storage", async () => {
    render(<SettingsPage />);
    await userEvent.type(screen.getByLabelText("Client ID"), "user-id");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(readStoredCredentials().blizzardClientId).toBe("user-id");
  });
});
```

(Match this test's imports/queries to whatever testing utilities the rest of `apps/web/src/components/*.test.tsx` already use — check one such file first for the exact render/testing-library setup, since there may be a shared test-utils wrapper.)

- [ ] **Step 7: Add a nav link**

In `apps/web/src/components/site-header.tsx`, add a link inside the existing `<nav>` next to the changelog link:

```tsx
<Link href="/settings" className="site-nav-link">
  Settings
</Link>
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @slashwho/web test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/api-credentials.ts apps/web/src/lib/api-credentials.test.ts apps/web/src/app/settings apps/web/src/components/site-header.tsx
git commit -m "feat(web): add a settings page for browser-local API credentials"
```

---

### Task 9: Attach credential headers on dossier reads

**Files:**
- Modify: `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.tsx`
- Modify: `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx`

**Interfaces:**
- Consumes: `readStoredCredentials`, `credentialHeaders` (Task 8).

- [ ] **Step 1: Write the failing test**

In `dossier-page-client.test.tsx`, find the existing test that asserts on the `fetch` call for `readInitialDossier` (or the full `readDossier`) and add:

```ts
it("attaches stored credential headers to the dossier fetch", async () => {
  writeStoredCredentials({
    blizzardClientId: "id",
    blizzardClientSecret: "secret",
    raiderIoAccessKey: "",
    wclClientId: "",
    wclClientSecret: ""
  });
  // render the component the same way this file's existing fetch tests do
  // ...
  expect(fetchMock).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      headers: expect.objectContaining({
        "x-blizzard-client-id": "id",
        "x-blizzard-client-secret": "secret"
      })
    })
  );
});
```

Import `writeStoredCredentials`/`clearStoredCredentials` from `../../../../../lib/api-credentials` and clear storage in an `afterEach`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @slashwho/web test -- dossier-page-client.test.tsx`
Expected: FAIL — fetch called without the header keys.

- [ ] **Step 3: Implement**

In `dossier-page-client.tsx`, import `credentialHeaders` and `readStoredCredentials` from `../../../../../lib/api-credentials`, and merge them into both `fetch` calls that hit `dossierPath` (the `scope=initial` one in `readInitialDossier`, and the corresponding full-dossier one later in the file — locate it by searching this file for the second `fetch(dossierPath`):

```ts
const response = await fetch(`${dossierPath}?scope=initial`, {
  cache: "no-store",
  signal: controller.signal,
  headers: credentialHeaders(readStoredCredentials())
});
```

Apply the same `headers: credentialHeaders(readStoredCredentials())` addition to the other dossier-path fetch call in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @slashwho/web test -- dossier-page-client.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.tsx apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx
git commit -m "feat(web): send stored API credentials with dossier reads"
```

---

### Task 10: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full monorepo test suite**

Run: `pnpm test` (root script — confirm it fans out to every workspace by checking root `package.json`)
Expected: PASS across every package and app.

- [ ] **Step 2: Run lint, typecheck, and format check**

Run: `pnpm lint && pnpm typecheck && pnpm format:check` (confirm exact script names in root `package.json` first; use whatever this repo's other recent plans/specs reference, e.g. the verification steps in `docs/superpowers/specs/2026-09-12-official-raid-artwork-design.md`).
Expected: PASS.

- [ ] **Step 3: Confirm no credential leakage**

Search for accidental logging of the new headers or decrypted values:

```bash
grep -rn "x-blizzard-client-secret\|x-wcl-client-secret\|x-raiderio-access-key" apps/web/src/server apps/worker/src --include="*.ts" | grep -i "log\|console"
```

Expected: no matches.

- [ ] **Step 4: Manual smoke test**

Start the stack locally (`docker compose up` or this repo's existing local-dev script — check `README.md`), open `/settings`, enter a Blizzard client ID/secret and a Raider.IO access key, save, then search for a character and confirm the dossier loads. Set `EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY` identically in both the web and worker `.env` files before starting.

- [ ] **Step 5: Deploy verification**

Follow this repo's existing live-deployment verification step (see `docs/deployment/railway.md` and the "Verification" section pattern used in prior specs) before considering this feature done.
