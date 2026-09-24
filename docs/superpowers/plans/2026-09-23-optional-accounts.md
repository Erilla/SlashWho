# Optional Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`-[ ]`) syntax for tracking.

**Goal:** Add optional verified email accounts, encrypted account API keys, and admin-only account management and monitoring while keeping public functionality open.

**Architecture:** Extend the existing operator repository, opaque sessions, and route guard into an account boundary. PostgreSQL owns account state, encrypted provider credentials, single-use mail tokens, and a durable encrypted mail outbox; web routes and the worker consume focused service interfaces. A character's existing evidence reservation remains shared, with the first reservation fixing its credential source.

**Tech Stack:** TypeScript, Node 22 crypto, PostgreSQL and Drizzle, Next.js 16, Vitest, Playwright, Resend HTTP API.

**Spec:** `docs/superpowers/specs/2026-09-23-optional-accounts-design.md`

## Global Constraints

- Public search, dossiers, evidence collection, controls, rate limits, and allowance policy work without registration.
- Roles are `user` and `admin`; only admin settings and monitor pages/APIs require admin, with valid `BOT_API_KEY` automation retaining monitor API access.
- Delete legacy operator accounts and sessions on migration; retain anonymized authentication events and public data. Bootstrap the first verified admin by hidden CLI temporary password, requiring a change at first sign-in.
- Canonical email is trimmed, bounded, validated ASCII mail syntax, and ASCII lowercase everywhere. Passwords retain versioned salted scrypt and the 20-character minimum.
- Registration is open but email verification is required for account sign-in. Activation requires the link and registration password. Successful recovery of an unverified account verifies it.
- Registration has per-trusted-IP, global, missing-IP fallback, and per-address-HMAC limits; valid duplicate registration responses do not enumerate accounts. Unverified accounts expire after seven days.
- Mutations require the current exact Origin, same-origin Fetch Metadata, bounded JSON bodies, and live session authorization.
- Resend uses a verified sender. Mail token digests and encrypted outbox payloads commit together; uncertain sends retry the same message and idempotency key.
- Email change requires current-mailbox approval and new-mailbox confirmation; admins cannot choose another user's address.
- Account keys use authenticated server-side encryption and never return as secrets. Signed-out browser credentials keep working. Signed-in requests ignore stale browser key headers.
- Queued signed-in Warcraft Logs jobs reference account ID and key version. A changed or disabled key falls back to the shared gateway. Later callers joining a run do not replace its key.
- Use `corepack pnpm` commands, heed `apps/web/AGENTS.md` and the installed Next.js guide, run the README gate, open a PR, and do not merge.

## Review Focus

1. Concurrent registrations for the same canonical email yield one pending account and indistinguishable accepted responses; Task 2 pins this.
2. Requests without trusted `X-Real-IP` consume the bounded fallback bucket and cannot use spoofed forwarding headers; Task 2 pins this.
3. A crash after Resend accepts mail but before outbox acknowledgement retries the same encrypted message and link; Task 3 pins this.
4. Simultaneous admin demotions cannot remove the last active admin; Task 4 pins this.
5. A second account joining an active evidence run with a different key cannot change the first run's key or receive it; Task 10 pins this.

---

### Task 1: Persist accounts, tokens, outbox, and key references

**Files:**

- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/repositories.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/drizzle/0047_optional_accounts.sql`
- Modify: `packages/database/drizzle/meta/_journal.json`
- Test: `tests/integration/migrations.test.ts`

**Interfaces:**

- Produces `Account` with `id`, `canonicalEmail`, `email`, `role`, `active`, `verifiedAt`, `passwordChangeRequired`, `credentialVersion`.
- Produces `AccountAuthRepository`, `AccountMailRepository`, and `AccountCredentialRepository` interfaces on `Repositories`, specified by Tasks 2, 3, and 9.
- Produces `character_evidence_runs.account_credential_owner_id` and `account_credential_version`, nullable for signed-out runs.

Use these shared projections; no public projection contains a password hash, token digest, or saved key.

```ts
type AccountSummary = Pick<
  Account,
  "id" | "email" | "role" | "active" | "verifiedAt" | "createdAt"
>;
type MailOutboxRow = {
  id: string;
  encryptedMessage: string;
  idempotencyKey: string;
  expiresAt: Date;
  attempt: number;
};
type Provider = "blizzard" | "raiderio" | "warcraftlogs";
type ProviderPresence = {
  provider: Provider;
  present: boolean;
  version: number;
  updatedAt: Date | null;
};
type ProviderCredentials =
  | { provider: "blizzard"; clientId: string; clientSecret: string }
  | { provider: "raiderio"; accessKey: string }
  | { provider: "warcraftlogs"; clientId: string; clientSecret: string };
```

- [ ] **Step 1: Write the migration contract test.**

Apply migrations through `0046`, insert one legacy operator, session, and auth event, then apply `0047` and assert the reset and retained event.

```ts
const tables = await pool.query<{ tablename: string }>(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
);
expect(tables.rows.map((row) => row.tablename)).toContain("accounts");
expect(tables.rows.map((row) => row.tablename)).toContain(
  "account_mail_outbox"
);
expect(tables.rows.map((row) => row.tablename)).toContain(
  "account_api_credentials"
);
expect((await pool.query("SELECT id FROM operators")).rows).toHaveLength(0);
expect(
  (await pool.query("SELECT id FROM operator_sessions")).rows
).toHaveLength(0);
expect(
  (await pool.query("SELECT operator_id, action FROM operator_auth_events"))
    .rows
).toContainEqual({ operator_id: null, action: "sign_in" });
```

- [ ] **Step 2: Prove the contract fails.**

Run: `corepack pnpm test:integration -- tests/integration/migrations.test.ts`
Expected: FAIL because the account tables and columns are absent.

- [ ] **Step 3: Add the schema and forward-only migration.**

```sql
UPDATE operator_auth_events SET operator_id = NULL;
DELETE FROM operator_sessions;
DELETE FROM operators;
ALTER TABLE character_evidence_runs ADD COLUMN account_credential_owner_id uuid;
ALTER TABLE character_evidence_runs ADD COLUMN account_credential_version integer;
```

Use a transaction, preserve event timestamps/actions, keep the old operator tables only as needed for a safe transition, and inspect generated SQL. Define unique canonical-email and owner/provider keys, token digest indexes, outbox due indexes, and a seven-day unverified cleanup path.

- [ ] **Step 4: Run the migration test and inspect the migration diff.**

Run: `corepack pnpm test:integration -- tests/integration/migrations.test.ts`
Expected: PASS; public tables retain their fixtures and old accounts/sessions are gone.

- [ ] **Step 5: Commit.**

```sh
git add packages/database tests/integration/migrations.test.ts
git commit -m "feat(accounts): add persistence and reset legacy operators"
```

### Task 2: Implement registration, canonical email, and admission limits

**Files:**

- Create: `apps/web/src/server/account-email.ts`
- Create: `apps/web/src/server/account-email.test.ts`
- Modify: `packages/database/src/postgres-repositories.ts`
- Test: `tests/integration/repositories.test.ts`

**Interfaces:**

- Produces `canonicalizeEmail(input: string): string | null`.
- Produces `accountAuth.registerPending({canonicalEmail, email, passwordHash, passwordSalt, scryptVersion, scryptCost, at}): Promise<{kind:"created"|"existing"; accountId?:string}>`.
- Produces `accountAuth.admitRegistration({ipSubjectHash, emailSubjectHash, at}): Promise<"admitted"|"throttled">`.

- [ ] **Step 1: Write failing tests for normalization, concurrent duplicates, and all admission buckets.**

```ts
expect(canonicalizeEmail("  Person@Example.COM ")).toBe("person@example.com");
expect(canonicalizeEmail("bad@@example.com")).toBeNull();
const outcomes = await Promise.all([register(input), register(input)]);
expect(outcomes.map((x) => x.kind).sort()).toEqual(["created", "existing"]);
expect(await countAccounts("person@example.com")).toBe(1);
expect(await admitWithoutTrustedIp(11)).toBe("throttled");
```

- [ ] **Step 2: Prove the focused tests fail.**

Run: `corepack pnpm test:unit -- apps/web/src/server/account-email.test.ts`
Run: `corepack pnpm test:integration -- tests/integration/repositories.test.ts`
Expected: FAIL on missing functions.

- [ ] **Step 3: Implement canonicalization, atomic insert, and HMAC admission.**

```ts
const canonical = input.trim().toLowerCase();
if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(canonical))
  return null;
return canonical.length <= 254 ? canonical : null;
```

Use the existing trusted `X-Real-IP` treatment, never `X-Forwarded-For`. Expire pending accounts after seven days under a bounded cleanup query. Return the same route response for `created` and `existing`; no duplicate-account exception reaches the route.

- [ ] **Step 4: Re-run focused tests.**

Run: `corepack pnpm test:unit -- apps/web/src/server/account-email.test.ts`
Run: `corepack pnpm test:integration -- tests/integration/repositories.test.ts`
Expected: PASS, including concurrent registration.

- [ ] **Step 5: Commit.**

```sh
git add apps/web/src/server/account-email* packages/database/src/postgres-repositories.ts tests/integration/repositories.test.ts
git commit -m "feat(accounts): register bounded email identities"
```

### Task 3: Deliver transactional email through a durable outbox

**Files:**

- Create: `apps/worker/src/account-mail.ts`
- Create: `apps/worker/src/account-mail.test.ts`
- Modify: `apps/worker/src/config.ts`
- Modify: `apps/worker/src/runtime.ts`
- Modify: `packages/database/src/postgres-repositories.ts`
- Test: `tests/integration/repositories.test.ts`
- Modify: `.env.example`

**Interfaces:**

- Produces `accountMail.issue({accountId, purpose, destination, encryptedMessage, tokenDigest, expiresAt, at}): Promise<void>` as one transaction.
- Produces `accountMail.claimDue(at): Promise<MailOutboxRow | null>` and `accountMail.markSent(id, at): Promise<void>`.
- Produces `sendResend(message, idempotencyKey, config, fetch): Promise<void>`.

- [ ] **Step 1: Write failing outbox tests for commit, retry, expiry, and uncertain acceptance.**

```ts
await issueMail({
  tokenDigest: digest,
  encryptedMessage: encrypted,
  idempotencyKey: "mail-1"
});
expect(await tokenExists(digest)).toBe(true);
await dispatchAndCrashAfterResendAccepted();
await dispatchAgain();
expect(sentRequests.map((x) => x.idempotencyKey)).toEqual(["mail-1", "mail-1"]);
expect(sentRequests[1]?.message).toEqual(sentRequests[0]?.message);
```

- [ ] **Step 2: Prove tests fail.**

Run: `corepack pnpm test:unit -- apps/worker/src/account-mail.test.ts`
Run: `corepack pnpm test:integration -- tests/integration/repositories.test.ts`
Expected: FAIL because the outbox methods are absent.

- [ ] **Step 3: Implement transactional issue and worker dispatch.**

```ts
const outboxKey = hkdfSync(
  "sha256",
  accountCredentialKey,
  "",
  "account-mail-outbox-v1",
  32
);
const response = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${config.resendApiKey}`,
    "Idempotency-Key": row.idempotencyKey,
    "Content-Type": "application/json"
  },
  body: decryptedMessage
});
if (!response.ok) throw new Error("account_mail_delivery_failed");
```

Use parameterized row claims with a lease so a crash permits retry; persist bounded backoff and discard expired payloads. Keep Resend response bodies, addresses, tokens, and ciphertext out of logs. Load `RESEND_API_KEY`, `ACCOUNT_EMAIL_FROM`, and the encryption key in the worker. Keep public web startup independent of mail availability.

- [ ] **Step 4: Re-run focused tests.**

Run: `corepack pnpm test:unit -- apps/worker/src/account-mail.test.ts`
Run: `corepack pnpm test:integration -- tests/integration/repositories.test.ts`
Expected: PASS; repeated dispatch sends identical ciphertext-derived message and idempotency key.

- [ ] **Step 5: Commit.**

```sh
git add apps/worker packages/database/src/postgres-repositories.ts tests/integration/repositories.test.ts .env.example
git commit -m "feat(accounts): deliver recovery mail from durable outbox"
```

### Task 4: Make account status and admin mutations atomic

**Files:**

- Modify: `packages/database/src/postgres-repositories.ts`
- Test: `tests/integration/repositories.test.ts`
- Modify: `scripts/operators.mts`
- Modify: `scripts/operators.test.mts`

**Interfaces:**

- Produces `accountAuth.provisionAdmin({canonicalEmail, email, passwordHash, passwordSalt, scryptVersion, scryptCost, at}): Promise<Account>`.
- Produces `accountAuth.setRole({actorId, targetId, role, at}): Promise<"updated"|"last_admin"|"forbidden"|"missing">`.
- Produces `accountAuth.setActive({actorId, targetId, active, at}): Promise<"updated"|"last_admin"|"forbidden"|"missing">` and `accountAuth.requirePasswordChange({actorId, targetId, at}): Promise<boolean>`.
- Produces `accountAuth.listAccounts(actorId): Promise<readonly AccountSummary[]>` without hashes or keys.

- [ ] **Step 1: Write failing tests for bootstrap, role/status transitions, and the last-admin race.**

```ts
const admin = await provisionAdmin({
  email: "owner@example.com",
  passwordHash: hash
});
expect(admin).toMatchObject({
  role: "admin",
  verifiedAt: expect.any(Date),
  passwordChangeRequired: true
});
const results = await Promise.all([demote(adminA.id), demote(adminB.id)]);
expect(results).toContain("last_admin");
expect(await activeAdminCount()).toBe(1);
await requirePasswordChange({ actorId: admin.id, targetId: user.id, at });
expect(await useOldSession(user.id)).toBeNull();
```

- [ ] **Step 2: Prove the repository and CLI tests fail.**

Run: `corepack pnpm test:integration -- tests/integration/repositories.test.ts`
Run: `corepack pnpm test:unit -- scripts/operators.test.mts`
Expected: FAIL because the account operations do not exist.

- [ ] **Step 3: Implement transactional account changes and bootstrap CLI.**

```sql
BEGIN;
SELECT id FROM accounts WHERE role = 'admin' AND active FOR UPDATE;
SELECT count(*) FROM accounts WHERE role = 'admin' AND active;
UPDATE accounts SET role = $3, updated_at = $4 WHERE id = $2;
UPDATE account_sessions SET revoked_at = $4 WHERE account_id = $2 AND revoked_at IS NULL;
COMMIT;
```

Check the actor's live admin state inside the transaction, including self-demotion. Keep status/role/reset audit events free of secrets. The CLI accepts `provision-admin <email>`, prompts for the temporary password through the existing hidden TTY path, and creates a verified admin with `passwordChangeRequired=true`. Do not accept a password on argv or in environment variables.

- [ ] **Step 4: Re-run the focused tests.**

Run: `corepack pnpm test:integration -- tests/integration/repositories.test.ts`
Run: `corepack pnpm test:unit -- scripts/operators.test.mts`
Expected: PASS; simultaneous demotions leave one active admin.

- [ ] **Step 5: Commit.**

```sh
git add packages/database/src/postgres-repositories.ts tests/integration/repositories.test.ts scripts/operators.mts scripts/operators.test.mts
git commit -m "feat(accounts): administer roles and bootstrap first admin"
```

### Task 5: Verify email, recover passwords, and change addresses

**Files:**

- Create: `apps/web/src/server/account-tokens.ts`
- Create: `apps/web/src/server/account-tokens.test.ts`
- Modify: `packages/database/src/postgres-repositories.ts`
- Test: `tests/integration/repositories.test.ts`

**Interfaces:**

- Produces `accountTokens.issueVerification(accountId, at): Promise<void>`, `confirmVerification(token, password, at): Promise<"verified"|"invalid">`.
- Produces `accountTokens.requestReset(email, at): Promise<void>`, `completeReset(token, newPassword, at): Promise<"changed"|"invalid">`.
- Produces `accountTokens.requestEmailChange(accountId, password, newEmail, at): Promise<void>` and `confirmEmailChange(token, at): Promise<"pending"|"changed"|"invalid">`.
- Consumes Task 3's atomic token/outbox issue method and Task 2's email normalization.

- [ ] **Step 1: Write failing tests for token expiry, replay, pending-account recovery, and both email approvals.**

```ts
expect(await confirmVerification(linkToken, wrongPassword, at)).toBe("invalid");
expect(await confirmVerification(linkToken, registrationPassword, at)).toBe(
  "verified"
);
expect(await confirmVerification(linkToken, registrationPassword, at)).toBe(
  "invalid"
);
expect(await completeReset(resetToken, newPassword, after30Minutes)).toBe(
  "invalid"
);
expect(await confirmEmailChange(newAddressToken, at)).toBe("pending");
expect(await confirmEmailChange(oldAddressToken, at)).toBe("changed");
```

- [ ] **Step 2: Prove focused tests fail.**

Run: `corepack pnpm test:unit -- apps/web/src/server/account-tokens.test.ts`
Run: `corepack pnpm test:integration -- tests/integration/repositories.test.ts`
Expected: FAIL because token operations are absent.

- [ ] **Step 3: Implement token state transitions in repository transactions.**

```ts
const token = randomBytes(32).toString("base64url");
const digest = createHmac("sha256", tokenHashSecret)
  .update(purpose)
  .update("\0")
  .update(token)
  .digest("hex");
const consumed = await repository.consumeToken({ digest, purpose, at });
if (!consumed) return "invalid";
```

Use 24-hour verification and email-change expiry, 30-minute reset expiry, and generic request responses for unknown, disabled, or existing addresses. A successful reset on an unverified account marks it verified. Reset and email change increment credential version and revoke all sessions in the same transaction. A second request creates a new token rather than changing an existing outbox message.

- [ ] **Step 4: Re-run focused tests.**

Run: `corepack pnpm test:unit -- apps/web/src/server/account-tokens.test.ts`
Run: `corepack pnpm test:integration -- tests/integration/repositories.test.ts`
Expected: PASS; token replay and one-sided email changes do not succeed.

- [ ] **Step 5: Commit.**

```sh
git add apps/web/src/server/account-tokens* packages/database/src/postgres-repositories.ts tests/integration/repositories.test.ts
git commit -m "feat(accounts): verify addresses and recover passwords"
```

### Task 6: Extend the single authentication and session boundary

**Files:**

- Modify: `apps/web/src/server/operator-auth.ts` (rename to `account-auth.ts` if imports can be migrated in the same commit)
- Modify: `apps/web/src/server/operator-auth.test.ts`
- Modify: `apps/web/src/server/operator-auth-test-fixture.ts`
- Modify: `apps/web/src/server/container.ts`
- Modify: `apps/web/src/server/config.ts`
- Modify: `apps/web/src/server/config.test.ts`

**Interfaces:**

- Produces `AccountPrincipal = {kind:"account";accountId:string;email:string;role:"user"|"admin";passwordChangeRequired:boolean} | {kind:"automation"}`.
- Produces `accountAuth.authenticate(request): Promise<{principal:AccountPrincipal|null;cookie?:CookieDirective}>`, `signIn(request)`, `signOut(request)`, and `changePassword(request)`.
- Consumes Task 4's account repository and Task 5's token service.

- [ ] **Step 1: Write failing tests for verified login, forced change, role changes, and Bearer precedence.**

```ts
expect((await auth.signIn(emailPasswordRequest)).principal).toMatchObject({
  role: "user"
});
expect((await auth.signIn(unverifiedRequest)).principal).toBeNull();
expect((await auth.authenticate(forcedChangeCookie)).principal).toMatchObject({
  passwordChangeRequired: true
});
expect(
  authorizes((await auth.authenticate(forcedChangeCookie)).principal, "admin")
).toBe(false);
expect(
  (await auth.authenticate(invalidBearerWithValidCookie)).principal
).toBeNull();
```

- [ ] **Step 2: Prove the auth tests fail.**

Run: `corepack pnpm test:unit -- apps/web/src/server/operator-auth.test.ts`
Expected: FAIL on email and role behavior.

- [ ] **Step 3: Extend the auth service and container.**

```ts
type RequiredRole = "account" | "admin";
function authorizes(
  principal: AccountPrincipal | null,
  required: RequiredRole
): boolean {
  return (
    principal?.kind === "account" &&
    !principal.passwordChangeRequired &&
    (required === "account" || principal.role === "admin")
  );
}
```

Keep the existing opaque `__Host-` cookie attributes, idle/absolute expiry, atomic use-session query, generic failures, exact-origin mutation checks, and login throttle. Session use must read current active/verified/role/password-change state. A forced-change session may call only own-session, change-password, and sign-out routes; all other account/admin APIs reject it. Valid bearer automation remains available only where explicitly supported.

- [ ] **Step 4: Re-run auth and config tests.**

Run: `corepack pnpm test:unit -- apps/web/src/server/operator-auth.test.ts apps/web/src/server/config.test.ts`
Expected: PASS, including disabled and stale-session rejection.

- [ ] **Step 5: Commit.**

```sh
git add apps/web/src/server
git commit -m "feat(accounts): authenticate email accounts and forced changes"
```

### Task 7: Expose account lifecycle routes and accessible pages

**Files:**

- Create: `apps/web/src/app/api/account/register/route.ts`
- Create: `apps/web/src/app/api/account/verify/route.ts`
- Create: `apps/web/src/app/api/account/verification-resend/route.ts`
- Create: `apps/web/src/app/api/account/recovery/route.ts`
- Create: `apps/web/src/app/api/account/password/route.ts`
- Create: `apps/web/src/app/api/account/email/route.ts`
- Create: `apps/web/src/app/api/account/session/route.ts`
- Modify: `apps/web/src/app/api/operations/session/route.ts`
- Modify: `apps/web/src/app/api/operations/session/logout/route.ts`
- Modify: `apps/web/src/app/operations/login/page.tsx`
- Modify: `apps/web/src/app/operations/login/operator-login-form.tsx`
- Create: `apps/web/src/app/account/page.tsx`
- Create: `apps/web/src/app/account/create/page.tsx`
- Create: `apps/web/src/app/account/verify/page.tsx`
- Create: `apps/web/src/app/account/recover/page.tsx`
- Create: `apps/web/src/app/account/reset/page.tsx`
- Create: `apps/web/src/app/account/change-password/page.tsx`
- Modify: `apps/web/src/components/site-header.tsx`
- Test: `apps/web/src/app/api/account/account-routes.test.ts`
- Test: `apps/web/src/components/site-header.test.tsx`

**Interfaces:**

- JSON routes consume Task 6's auth and Task 5's token service; mutation routes accept same-origin bounded JSON only.
- Header consumes a safe own-session projection with email, role, and required-change state, not a browser-stored role.

- [ ] **Step 1: Write failing route and UI tests.**

```ts
expect((await POST(registerRequest)).status).toBe(202);
expect(await responseText(existingEmailRequest)).toBe(
  await responseText(newEmailRequest)
);
expect(screen.getByRole("link", { name: "Create account" })).toBeVisible();
expect(screen.getByRole("link", { name: "Sign in" })).toBeVisible();
expect(screen.queryByRole("link", { name: "Admin settings" })).toBeNull();
```

- [ ] **Step 2: Prove tests fail.**

Run: `corepack pnpm test:unit -- apps/web/src/app/api/account/account-routes.test.ts apps/web/src/components/site-header.test.tsx`
Expected: FAIL because routes and controls are missing.

- [ ] **Step 3: Implement routes and forms.**

```tsx
<label htmlFor="account-email">Email address</label>
<input id="account-email" type="email" autoComplete="email" required />
<p role="status" tabIndex={-1} ref={statusRef}>{feedback}</p>
```

Use visible registration, sign-in, verification resend, recovery, reset, password-change, and own-account controls. Clear password state before awaiting requests; move focus to status/error headings. Keep verification/recovery tokens out of logs and request tracing. The own-session endpoint gives the header a safe account projection for authorized admin links; sign-out clears transient client secret fields. Preserve public page navigation.

- [ ] **Step 4: Re-run route and UI tests.**

Run: `corepack pnpm test:unit -- apps/web/src/app/api/account/account-routes.test.ts apps/web/src/components/site-header.test.tsx`
Expected: PASS, including keyboard submission and focus on feedback.

- [ ] **Step 5: Commit.**

```sh
git add apps/web/src/app/api/account apps/web/src/app/account apps/web/src/app/api/operations/session apps/web/src/app/operations/login apps/web/src/components/site-header*
git commit -m "feat(accounts): add public account flows and navigation"
```

### Task 8: Guard admin management and collection monitoring

**Files:**

- Create: `apps/web/src/app/admin/settings/page.tsx`
- Create: `apps/web/src/app/admin/settings/admin-account-client.tsx`
- Create: `apps/web/src/app/api/admin/accounts/route.ts`
- Create: `apps/web/src/app/api/admin/accounts/[accountId]/route.ts`
- Modify: `apps/web/src/app/operations/collection-monitor/page.tsx`
- Modify: `apps/web/src/app/api/operations/collection-monitor/route.ts`
- Modify: `apps/web/src/proxy.ts`
- Test: `apps/web/src/app/api/admin/accounts/route.test.ts`
- Test: `apps/web/src/app/api/operations/collection-monitor/route.test.ts`
- Test: `apps/web/src/app/admin/settings/page.test.tsx`

**Interfaces:**

- Consumes Task 4's `listAccounts`, `setRole`, `setActive`, and `requirePasswordChange`.
- Consumes Task 6's live `authorizes(principal, "admin")` predicate and bearer principal.
- Produces admin list and mutation endpoints returning only safe account summaries.

- [ ] **Step 1: Write failing page/API tests for user denial, admin actions, last-admin protection, and bearer monitor access.**

```ts
expect((await adminAccountsGET(userCookie)).status).toBe(403);
expect((await monitorGET(userCookie)).status).toBe(403);
expect((await monitorGET(automationBearer)).status).toBe(200);
expect((await adminAccountsGET(adminCookie)).status).toBe(200);
expect((await demoteLastAdmin(adminCookie)).status).toBe(409);
expect(await monitorPageDataReadsForUser()).toBe(0);
```

- [ ] **Step 2: Prove tests fail.**

Run: `corepack pnpm test:unit -- apps/web/src/app/api/admin/accounts/route.test.ts apps/web/src/app/api/operations/collection-monitor/route.test.ts apps/web/src/app/admin/settings/page.test.tsx`
Expected: FAIL because admin boundaries are absent.

- [ ] **Step 3: Implement server checks before data reads and accessible controls.**

```ts
const authentication = await accountAuth.authenticate(request);
if (!authorizes(authentication.principal, "admin"))
  return Response.json({ error: "forbidden" }, { status: 403 });
const accounts = await accountAdmin.listAccounts(
  authentication.principal.accountId
);
return Response.json(accounts, { headers: { "cache-control": "no-store" } });
```

Allow `BOT_API_KEY` only in the monitor API, not admin settings. Recheck role in the page after proxy enforcement. Show account status and role, never keys or password hashes. Mutation buttons announce results, require clear confirmation for disabling or role changes, and handle last-admin conflict without losing focus.

- [ ] **Step 4: Re-run admin/monitor tests.**

Run: `corepack pnpm test:unit -- apps/web/src/app/api/admin/accounts/route.test.ts apps/web/src/app/api/operations/collection-monitor/route.test.ts apps/web/src/app/admin/settings/page.test.tsx`
Expected: PASS; denied requests never read account or monitor data.

- [ ] **Step 5: Commit.**

```sh
git add apps/web/src/app/admin apps/web/src/app/api/admin apps/web/src/app/operations/collection-monitor apps/web/src/app/api/operations/collection-monitor apps/web/src/proxy.ts
git commit -m "feat(accounts): restrict administration and monitoring"
```

### Task 9: Persist and manage account API credentials

**Files:**

- Create: `apps/web/src/server/account-credentials.ts`
- Create: `apps/web/src/server/account-credentials.test.ts`
- Modify: `apps/web/src/server/config.ts`
- Modify: `apps/web/src/server/config.test.ts`
- Modify: `packages/database/src/postgres-repositories.ts`
- Create: `apps/web/src/app/api/account/credentials/route.ts`
- Create: `apps/web/src/app/api/account/credentials/route.test.ts`
- Modify: `apps/web/src/app/settings/page.tsx`
- Modify: `apps/web/src/app/settings/page.test.tsx`
- Modify: `apps/web/src/lib/api-credentials.ts`

**Interfaces:**

- Produces `accountCredentials.summary(accountId): Promise<ProviderPresence[]>`.
- Produces `accountCredentials.replace(accountId, provider, values, expectedVersion?): Promise<"saved"|"conflict">` and `remove(accountId, provider): Promise<void>`.
- Produces `accountCredentials.resolve(accountId, provider): Promise<{values:ProviderCredentials;version:number}|null>` only for server callers.

- [ ] **Step 1: Write failing tests for encryption, isolation, metadata-only responses, and explicit import.**

```ts
await replace(alice.id, "warcraftlogs", {
  clientId: "id-a",
  clientSecret: "secret-a"
});
expect(await rawCredentialColumn(alice.id, "warcraftlogs")).not.toContain(
  "secret-a"
);
expect(await summaryFor(bob.id)).toEqual([]);
expect(JSON.stringify(await credentialsGET(aliceCookie))).not.toContain(
  "secret-a"
);
expect(await importIntoOccupiedSlotWithoutReplace(aliceCookie)).toBe(
  "conflict"
);
```

- [ ] **Step 2: Prove focused tests fail.**

Run: `corepack pnpm test:unit -- apps/web/src/server/account-credentials.test.ts apps/web/src/app/api/account/credentials/route.test.ts apps/web/src/app/settings/page.test.tsx`
Run: `corepack pnpm test:integration -- tests/integration/repositories.test.ts`
Expected: FAIL because account credential methods and controls are absent.

- [ ] **Step 3: Implement per-provider encrypted writes and signed-in settings.**

```ts
const encrypted = encryptCredential(
  JSON.stringify(values),
  accountCredentialEncryptionKey
);
await repository.replace({
  accountId,
  provider,
  encrypted,
  expectedVersion,
  at
});
return { provider, present: true, updatedAt: at, version };
```

Load and validate `ACCOUNT_CREDENTIAL_ENCRYPTION_KEY` as a distinct 32-byte value in the web config. Reject partial Blizzard/Warcraft Logs pairs. Never return `encrypted` or plaintext from an HTTP response, list, logger, or client bundle. GET returns presence/version/timestamps. PUT requires complete values and an explicit `replace` boolean for occupied slots; DELETE clears one slot and increments its version. The signed-in settings page detects browser copies and lets the user import each provider, with explicit replacement choice for occupied slots; clear each local provider only after server success. The signed-out page retains browser storage behavior.

- [ ] **Step 4: Re-run credential tests.**

Run: `corepack pnpm test:unit -- apps/web/src/server/account-credentials.test.ts apps/web/src/server/config.test.ts apps/web/src/app/api/account/credentials/route.test.ts apps/web/src/app/settings/page.test.tsx`
Run: `corepack pnpm test:integration -- tests/integration/repositories.test.ts`
Expected: PASS; account responses contain no secrets and import does not silently replace.

- [ ] **Step 5: Commit.**

```sh
git add apps/web/src/server/account-credentials* apps/web/src/server/config* apps/web/src/app/api/account/credentials apps/web/src/app/settings packages/database/src/postgres-repositories.ts tests/integration/repositories.test.ts apps/web/src/lib/api-credentials.ts
git commit -m "feat(accounts): store and manage encrypted provider keys"
```

### Task 10: Resolve keys on requests and preserve shared evidence runs

**Files:**

- Modify: `apps/web/src/server/credential-headers.ts`
- Modify: `apps/web/src/server/credential-headers.test.ts`
- Modify: `apps/web/src/app/api/dossiers/route.ts`
- Modify: `apps/web/src/app/api/dossiers/[region]/[realm]/[name]/route.ts`
- Modify: `apps/web/src/app/api/dossiers/[region]/[realm]/[name]/refresh/route.ts`
- Modify: `apps/web/src/app/api/warcraft-logs/characters/[characterId]/route.ts`
- Modify: `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.tsx`
- Modify: `packages/application/src/applicant-dossier-service.ts`
- Modify: `packages/application/src/applicant-evidence-job-handler.ts`
- Modify: `packages/database/src/postgres-repositories.ts`
- Modify: `apps/worker/src/runtime.ts`
- Test: `apps/web/src/app/api/dossiers/api-contract.test.ts`
- Test: `packages/application/src/applicant-evidence-job-handler.test.ts`
- Test: `tests/integration/repositories.test.ts`

**Interfaces:**

- Produces `resolveCredentialOverrides(request, principal, accountCredentials, config): Promise<DossierGatewayOverrides>`.
- Produces `EvidenceRepository.reserve` accepting either signed-out encrypted WCL snapshot or `{accountId, credentialVersion}`.
- Worker consumes `accountCredentials.resolve(accountId, "warcraftlogs")` and validates the reserved version before gateway construction.

- [ ] **Step 1: Write failing tests for account-key resolution, account switching, version mismatch, and different-key join.**

```ts
expect(
  (await resolveOverrides(aliceCookie, staleBobHeaders)).wclCredentials
    ?.clientSecret
).toBe("alice-key");
expect(
  (await resolveOverrides(bobCookie, staleAliceHeaders)).wclCredentials
    ?.clientSecret
).not.toBe("alice-key");
const first = await reserveEvidence(character, aliceKeyRef);
const joined = await reserveEvidence(character, bobKeyRef);
expect(joined.kind).toBe("active");
expect(joined.run.id).toBe(first.run.id);
expect(await workerKey(joined.run)).toBe("alice-key");
await replaceAliceKey();
expect(await workerKey(joined.run)).toBe("shared");
```

- [ ] **Step 2: Prove tests fail.**

Run: `corepack pnpm test:unit -- apps/web/src/server/credential-headers.test.ts apps/web/src/app/api/dossiers/api-contract.test.ts packages/application/src/applicant-evidence-job-handler.test.ts`
Run: `corepack pnpm test:integration -- tests/integration/repositories.test.ts`
Expected: FAIL because signed-in references and server resolution are absent.

- [ ] **Step 3: Thread server-only account keys through reads and reservations.**

```ts
const saved =
  principal?.kind === "account"
    ? await accountCredentials.resolve(principal.accountId, "warcraftlogs")
    : null;
const anonymous =
  principal === null
    ? readCredentialOverrides(request.headers, config).wclCredentials
    : null;
const reservationKey =
  principal?.kind === "account" && saved
    ? { accountId: principal.accountId, credentialVersion: saved.version }
    : null;
```

Apply this to the dossier start and read routes, character-ID resolution, and dossier refresh; inspect the tier-search and connected-character routes for credential-bearing calls and thread the same resolver where needed. Signed-in browser fetches omit credential headers. Preserve signed-out header behavior. A new account-owned run stores only owner/version; at worker start require active owner and matching key version or fall back to the shared gateway. The reservation transaction keeps the existing per-character active-run check before insert; joining caller credentials never update an existing run. Do not expose run owner or key metadata in public responses.

- [ ] **Step 4: Re-run focused and regression tests.**

Run: `corepack pnpm test:unit -- apps/web/src/server/credential-headers.test.ts apps/web/src/app/api/dossiers/api-contract.test.ts packages/application/src/applicant-evidence-job-handler.test.ts`
Run: `corepack pnpm test:integration -- tests/integration/repositories.test.ts`
Expected: PASS, including first-run credential ownership and account switching.

- [ ] **Step 5: Commit.**

```sh
git add apps/web/src/server/credential-headers* apps/web/src/app/api/dossiers apps/web/src/app/api/warcraft-logs apps/web/src/app/dossiers packages/application/src/applicant-dossier-service.ts packages/application/src/applicant-evidence-job-handler* packages/database/src/postgres-repositories.ts apps/worker/src/runtime.ts tests/integration/repositories.test.ts
git commit -m "feat(accounts): resolve saved keys in collection paths"
```

### Task 11: Complete browser coverage, deployment guidance, and PR verification

**Files:**

- Create: `tests/e2e/accounts.spec.ts`
- Modify: `tests/e2e/support/seed.ts`
- Modify: `README.md`
- Modify: `.env.example`
- Create: `docs/operations/accounts.md`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**

- Consumes Tasks 1–10; produces a deployable account feature with documented Resend configuration and first-admin bootstrap.

- [ ] **Step 1: Add browser tests for anonymous access, account lifecycle, admin denial, key import, and keyboard focus.**

```ts
test("anonymous visitor can still search and open a dossier", async ({
  page
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Create account" })
  ).toBeVisible();
  await page
    .getByLabel("Character/URL")
    .fill("https://raider.io/characters/eu/silvermoon/Ryii");
  await page.getByRole("button", { name: "Research applicant" }).click();
  await expect(page).toHaveURL(/dossiers/);
});
test("ordinary user cannot open admin settings or monitor", async ({
  page
}) => {
  await signInAsUser(page);
  await page.goto("/admin/settings");
  await expect(
    page.getByRole("heading", { name: /forbidden|sign in/i })
  ).toBeVisible();
});
```

- [ ] **Step 2: Prove the new browser tests fail before final wiring.**

Run: `corepack pnpm playwright test tests/e2e/accounts.spec.ts`
Expected: FAIL on missing fixture wiring or UI behavior, then fix the concrete failures in the owning tasks.

- [ ] **Step 3: Document the rollout and refine UI styles.**

```sh
corepack pnpm ops:operators -- provision-admin owner@example.com
```

Document that migration deletes old operator identities/sessions, preserves public data and bearer automation, and requires a new temporary CLI password and first-login change. Document Resend verified-domain setup, `RESEND_API_KEY`, `ACCOUNT_EMAIL_FROM`, account encryption key sharing between web/worker, and the no-mail impact limited to account features. Ensure responsive styles and visible focus indicators.

- [ ] **Step 4: Run the full repository gate and record exact results.**

Run sequentially: `corepack pnpm format:check`, `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test:unit`, `corepack pnpm test:integration`, `corepack pnpm build`, `corepack pnpm playwright test`.
Expected: all PASS. Diagnose and repair any concrete failure, then rerun the affected gate and the full gate as needed.

- [ ] **Step 5: Commit, review, and open the PR.**

```sh
git add tests/e2e README.md .env.example docs/operations apps/web/src/app/globals.css
git commit -m "test(accounts): verify flows and document deployment"
git push -u origin codex/issue-443
gh pr create --repo Erilla/SlashWho --base main --head codex/issue-443 --title "Add optional accounts and saved API keys" --body-file pr-body.md
```

Write `pr-body.md` with the issue link, the account wipe and bootstrap procedure, Resend settings, test results, and remaining deployment actions before invoking `gh pr create`. Attach the PR to this task. Do not merge or enable auto-merge.
