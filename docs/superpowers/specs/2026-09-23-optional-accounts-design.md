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
start unverified. Send a single-use verification link; the account may sign in
only after verification. This affects account features only; public features
remain available without signing in. Verification tokens expire after 24
hours. Resend and password-reset requests are throttled, and token digests,
not tokens, are stored. Failed email delivery leaves the account unverified
and exposes a retry action without logging the token or address.

Use Resend for transactional email through a small server-only mail adapter.
`RESEND_API_KEY` and `ACCOUNT_EMAIL_FROM` are deployment secrets/settings;
the sender must belong to a verified sending domain. Links use the configured
exact public origin and are constructed on the server. The adapter sends
verification, email-change, and reset messages and uses stable per-message
idempotency keys for retries. Tests inject a fake adapter; no test sends live
mail. Account registration and recovery fail clearly if account email
configuration is missing; existing public request handling remains available
when mail delivery fails.

Password recovery always gives a generic acknowledgement, including unknown,
disabled, and unverified addresses. A reset token is random, stored only as a
digest, single-use, and valid for 30 minutes. Completing a reset changes the
password, consumes all outstanding reset tokens, increments the credential
version, and revokes all sessions atomically. Signed-in password change
requires the current password and has the same session effects, followed by
a fresh sign-in. Account holders may request an email change after entering
their password; the new address becomes the login only after confirmation
through a 24-hour single-use link sent to that address. Confirmation revokes
existing sessions. Admins may initiate the same pending verified email-change
flow for an account; they cannot silently replace its login address.

The current operator records have no email addresses. As explicitly requested,
the deployment migration deletes those legacy operator accounts and their
sessions. Existing authentication events retain their action and timestamp
but have their former operator reference cleared before account deletion;
login-attempt rows may be cleared. It does not delete public search, dossier,
or evidence data, and `BOT_API_KEY` remains valid. A revised
interactive CLI provisions the first admin using an email address and a hidden
password prompt; it creates an already verified admin. The web registration
path can never create an admin. Deploy the migration and bootstrap command as
one operational rollout; until bootstrap, public features continue to work
and no admin page is accessible. Document the destructive account reset and
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
`user`/`admin` roles, disable or reactivate accounts, and initiate a verified
email change. There is no account deletion or arbitrary profile editing.
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
credentials on the server. They do not send saved secrets back to the browser
or persist them in browser storage. If a provider has no saved credential, use
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

## Verification and release

Repository and integration tests cover unique normalized email, legacy
account reset, first-admin bootstrap, last-admin protection, token expiry and
single use, session revocation, encrypted key storage, account isolation,
versioned queued work, and safe audit/response projections. Route tests cover
registration, sign-in, verification, recovery, account mutations, admin and
monitor API denial, bearer automation, and unchanged anonymous operations.
UI tests cover visible account controls, import/replace/remove choices,
feedback, keyboard use, and focus. Run the full repository gate from README:
format check, lint, typecheck, unit tests, integration tests, build, and
Playwright tests. Open a PR with results and do not merge it.
