# Operator user system design

## Goal

Replace browser use of the shared `BOT_API_KEY` with accountable, revocable
operator identities while retaining that Bearer credential for automation.

## Scope and non-goals

This is an operator-only system with one `operator` role. It has no public
registration, password reset, social login, applicant accounts, profile
surface, or general account-management web UI. Its principal/role shape is a
seam for a later, separately designed audience; it is not permission to add
one here.

`BOT_API_KEY` remains a machine credential. It must never be entered into the
browser login flow after this change, and no credential may appear in URLs,
logs, route responses, client bundles, local storage, command arguments, or
environment-variable output.

## Operator lifecycle and accountability

Persist `operators` with a stable UUID, unique canonical login, display login,
scrypt password hash, unique random salt, scrypt algorithm version and cost
parameters, `active` state, credential version, and timestamps. Login
canonicalization is deliberately narrow: accept a bounded ASCII login form and
store ASCII lowercase. Do not introduce Unicode normalization or a
confusable-name policy accidentally. Credentials are high-entropy secrets of
at least 20 characters, supplied through a hidden terminal prompt and stored
only as a salted scrypt hash. Stored parameters permit a later safe cost
upgrade without retaining a reusable credential.

Provide an interactive local `ops:operators` command with `provision`,
`rotate`, `disable`, and `list` subcommands. It requires ordinary database
connection privilege and accepts neither passwords nor tokens in an argument,
URL, or environment variable. `provision` creates the first and subsequent
identities; `rotate` replaces a credential and increments its credential
version; `disable` prevents future sign-ins. Rotation and disablement revoke
every active session for the affected operator in the same transaction. There
is no bootstrap browser account and no self-service recovery flow.

Persist an append-only `operator_auth_events` record for provision, rotation,
disablement, sign-in success, sign-in failure, sign-out, and session
revocation. An event contains only nullable operator ID, an authored action,
an authored outcome, and timestamp. An unknown-login failure has no operator
ID; a terminal-administration event identifies the affected operator because
the local command has no separate in-product administrator identity. Events
never contain a credential, hash, salt, cookie, session secret, raw IP, URL,
or request body.

## Browser sessions

Persist `operator_sessions` with opaque session ID, HMAC digest of a
cryptographically random browser secret, operator ID, credential version,
`issued_at`, `last_used_at`, `idle_expires_at`, `absolute_expires_at`, and
nullable `revoked_at`. The cookie holds only
`v1.<session-id>.<random-secret>`; it contains no login, role, password,
signed claims, or bearer key. The server looks up the session and compares its
secret digest in constant time.

Use a `__Host-slashwho-operator` cookie with `Path=/`, `HttpOnly`, `Secure`,
`SameSite=Strict`, and `Cache-Control: no-store`, with 30-minute idle lifetime
and eight-hour absolute lifetime. A valid use extends only the idle deadline,
bounded by the absolute deadline. Cookie `Max-Age` and `Expires` equal the
remaining server-authorized lifetime; browser expiry is convenience and the
database is authoritative.

One conditional database update atomically verifies active operator state,
matching credential version, non-revocation, and both expiry deadlines before
recording `last_used_at` and the bounded new idle deadline. Missing, malformed,
expired, revoked, credential-version-mismatched, or disabled sessions are
denied and their cookie is expired. `OPERATOR_SESSION_HASH_SECRET` HMACs
session secrets; rotating it safely invalidates all sessions without changing
operator credentials.

Sign-out revokes exactly the presented session before expiring the cookie.
Sign-in rotates any prior cookie rather than reusing it. Login throttling
stores only an HMAC, using `RATE_LIMIT_HASH_SECRET`, of canonical login plus
Railway's trusted `X-Real-IP`. If that header is unavailable it uses a
separately bounded global HMAC bucket, never a spoofable forwarded-IP header.
Every unknown, disabled, throttled, or incorrect identity receives the same
generic failure.

## Authentication and authorization seam

Replace `isOperatorRequest` with one deep server module. Its interface is
conceptually:

```ts
type OperatorPrincipal =
  | { kind: "automation" }
  | { kind: "operator"; operatorId: string; login: string; role: "operator" };

type OperatorAuthentication = {
  principal: OperatorPrincipal | null;
  cookie?: CookieDirective;
};

authenticateOperator(request: Request): Promise<OperatorAuthentication>;
signIn(request: Request): Promise<OperatorAuthentication>;
signOut(request: Request): Promise<{ cookie: CookieDirective }>;
```

This module owns header precedence, bearer validation, cookie parsing, session
lookup, digest comparison, expiry, revocation, disabled-user checks, cookie
renewal/clearing, exact-origin and Fetch-Metadata validation, throttling, and
audit events. A route only passes the request and translates the module result
to HTTP status, headers, and response.

When `Authorization` is supplied, validate it as Bearer automation; an invalid
value fails closed and never falls back to a cookie. With no authorization
header, try the browser session. Routes and pages consume the principal, never
a raw cookie or session query. The collection-monitor page and API cross this
seam before loading monitor data; the API continues to admit valid Bearer
automation and browser callers get an identifiable operator principal.

## Web flow and CSRF controls

`/operations/login` asks for login and credential, clears the credential from
component state before awaiting a JSON sign-in response, and on success follows
the hardened cookie to the monitor. Failures display only “Authentication
failed.” The monitor redirects unauthenticated browser visitors to login.

Session mutation endpoints accept only JSON POST operations (including a
POST-based sign-out action), require `Origin` to exactly equal the required
configured `OPERATOR_ORIGIN`, and require `Sec-Fetch-Site: same-origin`.
Missing or mismatched checks are rejected. The sign-out control invokes the
dedicated sign-out operation, which revokes the current session and returns to
login.

Remove #382's BOT-key browser login and signed-session implementation. The new
session route explicitly expires any old `__Host-slashwho-operator` cookie.
Local and E2E configuration must exercise production cookie attributes rather
than weakening `Secure` or `__Host-` rules; browser tests run over HTTPS or
assert route headers directly.

## Persistence and operations

The database module owns two repository adapters: operator lookup/credential
mutation for the local command, and session issue/conditional-use/revoke for
the web authentication module. Protected application services never receive
password hashes or raw session tokens. Migrations add only operator,
operator-session, login-throttle, and operator-auth-event tables plus indexes
for canonical-login, live-session, throttle-window, audit reading, and expiry
cleanup. A bounded cleanup deletes only expired/revoked sessions and expired
throttle rows; operator and lifecycle-event records remain accountability
anchors.

Deployment documentation and `.env.example` add
`OPERATOR_SESSION_HASH_SECRET` and `OPERATOR_ORIGIN`. The former is a web
secret distinct from `BOT_API_KEY` and `RATE_LIMIT_HASH_SECRET`; the latter is
the exact public HTTPS origin accepted by browser session routes.

## Verification

Unit and integration coverage proves salted credentials do not retain raw
secrets; canonical ASCII logins reject invalid forms; lifecycle commands mutate
the intended identity and append safe events; cookies are opaque and hardened;
a single conditional update enforces active state, credential version,
revocation, idle expiry, and absolute expiry; and cookie expiry equals the
authorized remaining lifetime. It also proves sign-out, rotation, disablement,
and global session-secret rotation revoke access; malformed, tampered, and
duplicated cookies fail closed; invalid Bearer precedence is preserved; and no
rejected request reads monitor data.

Route/UI tests cover generic failures, successful sign-in, sign-out, exact
Origin and Fetch-Metadata rejection, per-subject and global throttles, no
credential reflection, old-cookie invalidation, and production-strength cookie
attributes in local/E2E tests. The existing Bearer monitor flow remains
covered.

The full repository gate remains required before any pull request. A pull
request, if later authorized, remains held for manager review: do not enable
auto-merge or merge it.
