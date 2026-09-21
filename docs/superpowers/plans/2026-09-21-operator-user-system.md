# Operator User System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Replace #382's shared-key browser session with accountable, database-backed operator authentication while preserving BOT_API_KEY Bearer automation.

**Architecture:** PostgreSQL owns operators, sessions, throttles, and audit events through a focused repository adapter. A deep web authentication module turns requests into a principal plus optional cookie directive, so routes and pages do not parse cookies or issue credentials themselves.

**Tech Stack:** TypeScript, Node crypto scrypt/HMAC, PostgreSQL, Drizzle, Next.js 16, Vitest, Playwright.

**Spec:** \`docs/superpowers/specs/2026-09-21-operator-user-system-design.md\`

## Global Constraints

- Preserve valid Bearer BOT_API_KEY automation; an invalid Authorization header never falls back to a cookie.
- Browser cookies always use __Host-, Path=/, HttpOnly, Secure, and SameSite=Strict. Do not weaken these in local or E2E configuration.
- Use a 30-minute idle and eight-hour absolute session lifetime; PostgreSQL is authoritative.
- Canonical logins are bounded ASCII lowercase. Credentials have 20+ characters and never appear in logs, URLs, arguments, responses, client bundles, or local storage.
- The only role is operator. Do not add registration, recovery, applicant accounts, social login, or account-management UI.
- Session mutations are JSON POST requests with exact OPERATOR_ORIGIN and Sec-Fetch-Site: same-origin.
- Audit events carry only nullable operator ID, action, outcome, and timestamp.
- Hold any eventual PR for manager review; do not enable auto-merge or merge it.

---

### Task 1: Add the operator-auth persistence contract

**Files:**

- Modify: \`packages/database/src/schema.ts\`
- Modify: \`packages/database/src/repositories.ts\`
- Modify: \`packages/database/src/index.ts\`
- Create: \`packages/database/drizzle/0034_operator_auth.sql\`
- Modify: \`packages/database/drizzle/meta/_journal.json\`
- Test: \`tests/integration/migrations.test.ts\`

**Interfaces:**

- Produces \`Repositories["operatorAuth"]\`, with operator credential lookup/mutation, hashed login-attempt admission, safe event append, session issue/conditional use/revoke, and expiry cleanup.
- Produces records that expose neither raw passwords nor raw session secrets.

- [ ] **Step 1: Write the failing migration contract test**

Extend the migration integration fixture to assert that the migrated database has \`operators\`, \`operator_sessions\`, \`operator_login_attempts\`, and \`operator_auth_events\`; assert canonical-login uniqueness and indexes for live-session, throttle-window, and audit lookup.

```ts
expect(columns("operators")).toContain("canonical_login");
expect(columns("operator_sessions")).toEqual(
  expect.arrayContaining([
    "operator_id",
    "secret_digest",
    "credential_version",
    "idle_expires_at",
    "absolute_expires_at",
    "revoked_at"
  ])
);
```

- [ ] **Step 2: Run the test to prove it fails**

Run: \`corepack pnpm test:integration -- tests/integration/migrations.test.ts\`

Expected: FAIL because operator-auth tables are absent.

- [ ] **Step 3: Add schema, repository types, and generated migration**

Define the four tables. Operators include stable UUID, canonical/display login, scrypt hash/salt/version/cost, active state, credential version, and timestamps. Sessions include opaque ID, secret digest, operator/version links, all time boundaries, and revocation. Login attempts store only HMAC subject hash plus expiry. Events hold only nullable operator ID, authored action/outcome, and timestamp. Generate SQL with \`packages/database/drizzle.config.ts\`, inspect it, and retain its journal update.

- [ ] **Step 4: Run the migration test to prove it passes**

Run: \`corepack pnpm test:integration -- tests/integration/migrations.test.ts\`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/schema.ts packages/database/src/repositories.ts packages/database/src/index.ts packages/database/drizzle tests/integration/migrations.test.ts
git commit -m "feat(auth): add operator authentication persistence"
```

### Task 2: Implement the atomic PostgreSQL operator-auth adapter

**Files:**

- Modify: \`packages/database/src/postgres-repositories.ts\`
- Test: \`tests/integration/repositories.test.ts\`
- Test: \`packages/database/src/postgres-repositories.test.ts\`

**Interfaces:**

- Consumes Task 1's \`operatorAuth\` repository contract.
- Produces \`useSession(input)\`, which atomically returns the active operator/session projection or null, never a raw secret.

- [ ] **Step 1: Write failing repository integration tests**

Provision a known operator through the adapter, issue a digest-only session, then assert valid use renews idle expiry but cannot pass absolute expiry.

```ts
await expect(
  auth.useSession({ sessionId, secretDigest, at })
).resolves.toMatchObject({
  operator: { id: operatorId, active: true },
  session: { absoluteExpiresAt }
});
await expect(
  auth.useSession({ sessionId, secretDigest, at: expired })
).resolves.toBeNull();
```

Cover wrong digest, revoked session, disabled operator, stale credential version, idle expiry, absolute expiry, rotate/disable revoking all sessions in the same transaction, per-subject/global hashed throttles, and only-safe audit data.

- [ ] **Step 2: Run the focused test to prove it fails**

Run: \`corepack pnpm test:integration -- tests/integration/repositories.test.ts\`

Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement the adapter**

Add \`operatorAuth\` in \`createPostgresRepositories\`. Use parameterized SQL and transactions for provision/rotate/disable plus audit append. Implement session use as a single \`UPDATE ... FROM operators ... WHERE\` checking digest, active state, credential version, revocation, idle expiry, and absolute expiry; return the renewed bounded deadline only when one row updates. Cleanup deletes only expired/revoked sessions and expired throttle rows.

- [ ] **Step 4: Verify repository behavior**

Run: \`corepack pnpm test:integration -- tests/integration/repositories.test.ts\`

Run: \`corepack pnpm test:unit -- packages/database/src/postgres-repositories.test.ts\`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/postgres-repositories.ts tests/integration/repositories.test.ts packages/database/src/postgres-repositories.test.ts
git commit -m "feat(auth): persist revocable operator sessions"
```

### Task 3: Build the credential and deep authentication module

**Files:**

- Create: \`apps/web/src/server/operator-auth.ts\`
- Create: \`apps/web/src/server/operator-auth.test.ts\`
- Delete: \`apps/web/src/server/operator-session.ts\`
- Delete: \`apps/web/src/server/operator-session.test.ts\`
- Modify: \`apps/web/src/server/config.ts\`
- Modify: \`apps/web/src/server/config.test.ts\`
- Modify: \`.env.example\`
- Modify: \`docs/deployment/railway.md\`

**Interfaces:**

- Consumes \`Repositories["operatorAuth"]\`, ApplicationConfig, exact OPERATOR_ORIGIN, and injectable clock/random sources.
- Produces \`authenticateOperator(request)\`, \`signIn(request)\`, and \`signOut(request)\`, each returning principal plus optional CookieDirective.

- [ ] **Step 1: Write failing module/config tests**

Use adapter fakes to test valid automation, invalid Bearer precedence, valid operator sign-in, strict ASCII login rejection, scrypt salt/parameter storage, generic denial, duplicate/tampered cookies, exact origin/Fetch Metadata/content-type/method rejection, throttle fallback, safe audit invocation, Max-Age and Expires, bounded renewal, revocation, and session-secret rotation.

```ts
await expect(
  auth.authenticateOperator(validBearerRequest)
).resolves.toMatchObject({
  principal: { kind: "automation" }
});
await expect(
  auth.authenticateOperator(invalidBearerAndValidCookie)
).resolves.toMatchObject({
  principal: null
});
```

Also require valid HTTPS OPERATOR_ORIGIN and 32+ character OPERATOR_SESSION_HASH_SECRET in web config tests.

- [ ] **Step 2: Run the tests to prove they fail**

Run: \`corepack pnpm test:unit -- apps/web/src/server/operator-auth.test.ts apps/web/src/server/config.test.ts\`

Expected: FAIL because the module/configuration is absent.

- [ ] **Step 3: Implement the module**

Use asynchronous Node scrypt and constant-time comparison. Render only hardened __Host cookies. Authenticate Bearer first with existing classifyCaller, then use a single parsed cookie only when Authorization is absent. Sign-in owns JSON/CSRF validation, credential verification, throttle admission, session issue, and audit. Sign-out owns equivalent request validation, current-session revocation, audit, and expiry directive. Never log a credential or raw token.

- [ ] **Step 4: Verify the module and legacy removal**

Run: \`corepack pnpm test:unit -- apps/web/src/server/operator-auth.test.ts apps/web/src/server/config.test.ts\`

Run: \`rg -n "createOperatorSessionCookie|isOperatorRequest|operatorKey" apps/web/src\`

Expected: tests PASS; the search has no production #382 session implementation.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/operator-auth.ts apps/web/src/server/operator-auth.test.ts apps/web/src/server/operator-session.ts apps/web/src/server/operator-session.test.ts apps/web/src/server/config.ts apps/web/src/server/config.test.ts .env.example docs/deployment/railway.md
git commit -m "feat(auth): authenticate accountable browser operators"
```

### Task 4: Route, page, and form integration

**Files:**

- Modify: \`apps/web/src/server/container.ts\`
- Modify: \`apps/web/src/server/container.test.ts\`
- Modify: \`apps/web/src/app/api/operations/session/route.ts\`
- Modify: \`apps/web/src/app/api/operations/session/route.test.ts\`
- Modify: \`apps/web/src/app/api/operations/collection-monitor/route.ts\`
- Modify: \`apps/web/src/app/api/operations/collection-monitor/route.test.ts\`
- Modify: \`apps/web/src/app/operations/collection-monitor/page.tsx\`
- Modify: \`apps/web/src/app/operations/collection-monitor/page.test.tsx\`
- Modify: \`apps/web/src/app/operations/login/operator-login-form.tsx\`
- Modify: \`apps/web/src/app/operations/login/operator-login-form.test.tsx\`
- Modify: \`apps/web/src/app/operations/collection-monitor/operator-logout-button.tsx\`
- Modify: \`apps/web/src/app/operations/collection-monitor/operator-logout-button.test.tsx\`

**Interfaces:**

- Consumes Task 3 through a container-created authentication module.
- Produces HTTP routes that only translate principal/cookie results.

- [ ] **Step 1: Write failing route and UI tests**

Replace #382 key-exchange assertions with login/credential JSON. Assert success cookies expose neither login nor credential; rejected attempts are generic, no-store, and unreflected; legacy cookie values expire; invalid method/non-JSON/origin/Fetch-Metadata/throttle requests deny before monitor reads; and valid Bearer monitor automation still succeeds. Assert labels are Login/Credential, the credential state clears before response settlement, and logout is JSON POST.

- [ ] **Step 2: Run focused tests to prove they fail**

Run: \`corepack pnpm test:unit -- apps/web/src/app/api/operations/session/route.test.ts apps/web/src/app/api/operations/collection-monitor/route.test.ts apps/web/src/app/operations/login/operator-login-form.test.tsx apps/web/src/app/operations/collection-monitor/page.test.tsx\`

Expected: FAIL because code still uses #382's key exchange and boolean seam.

- [ ] **Step 3: Wire the container and replace route/UI behavior**

Construct the module from \`repositories.operatorAuth\` after migrations. Session and monitor routes call it once, add its Set-Cookie directive, and preserve generic bodies. The page authenticates before loading data. The login form submits login/credential; the logout form sends JSON POST. Preserve direct valid Bearer monitor API behavior.

- [ ] **Step 4: Verify focused tests and web build**

Run: \`corepack pnpm test:unit -- apps/web/src/app/api/operations/session/route.test.ts apps/web/src/app/api/operations/collection-monitor/route.test.ts apps/web/src/app/operations/login/operator-login-form.test.tsx apps/web/src/app/operations/collection-monitor/page.test.tsx\`

Run: \`corepack pnpm --filter @slashwho/web build\`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/container.ts apps/web/src/server/container.test.ts apps/web/src/app/api/operations/session apps/web/src/app/api/operations/collection-monitor apps/web/src/app/operations/login apps/web/src/app/operations/collection-monitor
git commit -m "feat(web): sign in operators with revocable sessions"
```

### Task 5: Operator lifecycle command and E2E coverage

**Files:**

- Create: \`scripts/operators.mts\`
- Create: \`scripts/operators.test.mts\`
- Modify: \`package.json\`
- Modify: \`tests/e2e/support/global-setup.ts\`
- Modify: \`playwright.config.ts\`
- Create: \`tests/e2e/operator-auth.spec.ts\`
- Modify: \`docs/deployment/railway.md\`

**Interfaces:**

- Consumes \`Repositories["operatorAuth"]\` and an injected hidden TTY reader.
- Produces \`corepack pnpm ops:operators -- <provision|rotate|disable|list>\`.

- [ ] **Step 1: Write failing CLI and browser-journey tests**

Test parser validation and hidden-prompt dependency injection without outputting credentials. Test provision/rotate/disable with canonical login and safe outcomes only. In E2E setup, provision a fixture directly via the repository and set OPERATOR_ORIGIN/session-hash secrets. Exercise redirect, sign-in, monitor access, sign-out, subsequent denial, and direct Bearer API success.

- [ ] **Step 2: Run the tests to prove they fail**

Run: \`corepack pnpm test:unit -- scripts/operators.test.mts\`

Run: \`corepack pnpm test:e2e -- tests/e2e/operator-auth.spec.ts\`

Expected: FAIL because command and journey are absent.

- [ ] **Step 3: Implement operations and production-strength E2E setup**

Follow \`scripts/rebuild-character.mts\` entrypoint conventions but reject non-interactive credential input rather than reading an environment value. Add the root script. Keep cookie flags unchanged; run browser coverage over HTTPS or, where the current HTTP harness cannot carry Secure cookies, retain direct header tests and add an HTTPS-capable fixture rather than weaken attributes. Document provisioning, rotation, disablement, hash-secret rotation, and audit review.

- [ ] **Step 4: Verify operations and E2E**

Run: \`corepack pnpm test:unit -- scripts/operators.test.mts\`

Run: \`corepack pnpm test:e2e -- tests/e2e/operator-auth.spec.ts\`

Expected: PASS with no Secure or __Host exception.

- [ ] **Step 5: Commit**

```bash
git add scripts/operators.mts scripts/operators.test.mts package.json tests/e2e/support/global-setup.ts playwright.config.ts tests/e2e/operator-auth.spec.ts docs/deployment/railway.md
git commit -m "feat(ops): manage operator credentials"
```

### Task 6: Full verification and manager-review handoff

**Files:**

- Modify only for a confirmed gate/review defect.

- [ ] **Step 1: Run the complete local gate**

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm test:integration
corepack pnpm build
corepack pnpm test:e2e
```

Expected: every command exits 0; diagnose and fix failures rather than rerunning unchanged.

- [ ] **Step 2: Review the complete diff**

Run Codex \`/review\` against origin/main at low reasoning effort. Verify every finding; after any change, rerun the full gate.

- [ ] **Step 3: Synchronize with current trunk and repeat the gate**

```bash
git fetch origin
git merge origin/main
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm test:integration
corepack pnpm build
corepack pnpm test:e2e
```

Expected: clean merge and all gates passing.

- [ ] **Step 4: Stop for manager review**

Do not open a PR, enable auto-merge, or merge without separate manager authorization. Report the commit range, gate output, review result, migration, and deployment notes.
