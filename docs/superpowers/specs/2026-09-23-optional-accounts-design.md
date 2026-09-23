# Optional accounts, saved API keys, and administration

## Intent and scope

SlashWho remains usable without an account. Search, applicant dossiers, evidence
collection, existing controls, and their rate limits and allowance rules keep
their present behavior for signed-out visitors and ordinary account holders.
Accounts add durable personal API credentials and recovery. The only new role
boundary protects admin settings and the collection monitor, including their
APIs. Valid `BOT_API_KEY` automation retains its existing monitor API access.
There are no paid, operator, or other product-access tiers.

## Identity and account lifecycle

Extend the current operator account, session, throttle, and audit repository
boundary into one account system. A principal is an automation caller or an
account with an `id`, normalized email, and `user` or `admin` role. Continue
using opaque, revocable, HttpOnly `__Host-` cookies, exact-origin and Fetch
Metadata checks on mutations, constant-time credential verification, generic
sign-in failures, and hashed login-throttle subjects. Server authorization
loads current account state on every protected request; role and status never
come from a browser claim.

Use a bounded email address as the sole sign-in name. Trim surrounding space,
validate one conventional mailbox address, lowercase the entire address with
ASCII-only case folding, and store it in a unique canonical column. Use the
same canonicalization for registration, sign-in, recovery, and email change.
Passwords use the existing versioned salted scrypt storage and must meet the
existing 20-character minimum. New registrations have the `user` role and
start unverified. Send a single-use verification link; activation requires
both that link and the password chosen at registration, so a mailbox owner
cannot accidentally activate a pending account created by someone else. The
account may sign in only after verification. This affects account features
only; public features remain available without signing in. Verification
tokens expire after 24 hours. Registration admits at most five requests per
hour per trusted client
IP and 100 per hour globally; if the trusted IP is unavailable, a separate
global fallback bucket admits at most ten per hour. A canonical-address HMAC
bucket admits at most three outbound verification messages per day. These
limits apply before an account row or outbound message is created.
Registration returns the same accepted response for a valid address whether
it is new or already registered, without revealing account status. An
existing verified address gets no new mail. Unverified registrations and their
unused tokens expire and are deleted after seven days unless verified. A valid
recovery link to an unverified account sets a new password and verifies the address, allowing
the mailbox owner to reclaim a pending registration. Resend and password-reset
requests are separately throttled. Failed email delivery leaves the account
unverified and exposes a retry action without logging the token or address.

Use Resend for transactional email through a small server-only mail adapter.
`RESEND_API_KEY` and `ACCOUNT_EMAIL_FROM` are deployment secrets/settings;
the sender must belong to a verified sending domain. Links use the configured
exact public origin and are constructed on the server. In one database
transaction, each mail request stores a digest-only single-use token record
and an outbox row containing the encrypted message and one stable idempotency
key. The worker decrypts and sends that row through Resend, then marks it sent.
An uncertain response or crash after send retries the same encrypted message,
token, and idempotency key with bounded backoff; it never creates a fresh token
on retry. A duplicate delivery may show the same link twice but cannot create
two valid tokens. Once the token expires, the worker discards the outbox
payload. A fresh user request issues a new token and outbox row subject to the
same abuse limits. Token digests remain the only token material in the token
table; the outbox ciphertext uses an independently derived encryption key and
is deleted after delivery or expiry. Neither token nor ciphertext is logged.
Tests inject a fake adapter and simulate uncertain sends and worker crashes;
no test sends live mail. Account registration and recovery fail clearly if
account email configuration is missing; existing public request handling
remains available when mail delivery fails.

Password recovery always gives a generic acknowledgement, including unknown,
disabled, and unverified addresses. It may send a reset link to an unverified
account so the mailbox owner can reclaim it. A reset token is random, stored
only as a digest, single-use, and valid for 30 minutes. Completing a reset
changes the password, consumes all outstanding reset tokens, clears any required-change
flag, increments the credential version, and revokes all sessions atomically.
Signed-in password change requires the current password and has the same
session effects, followed by a fresh sign-in. An account marked as requiring
a password change may sign in with its current password, but its session can
reach only the password-change, sign-out, and own-session endpoints. The
password-change page focuses the new-password field and explains the required
step. Successful change clears the flag and requires a fresh sign-in. Public
features remain available without account authorization. Account holders may
request an email change after entering their password. The current address
must approve the change and the new address must confirm it using separate
24-hour single-use links. Only after both proofs does the new address become
the login; completion revokes existing sessions. Admins cannot initiate or
choose another account's destination email. A user without access to the
current mailbox cannot change email through this flow.

The current operator records have no email addresses. As explicitly requested,
the deployment migration deletes those legacy operator accounts and their
sessions. Existing authentication events retain their action and timestamp
but have their former operator reference cleared before account deletion;
login-attempt rows may be cleared. It does not delete public search, dossier,
or evidence data, and `BOT_API_KEY` remains valid. A revised
interactive CLI provisions the first admin using an email address and a hidden
temporary-password prompt; it creates an already verified admin marked as
requiring a password change. The new admin signs in with that temporary
password, changes it, then signs in again before admin access is granted.
The web registration path can never create an admin. Deploy the migration and
bootstrap command as one operational rollout; until bootstrap, public features
continue to work and no admin page is accessible. Document the destructive account reset and
bootstrap sequence in deployment guidance.

## Pages and administration

The global header shows visible **Sign in** and **Create account** links when
signed out. When signed in, it shows an account menu with email, key settings,
password/email change, and sign-out. The menu shows **Admin settings** and
**Collection monitor** only to admins. Existing `/settings` remains the
public API-key page; use a separate `/admin/settings` route for account
administration. Sign-in, registration, verification, recovery, and account
pages provide validation, success/error feedback, accessible labels, keyboard
operation, and focus management after navigation and errors.

Admin settings lists email, role, verification and active status, and creation
date; it never displays password material or API keys. Admins may change
`user`/`admin` roles, disable or reactivate accounts, and require a password
change. Requiring a password change revokes existing sessions immediately;
the user signs in with their current password or follows the ordinary emailed
recovery flow if it is lost. Admins
cannot set or see another account's password through the web UI. There is no
account deletion or arbitrary profile editing.
The repository performs admin mutations in transactions, immediately revokes
sessions after role or status change, prevents self-promotion, and prevents
demotion or disablement of the last active admin. Disabling an account blocks
sign-in, recovery completion, saved-key use, and existing sessions. The admin
page and all admin APIs check the current admin role server-side. The monitor
page and API do the same, with the existing bearer automation exception for
the API. Unauthorized requests cannot read monitor or account data.

## Saved API credentials

Store separate encrypted credential records for Blizzard's client pair,
Raider.IO's access key, and Warcraft Logs' client pair, owned by account ID.
Use authenticated encryption with a distinct 32-byte
`ACCOUNT_CREDENTIAL_ENCRYPTION_KEY`, shared by web and worker where account
credentials are resolved. Keep key version, timestamps, and presence metadata.
The account API returns only presence and timestamps; it never returns saved
secrets. Write endpoints accept complete provider values to add or replace,
and a provider-specific delete. They require an authenticated account and
the same mutation-origin protections as session endpoints. Mutations are
audited without secret contents and increment the provider credential version.

Signed-in dossier and provider requests resolve that account's current
credentials on the server when creating new work. They do not send saved
secrets back to the browser or persist them in browser storage. If a provider
has no saved credential, use
the existing shared/anonymous upstream path. Signed-out requests retain the
current browser-storage and per-request header flow. A signed-in request
ignores any stale browser credential headers, so switching accounts cannot
reuse another account's keys.

On first sign-in, the settings page detects existing browser credentials and
offers an explicit import. It shows provider-by-provider occupancy without
revealing account secrets. Empty account slots may be imported; replacing an
occupied slot requires a separate explicit choice. The server performs each
import through the ordinary encrypted write endpoint. Only after a successful
import does the browser remove that provider's local copy. Cancel leaves both
copies untouched. The signed-in settings form accepts replacement values but
never pre-fills or returns stored secrets. Sign-out clears any transient form
state and subsequent requests no longer resolve the old account.

Existing signed-out Warcraft Logs evidence jobs keep their current encrypted
credential snapshot behavior. Signed-in jobs instead record the originating
account ID and provider credential version, never an account-key snapshot.
At worker start, resolve the credential only if the account remains active
and that version still matches. If it was replaced or removed, run with the
existing shared credential and allowance policy. A job already executing may
finish with the credential it resolved at start. Signing out does not cancel
work already accepted for that account, but a new session or another account
cannot inherit its credential. This preserves account isolation without
changing public allowance rules.

Evidence runs are shared per character, as in the existing reservation code.
The first request that reserves a run fixes its credential and allowance
source. If account B later requests the same character while account A's run
is active, B joins that run and receives the same public result; B's different
Warcraft Logs key does not replace A's key or start another job. B never
receives A's key or account identity. If A's key is replaced or removed before
the worker starts, the run falls back to the shared credential rather than to
B's key. A run already started may finish on A's allowance. The UI describes
the run as already in progress without claiming it used B's credentials.

## Verification and release

Repository and integration tests cover unique normalized email, registration
limits and generic responses, unverified-account expiry and recovery, durable
outbox retries, two-address email-change approval, legacy account reset,
first-admin bootstrap and forced password change, last-admin protection,
token expiry and single use, session revocation, encrypted key storage,
account isolation, versioned queued work, shared runs with different caller
keys, and safe audit/response projections. Route tests cover
registration, sign-in, verification, recovery, account mutations, admin and
monitor API denial, bearer automation, and unchanged anonymous operations.
UI tests cover visible account controls, import/replace/remove choices,
feedback, keyboard use, and focus. Run the full repository gate from README:
format check, lint, typecheck, unit tests, integration tests, build, and
Playwright tests. Open a PR with results and do not merge it.
