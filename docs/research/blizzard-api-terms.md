# Blizzard API terms and rate limits for public account inference

Research note for GitHub issue #5 (`wayfinder:research`).

**Question.** Do Battle.net's current API terms of use permit a public website that infers and
publishes account-level linkage between World of Warcraft characters — stating publicly that
these characters share an owner, derived from account-wide achievement completion timestamps?
Also: current documented rate limits, their enforcement scope, whether a higher tier exists, and
any restriction on caching, storing or redistributing the achievement data the fingerprint
depends on.

**Researched:** 6 August 2026. All primary citations were retrieved live on that date; where a
document states its own "last updated" date, that is recorded alongside.

**Scope note.** This note deliberately separates three questions that are easy to blur:

- **(a) Access** — what the terms permit for *calling* the API.
- **(b) Storage** — what they permit for *caching and retaining* the data.
- **(c) Publication of derived inference** — what they permit for *publishing conclusions about
  players* drawn from the data. This is the novel risk, and the one the ticket exists for.

---

## Primary source inventory

| Document | URL | Stated date | Retrieved |
| --- | --- | --- | --- |
| Blizzard Developer API Terms of Use | <https://www.blizzard.com/en-us/legal/a2989b50-5f16-43b1-abec-2ae17cc09dd6/blizzard-developer-api-terms-of-use> | Last updated 1 October 2019 | 2026-08-06 |
| Blizzard developer portal — Getting Started guide | <https://community.developer.battle.net/documentation/guides/getting-started> (`develop.battle.net` 301-redirects here) | none shown on page | 2026-08-06 |
| Blizzard developer portal — WoW Profile APIs | <https://community.developer.battle.net/documentation/world-of-warcraft/profile-apis> | none shown on page | 2026-08-06 |
| Blizzard developer portal — Using OAuth guide | <https://community.developer.battle.net/documentation/guides/using-oauth> | none shown on page | 2026-08-06 |
| API Discussion forum — "Request Rate Limit increase?" (**Blizzard staff**, Maguthul) | <https://us.forums.blizzard.com/en/blizzard/t/request-rate-limit-increase/12158> | 30 September 2020 | 2026-08-06 |
| API Discussion forum — "Data Protection Notice and FAQ" (**Blizzard staff**, Veltarii) | <https://us.forums.blizzard.com/en/blizzard/t/data-protection-notice-and-faq/609> | 19 September 2019 | 2026-08-06 |
| API Discussion forum — rate-limit scope threads (**community MVP, secondary**) | [14354](https://us.forums.blizzard.com/en/blizzard/t/are-api-limits-tied-to-application-key-or-user-token/14354), [5602](https://us.forums.blizzard.com/en/blizzard/t/api-access-clients-rate-limits/5602) | 2020–2026 | 2026-08-06 |
| Blizzard Entertainment Online Privacy Policy | <https://www.blizzard.com/en-us/legal/a4380ee5-5c8d-4e3b-83b7-ea26d01a9918/blizzard-entertainment-online-privacy-policy> | Last updated 27 June 2025 | 2026-08-06 |
| Support — "Enabling / Disabling Sharing Game Data With Developers" | <https://us.support.blizzard.com/en/article/375447> | Updated 5 May 2026 | 2026-08-06 |
| Support — "404 Error When a Community App Tries to Access My Battle.net Data" | <https://us.support.blizzard.com/en/article/257277> | Updated 5 February 2026 | 2026-08-06 |

The controlling document is the **Blizzard Developer API Terms of Use** ("the ToU"). It is a
single agreement accepted at the point of registering an OAuth client, and it is the document
that binds SlashWho. Notably it is still dated **1 October 2019** — it has not been revised since
the GDPR/CCPA-driven overhaul of that year, so nothing in it was written with inference-style
applications in mind. There is no other developer policy document; see §2.4.

**Two retrieval caveats, both of which affected the findings.**

1. The developer portal has moved: `develop.battle.net` 301-redirects to
   `community.developer.battle.net`, and the new portal is a JavaScript single-page app that
   returns an empty shell to plain fetches. Blizzard's legal index at `blizzard.com/en-gb/legal/`
   and the support site are likewise JS-gated. Support article text and dates below were read
   from Blizzard's own first-party JSON endpoint
   (`us.support.blizzard.com/services/bft/api/article/en/{id}`). Portal documentation quotes were
   obtained through a text proxy — the words are Blizzard's, but **confirm the exact phrasing in
   a browser before relying on any portal quote verbatim.**
2. Blizzard's forum renders author badges client-side, so a Blizzard employee and a community
   volunteer look identical in a scraped page. Every forum citation here was checked against the
   Discourse JSON API for a `staff` flag; see the attribution table in §2.3. This check changed
   the status of the most widely repeated rate-limit "answer" on the internet.

---

## 1. Access — what the terms permit for calling the API

### 1.1 The licence is narrow, revocable, and tied to a registered application

> "Subject to Your compliance with these API Terms of Use, Blizzard grants You a limited,
> non-exclusive, non-assignable, non-sublicensable, non-transferable, revocable right and license
> for You to (1) use the API Key solely to access the Blizzard Developer APIs, (2) implement the
> Blizzard Developer APIs, solely as permitted hereunder, in conjunction with Your client
> libraries, desktop applications, services and daemons such as websites and web services,
> scripts and applications and/or utilities that You register when You request an API Key
> ("Application(s)"), and (3) distribute the Data to end users for their personal use via Your
> Application. You may not use the API Key or the Data for any Applications that have not been
> registered with Blizzard or for any purpose not expressly authorized hereunder."
>
> — ToU §2, "API And Data License"

A public website is expressly a contemplated form of Application.

Registration is mandatory and compels a **declaration of purpose**, which is the practical choke
point for this feature:

> "In the Intended Use field, specify how you intend to use this client. For example, your client
> will provide players information about their World of Warcraft characters or your client will
> display information about Hearthstone cards."
>
> — <https://community.developer.battle.net/documentation/guides/getting-started>, retrieved 2026-08-06

Note the example Blizzard chose: "information about **their** World of Warcraft characters". Also
a hard gate on the account itself:

> "Next, attach a Battle.net Authenticator to your account. Two-factor authentication is required
> for any API usage"
>
> — same URL and date

The Intended Use field means we cannot proceed without telling Blizzard, in writing, what we are
building. That is a feature, not an obstacle: it converts the ambiguity in §4 into a question
Blizzard has to look at, and it makes "register first, ask later" a bad idea (see §5).

### 1.2 The purpose limitation: "benefit the Blizzard player community"

> "Blizzard and You agree that you are a Service Provider pursuant to the California Consumer
> Privacy Act ("CCPA"). Your use of the Data is restricted to developing Applications that
> benefit the Blizzard player community and You agree not to distribute Data outside of your
> authorized Applications and not do anything that would change your status under the CCPA from
> being a Service Provider to being a Purchaser of the Blizzard Data."
>
> — ToU §2, "Applications must benefit the Blizzard player community"

This is the single most load-bearing clause for our use case and it is **not** self-interpreting.
"Benefit the Blizzard player community" has no definition in the document. An application whose
purpose is to defeat a player's deliberate choice to keep their alts unlinked is not obviously
within it, and Blizzard reserves sole discretion elsewhere (§1.4, §1.5) to decide such questions.

### 1.3 No charging, no monetisation, no ads targeted from the Data

> "'Premium' versions of Applications offering additional for-pay features are not permitted, nor
> can players be charged money to download an Application, charged for services related to the
> Application, or otherwise be required to offer some form of monetary compensation to download
> or access an Application when those features use the Blizzard Developer APIs. Likewise,
> Applications may not include interstitials soliciting donations before features or
> functionality becomes available to the player. Also, players may not be required to watch a
> video advertisement before accessing a feature or function of the application."
>
> — ToU §2, "Applications May Not Charge Premiums To Use The APIs"

> "You may not use the Blizzard Developer APIs or Data to market or promote Your or a third
> party's products or services. You may not display, distribute, or otherwise disclose the Data
> in any advertising or promotion or use the Data to target any advertising or promotion. You may
> not sell, license or otherwise transfer any Data (including anonymous, aggregate or derived
> data) to any ad network, data broker or other advertising or monetization-related service."
>
> — ToU §2, "You May Not Use The Blizzard Developer APIs Or Data For Marketing Or Monetization Purposes"

Note the parenthetical: **"including anonymous, aggregate or derived data"**. Blizzard's drafters
did contemplate derived data, and where they did, they treated it as still covered by the
restriction. That reading matters in §3 below.

### 1.4 "Must not negatively impact ... Blizzard's players"

> "Applications must perform no function which, in Blizzard's sole discretion, negatively impacts
> Blizzard, the performance of Blizzard's games or services, or otherwise negatively affects
> Blizzard's players and/or customers, compromises the integrity of any Blizzard game or
> services, or creates an unfair advantage for players."
>
> — ToU §2, "Applications Must Not Negatively Impact Blizzard, Blizzard's Games, Services, or Customers"

"Negatively affects Blizzard's players" is decided **in Blizzard's sole discretion**, not on an
objective standard. See §3.1.

### 1.5 Attribution and branding

> "You shall clearly and conspicuously identify Blizzard in Your Application as the source of the
> Data, and You shall do it in such a way which makes it not appear that Blizzard is endorsing or
> affiliated with Your Application. Additionally, Your Application shall not contain any of
> Blizzard's trademarks as a part of its title or URL."
>
> — ToU §2, "Blizzard Is The Source Of The Data, But Does Not Endorse Applications"

Actionable: source attribution must appear on pages showing Blizzard-derived data, and the domain
must not contain a Blizzard mark. "SlashWho" and `slashwho.*` are clear on the latter.

### 1.6 No scraping outside the API

> "Except as permitted through authorized use of the Blizzard Developer APIs, You will not
> perform any data-mining, scraping, crawling, or use any processes that sends automated queries
> to Blizzard or any Blizzard game, service, or website, or use any other similar methods or
> tools to gather or extract data other information from Blizzard or any Blizzard game or
> service."
>
> — ToU §2, "You May Not Data Mine Blizzard Products Or Services"

Relevant if we were ever tempted to fall back to the WoW Armory web pages. We must not.

### 1.7 Mandatory privacy policy

> "You must post a privacy policy governing the use of the Data, which shall be consistent with
> Blizzard's privacy policy ... (ii) You shall not collect, use, store or disclose any player's
> personal information or data in any manner that violates applicable laws, rules or regulations.
> If You do collect, use or store any player's personal information, You must inform them of such
> use and that it is subject to Your privacy policy ..."
>
> — ToU §2, "You Must Have A Privacy Policy"

SlashWho would need a published privacy policy before it may use the API at all. This is a
concrete, non-optional prerequisite that does not exist today.

### 1.8 Security and breach notification

> "You must use appropriate technical and organizational security measures to prevent
> unauthorized access or disclosure of the Data. If You determine or have reason to believe that
> the Data has been accessed, disclosed or otherwise leaked to any unauthorized party, You must
> immediately notify Blizzard within 24 hours ..."
>
> — ToU §2, "You Must Protect The Data"

### 1.9 Indemnity

> "You agree to hold harmless and indemnify Blizzard, and its subsidiaries, affiliates, officers,
> agents, and employees from and against any third party claim arising from or in any way related
> to Your or Your users' use of Your Application, the Blizzard Developer APIs and/or Data, Your
> breach of these API Terms of Use ... including any liability or expense arising from claims,
> losses, damages, suits, judgments, litigation costs and attorneys' fees, of every kind and
> nature."
>
> — ToU §6, "Indemnity"

Uncapped, and it reaches third-party claims. If a player sued over a published linkage, the
operator carries Blizzard's costs too. For a hobby project run by an individual this is the
sharpest tail risk in the document.

### 1.10 Termination at will

> "Blizzard may change, suspend or discontinue the Blizzard Developer API and suspend or
> terminate Your use of the Blizzard Developer API, Data and/or Developer Site at any time for
> any reason, without notice. If Blizzard suspends or terminates Your use of the Blizzard
> Developer API, Data and/or Developer Site, you must immediately cease using the Blizzard
> Developer API and Data from Your Application, and delete all copies of the Data in your
> possession or under your control."
>
> — ToU §11, "Termination"

There is no appeal, no notice period, and no grandfathering. Any architecture built on the
fingerprint must be able to lose its Blizzard input overnight and degrade rather than break.

---

## 2. Rate limits

### 2.1 The limit stated in the terms themselves

> "You are limited to thirty-six thousand (36,000) calls to the Blizzard Developer API per hour
> or such other limitation as Blizzard may deem appropriate. If You exceed this limitation or
> otherwise operate the Application in a manner that degrades the performance of the Blizzard
> Developer APIs, Blizzard, or Blizzard's games or services, Blizzard may suspend or terminate
> Your access to the Blizzard Developer APIs. You may not use other third-party services to make
> additional requests on Your behalf."
>
> — ToU §2, "You May Not Use The Blizzard Developer APIs Excessively"
> (<https://www.blizzard.com/en-us/legal/a2989b50-5f16-43b1-abec-2ae17cc09dd6/blizzard-developer-api-terms-of-use>,
> last updated 1 October 2019, retrieved 2026-08-06)

Two things to note. First, "36,000 per hour" is a **contractual** limit, not merely a technical
one — exceeding it is a breach, with suspension or termination as the stated remedy. Second, the
final sentence — "You may not use other third-party services to make additional requests on Your
behalf" — forecloses the obvious workaround of fanning requests out across proxies or borrowing
another project's quota.

### 2.2 The limit stated in the developer documentation

**Portal move.** `develop.battle.net` now 301-redirects to `community.developer.battle.net`
(confirmed 2026-08-06). The new portal is an Angular single-page app, so its documentation pages
do not render for plain HTTP fetches; the quotes below were obtained by rendering the first-party
URL through a text proxy. The words are Blizzard's, but **they were not read from a directly
rendered browser view — confirm the exact phrasing in a browser before relying on it verbatim.**

> "API clients are limited to 36,000 requests per hour at a rate of 100 requests per second."
>
> — <https://community.developer.battle.net/documentation/guides/getting-started>, retrieved
> 2026-08-06. **The page carries no published or last-updated date.**

There is no dedicated rate-limits guide page; getting-started is the canonical location. The two
figures are not equivalent: 100/sec sustained would be 360,000/hour, so the hourly quota binds
first, at an average of **10 requests per second**.

Throttling behaviour, same page and retrieval date:

> "Exceeding the hourly quota results in slower service until traffic decreases."

> "Exceeding the per-second limit results in a 429 error for the remainder of the second until
> the quota refreshes."

Two different behaviours: the hourly breach degrades service silently; the per-second breach
returns HTTP 429 for the balance of that second. The documentation says **nothing** about a
`Retry-After` header, any `X-RateLimit-*` response headers, a quota-introspection endpoint, or a
ban policy. A client must track its own budget.

### 2.3 Enforcement scope: undocumented, and the popular answer is not Blizzard's

**The documentation does not say.** "API clients are limited to…" is never defined against client
id, application, token, or IP. The docs are silent, and this is a gap worth noting.

**A note on forum attribution.** Blizzard's Discourse forum renders author badges client-side, so
a casual read cannot distinguish a Blizzard employee from a community MVP — and the two most
frequently cited "answers" on rate limits come from an MVP, not from Blizzard. Every forum
citation in this note was checked against the Discourse JSON API
(`https://us.forums.blizzard.com/en/blizzard/t/{id}.json`), which exposes a per-post `staff`
boolean and `user_title`. Verified 2026-08-06:

| Account | `staff` | `user_title` | Status |
| --- | --- | --- | --- |
| Veltarii-1769 | `true` | Blizzard Developer | **First-party** |
| Maguthul-11152 | `true` | Blizzard Developer | **First-party** |
| Araspir | `true` | Blizzard Developer | **First-party** |
| Schiller-1822 | `false` | MVP | Community volunteer — **secondary** |
| Ulminia-1676 | `false` | MVP | Community volunteer — **secondary** |

Anyone revisiting this should re-run that check rather than trusting a rendered page.

**The one genuine first-party statement on scope** does not answer the client/application/IP
question head-on, but it does establish the anti-circumvention rule:

> "In regards to multiple API clients, we do not allow consumers to register multiple API clients
> simply to bypass rate limiting restrictions. However, where we do permit multiple API clients is
> when each client is used to consume data from a specific 'region'."
>
> — Maguthul-11152 (**Blizzard**, `staff: true`, "Blizzard Developer"), 30 September 2020,
> <https://us.forums.blizzard.com/en/blizzard/t/request-rate-limit-increase/12158>, retrieved 2026-08-06

The questioner there was the operator of dataforazeroth.com, a large public WoW data site, asking
directly for an increase after a traffic spike. That is the closest analogue to SlashWho's
situation on the public record.

**SECONDARY — community MVP, widely repeated but not Blizzard's word.** The commonly cited
"per application" answer is from an MVP and was never confirmed by staff:

> "Limits are applied per application."
>
> — Schiller-1822 (**community MVP**, `staff: false`), 5 January 2021,
> <https://us.forums.blizzard.com/en/blizzard/t/are-api-limits-tied-to-application-key-or-user-token/14354>,
> retrieved 2026-08-06

> "You may create one pair of client credentials per application/website, and yes, each will have
> 36k request limit."
>
> — Schiller-1822 (**community MVP**, `staff: false`), 13 April 2020,
> <https://us.forums.blizzard.com/en/blizzard/t/api-access-clients-rate-limits/5602>, retrieved 2026-08-06

**Where that leaves us.** The working assumption — one client per application, 36,000/hour, with
per-region clients as the only sanctioned multiplier — is consistent with the ToU's own "You may
not use other third-party services to make additional requests on Your behalf" (§2.1) and with
Maguthul's staff post. But the precise unit of enforcement rests on community testimony, so it
belongs on the list of things to confirm with Blizzard rather than to design around.

Not answered anywhere, first-party or otherwise: whether enforcement additionally keys on
originating IP. A community question on exactly that point (edissone-2722, 4 January 2026, thread
5602) drew no staff reply, only an MVP's warning that reusing multiple clients risks a lockout.
Treat IP-scoping as unknown — it matters if SlashWho ever runs multiple Railway replicas behind
one client id.

### 2.4 Higher tier

**None is documented.** There is no published elevated tier, partner programme, commercial
agreement, or rate-limit-increase request form on the developer portal. In the one thread where a
sizeable public WoW site asked for an increase, the Blizzard staff answer offered regional client
splitting instead of a raised limit and named no escalation route (thread 12158, above). Plan on
36,000/hour/application being the ceiling, with no negotiated relief available.

Relatedly, there is **no separate developer policy document to find**. Beyond the API Terms of
Use there is no "API Policy", "Developer Acceptable Use Policy", or attribution/branding policy
linked anywhere from the portal, whose only navigation items are API Access, Documentation and
Forums. (The "Custom Game Acceptable Use Policy" on blizzard.com/legal governs in-game
Arcade/Workshop custom games, not the web APIs.) The attribution requirement in §1.5 is the
entire attribution policy.

### 2.5 Budget implications for SlashWho

- **Headroom is ample at current scale.** Tens to low hundreds of searches a day sits far inside
  36,000/hour, even at several calls per character.
- **The binding constraint is not search traffic, it is the §3.1 revalidation duty.** Every stored
  character must be re-checked at least every 30 days — a background cost proportional to the
  whole corpus and growing with it, unlike search traffic. The good news is that the Character
  Profile Status endpoint (§3.1) makes this **one cheap call per character per 30 days**, so
  36,000/hour supports a very large corpus on revalidation alone. The cost that actually bites is
  re-deriving fingerprints for characters whose status call comes back valid but whose achievement
  data has changed.
- **Per-character cost is high.** The modern API is granular; a character achievements fetch is a
  separate sub-resource call from the character summary. Community commentary (SECONDARY —
  Ulminia-1676, non-staff, 2 September 2022,
  <https://us.forums.blizzard.com/en/blizzard/t/lets-talk-throttling/32429>, no staff reply)
  observes that work which once took one call now takes nine or more, while the documented quota
  has not moved. Budget per logical operation, not per HTTP call.
- **Auth mechanics.** Client-credentials flow against `https://oauth.battle.net/token`; "Access
  tokens last for 24 hours" (`expires_in: 86399`), so cache the token. Whether token requests
  themselves count against the quota is **not documented**. Two-factor authentication is
  mandatory on the Battle.net account.
- **Endpoint access level.** Character achievement data is addressed by realm slug and character
  name and is available under **client credentials** — no per-player OAuth consent is required.
  Only endpoints keyed on "the current logged-in user" (`/profile/user/wow`, protected character
  profile, account collections) need the `wow.profile` scope via authorization-code flow.
  (<https://community.developer.battle.net/documentation/world-of-warcraft/profile-apis>,
  retrieved 2026-08-06.)

  This last point is worth dwelling on for the ethics ticket: **the fingerprint works without the
  player's consent precisely because Blizzard exposes achievement timestamps publicly.** The
  absence of a consent gate is a technical fact, not a permission.

### 2.6 Secondary sources — labelled

All community, none substituting for a documented figure:

- **SECONDARY** — thread 5602 (2020–2026): community understanding that each client credential
  pair gets an independent 36k/hour, with peer warnings that running several clients for one
  application risks a lockout. Note the community says "per client" where the MVP answer says
  "per application" — and neither is Blizzard's word. The only staff statement on the subject is
  Maguthul's anti-circumvention rule, which closes the loophole without defining the unit.
- **SECONDARY** — thread 300 (2019, non-staff): "The only rate limit response you'll get as far
  as I know is the HTTP 429 code when you reach the limit." Corroborates the documentation's
  silence on rate-limit headers.
- **HISTORICAL, does not apply** — a 2013 Blizzard post describing a credit-based system of
  roughly 3,000 requests/day. That is the retired pre-OAuth Community API and contradicts current
  documentation. Recorded only so it is not mistaken for current guidance.

---

## 3. Storage — caching, retention, redistribution

### 3.1 A hard 30-day time-to-live on all API data

This is the clause with the largest architectural consequence for SlashWho, and it is
unambiguous.

> "Data protection laws in Europe, the United States and other countries give players the right
> to withdraw from the Data set you will be using. You must implement a maximum 30-day TTL
> (time-to-live) policy for all Data obtained through our APIs. This means You will retain data
> pulled from Blizzard Developer APIs for no longer than 30 days. If You are a World of Warcraft
> specific API developer, You have the option to perform the Data refresh by validating through
> an API if a character ID still exists on the Blizzard side. If it doesn't exist when hitting
> this API, the character is invalid, and You must delete the character information associated
> with that ID and not display that information."
>
> — ToU §2, "You must refresh your data no less frequently than every thirty (30) days"

Corroborated by Blizzard staff on the official API forum:

> "You will need to start refreshing player data no less frequently than every 30 days, as it
> could belong to a user who has asked for their data to be made private or erased."
>
> — Veltarii (Blizzard), "Data Protection Notice and FAQ", 19 September 2019,
> <https://us.forums.blizzard.com/en/blizzard/t/data-protection-notice-and-faq/609>, retrieved 2026-08-06

> "In order to ensure full compliance with the new policy, developers should delete the data if
> you receive a 404 – Not Found error."
>
> — same thread

And, critically for anyone hoping to keep a reduced form of the data indefinitely, anonymisation
is explicitly rejected as a substitute for deletion:

> "Because there's no defined threshold of anonymity, we don't want to take the chance. We want
> all our players and developers to be as protected as possible."
>
> — same thread

The API documentation operationalises this through a dedicated endpoint, and spells out the exact
loop expected of us:

> "Returns the status and a unique ID for a character. A client should delete information about a
> character from their application if any of the following conditions occur: an HTTP 404 Not
> Found error is returned; the is_valid value is false; the returned character ID doesn't match
> the previously recorded value for the character."

> "A client requests and stores information about a character, including its unique character ID
> and the timestamp of the request. After 30 days, the client makes a request to the status
> endpoint to verify if the character information is still valid. If character cannot be found,
> is not valid, or the characters IDs do not match, the client removes the information from their
> application. If the character is valid and the character IDs match, the client retains the data
> for another 30 days."
>
> — Character Profile Status, WoW Profile APIs reference,
> <https://community.developer.battle.net/documentation/world-of-warcraft/profile-apis>,
> retrieved 2026-08-06 (no version date shown on page)

This is good news for the request budget: revalidation costs **one** status call per character per
30 days, not a full re-fetch. It is the cheapest possible form of the obligation. Note the third
condition — a changed character ID also forces deletion, and Blizzard staff confirmed in 2019 that
"unique character IDs do not persist across server transfers", so a transferred character's stored
fingerprint must be discarded, not migrated.

**Consequence for SlashWho.** The ticket's context describes "permanent, crawlable public
character pages". Permanent retention of Blizzard-sourced achievement timestamps is directly
prohibited. Either every character record is re-validated against the API at least every 30 days
— which turns a one-off fingerprint into a permanent recurring request budget across the whole
corpus, not just newly searched characters — or the record is deleted. There is no third option;
"we hashed the timestamps so it isn't really the data any more" is precluded by the anonymisation
answer above.

Note also the carve-out in the staff FAQ, which does *not* help us:

> "Historical data such as leaderboards and guilds, are deemed as public data, and therefore will
> not be deleted if/when a player has invoked the 'Right of Erasure'."
>
> — same thread

Leaderboards and guild rosters are named. Per-character achievement completion timestamps are
not; they are character profile data, which the FAQ places on the 30-day validation side.

### 3.2 No sale, licensing, or transfer of the Data

> "The Data is for Your use to enhance the experience of the players of Blizzard's games and You
> are not allowed to sell, license or otherwise transfer the Data to any third party."
>
> — ToU §2, "You May Not Sell Or License The Data To Any Party"

Read alongside §2's "not to distribute Data outside of your authorized Applications" (§1.2). A
public **read API** offered by SlashWho is worth thinking about carefully here: SlashWho already
exposes an API, and serving Blizzard-derived fields out of it to arbitrary third-party callers is
closer to "distribute Data outside of your authorized Applications" than to "distribute the Data
to end users for their personal use via Your Application" (the licence grant in §2). The licence
grant does permit distribution to end users for personal use; it is the machine-readable bulk
path that is the grey area.

### 3.3 Data must remain dynamic and deletable

> "The Data should be dynamically available to the public and should not be integrated into any
> physical product. Doing so could prevent or hinder the deletion of the Data, should Blizzard or
> a user so request."
>
> — ToU §2, "You May Not Integrate The Data Into A Physical Product"

The stated rationale — that nothing may be done which "could prevent or hinder the deletion of
the Data" — is a general principle, even though the clause is aimed at physical products. Search
engine indexing and third-party caching of permanent public linkage pages hinders deletion in
exactly this sense. That is not a prohibition on its own terms, but it shows the drafters'
direction of travel.

### 3.4 Per-individual erasure obligation

> "If any individual requests that you cease using their Data, either by making a request to You
> directly, making a request through Blizzard, or requesting that their account be de-linked from
> Your Application, you must immediately cease using the Blizzard Developer API and Data from
> Your Application, and delete all copies of the individual's Data in your possession or under
> your control."
>
> — ToU §11, "Termination"

SlashWho must therefore operate a removal channel that accepts requests **directly from players**
and **relayed from Blizzard**, and must honour them immediately. The repo already has
`docs/operations/removals.md`; that process would need to be extended to cover Blizzard-sourced
data and to meet an "immediately" standard rather than a best-effort one.

An open drafting question: the clause says delete "all copies of the individual's Data". A
published statement that character A and character B share an owner is not literally a copy of
any Data field, but it exists only because of that Data. Deleting the timestamps while leaving
the published linkage standing would defeat the clause's evident purpose. In practice a removal
must take down the inference too.

---

## 4. Publication of derived inferences — the novel risk

Nothing in the ToU addresses inference about players in so many words. There is no clause saying
"you may publish conclusions derived from the Data" and no clause saying "you may not". The
question is therefore decided by four clauses that were written for other purposes, plus one
absence.

### 4.1 The privacy clause is the closest thing to a direct prohibition

> "Applications may not be associated with nor contain any content that is unlawful, tortious,
> defamatory, obscene, **invasive of the privacy of another person**, threatening, harassing,
> abusive, hateful, racist or otherwise objectionable or inappropriate, **as determined by
> Blizzard in Blizzard's sole discretion**."
>
> — ToU §2, "Applications May Not Contain Offensive Material" (emphasis added)

This is the operative provision. Three observations:

1. It is a **content** standard, and the published linkage is content the Application contains.
2. "Invasive of the privacy of another person" is a plausible characterisation of publishing that
   two characters share an owner where the owner has taken steps to prevent that being known. It
   is not the only plausible characterisation — one can argue the underlying achievement
   timestamps are already public through Blizzard's own API and the inference merely joins public
   facts — but the clause does not turn on whether the inputs were public.
3. The determination is **Blizzard's alone, at its sole discretion**. There is no objective test
   we can satisfy in advance and no standard we can hold them to afterwards. This is what makes
   the position ambiguous rather than merely risky: we cannot resolve it by careful reading,
   because the terms assign the reading to someone else.

### 4.2 "Negatively affects Blizzard's players", also sole discretion

§1.4 above. A player who deliberately hid an alt link, and finds it published anyway, is a player
negatively affected. Whether Blizzard would take that view is again theirs to decide.

### 4.3 Derived data is still within scope where the terms mention it

The monetisation clause (§1.3) restricts transfer of Data "**including anonymous, aggregate or
derived data**". The IP clause reinforces that we own nothing downstream of the Data:

> "Except to the extent of any license granted herein by Blizzard to You, these API Terms of Use
> do not grant to You any right, title, or interest in any intellectual property owned or
> licensed by Blizzard, including but not limited to the Blizzard APIs, the Developer Site, the
> Data nor any derivatives of them."
>
> — ToU §9, "Intellectual Property"

So the fingerprint output is a derivative of the Data in which SlashWho holds no rights, and
which Blizzard may require to be deleted. It cannot be treated as "our own data" that survives
termination or an erasure request.

### 4.4 Blizzard's own licence back over what we build

> "You grant Blizzard a non-exclusive, perpetual, royalty-free right and license to use the
> Application and to distribute and publicly display it and the Data compiled and arranged by it.
> You also grant Blizzard the right to monitor or collect data related to Your use of the
> Blizzard Developer API to ensure Your compliance with these API Terms of Use ..."
>
> — ToU §3, "Your License To Blizzard"

Not a constraint on us, but worth knowing: Blizzard may inspect our usage, and could build the
same feature itself (§9) without that being a breach of anything.

### 4.5 What the terms are silent on

Silence is a finding, so it is recorded plainly. The ToU says **nothing** about:

- Inferring relationships between characters, accounts, or players.
- Cross-referencing data across characters at all.
- Publishing analysis, statistics, rankings, or conclusions drawn from the Data (as distinct from
  redistributing the Data itself).
- Opt-out for players who do not want to appear in an Application, other than the erasure
  obligation in §11. (Blizzard's Privacy Policy does provide an upstream opt-out — see §4.6 —
  but the ToU itself says nothing about honouring per-application objections beyond §11.)
- Whether an account-wide achievement timestamp is treated as "personal information".
- Robots/indexing of pages built from the Data.
- **Whether a derived artefact is itself "Data".** The ToU defines Data as what you *retrieve*
  from the APIs, and never says whether a stored edge asserting "A and B share an account" — which
  holds no retrieved field — falls inside the definition, and therefore inside the 30-day TTL and
  the erasure duty. This is the most consequential silence in the document.
- **Derivative works generally.** There is no general derivative-works clause. The phrase
  "anonymous, aggregate or derived data" appears exactly once in the entire ToU, confined to the
  ad-network/data-broker transfer ban (§1.3). Blizzard's drafters thought about derived data in
  one narrow place and nowhere else.
- **Database rights.** No sui generis database right clause and no EU Database Directive
  reference. The IP clause is drafted around the *APIs* ("any modifications to or derivatives of
  the Blizzard Developer APIs"); its reach over a third-party-built inference graph is unresolved.
- Bulk export of our own derived output by our own users.
- Named prohibited application categories — no "no alt-tracking", no "no player-lookup". Every
  restriction of that kind is routed through a sole-discretion standard instead.
- A grace period on the 404 deletion trigger. Asked in the 2019 FAQ thread (Deadlystrike-1144,
  4 October 2019 — is it 404 *and* 30 days, or immediately on 404 even during an API wobble?) and
  never answered by staff.

The absence of an express prohibition is **not** permission, because the discretion clauses in
§4.1 and §4.2 are written precisely to cover cases the drafters did not enumerate.

### 4.6 Blizzard's Privacy Policy: the sharing basis, and a player opt-out

The ToU requires our privacy policy to be "consistent with Blizzard's privacy policy" (§1.7), so
Blizzard's own policy is operative here, not merely context. It is dated more recently than the
ToU:

> "This Privacy Policy was last updated on June 27, 2025."
>
> — <https://www.blizzard.com/en-us/legal/a4380ee5-5c8d-4e3b-83b7-ea26d01a9918/blizzard-entertainment-online-privacy-policy>,
> retrieved 2026-08-06

The clause that authorises the whole developer API programme:

> "We share some of our players' game data with our community of developers who create
> applications and websites that benefit our player community. **You may opt-out of having your
> game data included in this program by opting out of game-data sharing in the Privacy section of
> Battle.net account management.**"
>
> — same document (emphasis added)

Three consequences, and they are significant:

1. **The purpose limitation is repeated here.** "Applications and websites that benefit our
   player community" is the stated basis on which Blizzard discloses player game data to us at
   all. It is not merely a ToU covenant; it is the scope of the disclosure. An application
   outside that purpose is receiving data outside the basis on which the player's data was
   shared.
2. **There is a player-facing opt-out, and it operates upstream of us.** Blizzard documents it in
   two current support articles — the most recently updated primary sources in this whole note:

   > "Sharing your Data with Developers is an option listed in World of Warcraft that allows your
   > account's game data to appear in third party websites, leaderboards, etc. If you wish to
   > Enable / Disable this feature you can do it by following these steps: Go to the Privacy &
   > Communications tab on your Battle.net account Management. Scroll down to 'Game Data and
   > Profile Privacy'. Enable / Disable the 'Share my game data with community developers'
   > option. … **Disabling this feature may take up to 30 days to process.**"
   >
   > — "Enabling / Disabling Sharing Game Data With Developers",
   > <https://us.support.blizzard.com/en/article/375447>, article `000375447`,
   > **updated 2026-05-05**, retrieved 2026-08-06 (emphasis added)

   > "If a community site or app displays a 404 error when attempting to login via Battle.net or
   > when accessing your Battle.net info, you may have sharing disabled for game data."
   >
   > — "404 Error When a Community App Tries to Access My Battle.net Data",
   > <https://us.support.blizzard.com/en/article/257277>, article `000257277`,
   > **updated 2026-02-05**, retrieved 2026-08-06

   (Both pages are JS-gated; the text above was read from Blizzard's own first-party JSON endpoint
   `us.support.blizzard.com/services/bft/api/article/en/{id}`, which also supplies the `updated`
   timestamps quoted.)

   Three things follow. First, **the whole compliance system is one closed loop**: the opt-out
   produces a 404, the 404 obliges deletion, and the 30-day TTL guarantees we ask often enough to
   see it. "Disabling this feature may take up to 30 days to process" is the same 30 days,
   deliberately. Second, **there is already a population of players who have refused to appear in
   third-party tools**, and the only way we honour that refusal is by revalidating and deleting.
   A permanently cached page silently defies an opt-out the player has already exercised. Third,
   and most awkwardly for this feature: **the opt-out is all-or-nothing and upstream.** A player
   who objects to SlashWho specifically has no route to it other than leaving every community tool
   at once. Whether that counts as an adequate opt-out for a service the player never chose is
   question 5 in §5.
3. **Some players' data is legitimately public and stays public.** The policy also says:

   > "Blizzard also may publicly display certain personal information about you, including
   > certain account information and gameplay information, on our products and services, or the
   > properties operated by our third-party partners and licensees."

   This supports the "the inputs were already public" argument. It does not extend to the
   *inference*, which Blizzard does not publish.

One further observation, contextual rather than contractual but relevant to how Blizzard treats
this category of information. Blizzard's own product surface for cross-character visibility is
**mutual and opt-in**:

> "Real ID friends can see each other's real-life name and can see each other's characters across
> all Blizzard products and services."
>
> — same document, §9 "What is Real ID?"

Seeing a player's characters across the board is, in Blizzard's own design, a privilege unlocked
by a mutually agreed friendship. Blizzard has never exposed an account identifier across
characters in the API, and the only account-scoped endpoints (`/profile/user/wow`, protected
character profile) require the player's own OAuth consent (§2.5). The achievement-timestamp
fingerprint reconstructs, without consent, exactly the linkage that Blizzard gates behind
consent. That is not a term, and it is not a prohibition — but it is a clear signal of intent,
and it makes an adverse reading of "invasive of the privacy of another person" more likely rather
than less.

### 4.7 The GDPR exposure sits with us, not Blizzard

Two clauses combine into the sharpest legal risk, and it is not a Blizzard-relations risk.

> "(e) You and Your Applications comply with all applicable laws, rules, and regulations,
> including but not limited to the CCPA and the EU's General Data Protection Regulation."
>
> — ToU §5, "Representations And Warranties"

Read with the CCPA clause in §1.2, which requires us to remain a **Service Provider** and "not do
anything that would change your status … from being a Service Provider to being a Purchaser of the
Blizzard Data". A Service Provider processes on the controller's behalf and for the controller's
purposes. Generating a novel inference about a player that the controller does not itself
generate, and publishing it for our own purpose, is arguably the act of a controller in our own
right — which the ToU expressly forbids.

The ToU is silent on GDPR roles (it names only the CCPA status). That silence matters for a
UK-based operator: if SlashWho is an independent controller for the linkage inference, then the
usual controller obligations attach directly to us — lawful basis, transparency to the data
subject, and the Article 21 right to object. Legitimate interests is the only candidate basis, and
it would have to survive a balancing test against the data subject's reasonable expectations —
expectations that Blizzard's own consent gate (§4.6) and Real ID design help establish *against*
us. The uncapped indemnity (§1.9) means a single complaint to a supervisory authority is our
exposure, not Blizzard's.

This is flagged, not resolved: it is a legal question beyond what a documentation review can
settle, and it deserves its own ticket rather than a paragraph here.

### 4.8 Precedent: the technique is publicly known, and Blizzard has never commented

The exact fingerprint was described openly on Blizzard's own API forum in 2019:

> "search for a few key account-wide achievements and check their completed timestamp for a match"
>
> — Schiller-1822, 21 August 2019,
> <https://us.forums.blizzard.com/en/blizzard/t/wow-tips-on-detecting-characters-of-same-account/286>,
> retrieved 2026-08-06

**This is not approval and must not be cited as such.** Verified via the Discourse JSON API:
Schiller-1822 is `staff: false`, user title "MVP" — a community volunteer. No Blizzard employee
replied in that thread. The thread establishes only that the technique has been public knowledge
for seven years and that Blizzard has neither blessed nor blocked it. Notably, Blizzard has also
not closed the hole in that time, despite adding the consent gate elsewhere — which cuts both
ways and should not be over-read in either direction.

### 4.9 On the ethical question being decided elsewhere

The ticket asks whether anything in the terms bears on publishing inferences a player may not
want published. It does, in two places, and this should feed the separate ethics ticket rather
than be resolved independently of it:

- The "invasive of the privacy of another person" content standard (§4.1) makes player privacy a
  **contractual** matter, not only an ethical one. A decision that the feature is ethically
  acceptable does not settle it; Blizzard's discretion sits on top.
- The per-individual erasure right (§3.4) means any published linkage must be removable on the
  player's unilateral request, immediately, with no requirement that they justify it. Whatever
  the ethics ticket concludes, an architecture without a fast, player-initiated takedown path is
  non-compliant regardless.

---

## 5. Questions to put to Blizzard rather than interpret ourselves

These are genuinely ambiguous. Recommended route: the API Discussion forum
(<https://us.forums.blizzard.com/en/blizzard/c/api-discussion>), which is where Blizzard's API
staff have historically answered policy questions, and/or the developer portal contact channel.
Ask before registering the client, and quote the intended use precisely.

1. **The central one.** Does an Application that compares account-wide achievement completion
   timestamps across characters, in order to state publicly that those characters belong to the
   same account, fall within "Applications must benefit the Blizzard player community", or is it
   "invasive of the privacy of another person" under the offensive-material clause? Specifically
   where the character's owner has taken deliberate steps elsewhere to keep the link private.
2. **Retention.** Does the 30-day TTL apply to a *derived* artefact — a stored assertion that two
   characters share an owner, holding no raw timestamps — or only to the raw Data? If the derived
   assertion may persist beyond 30 days, does it still have to be deleted on a §11 erasure
   request?
3. **Publication permanence.** Are permanently crawlable public pages built from the Data
   consistent with the requirement that the Data remain "dynamically available" and with the
   principle that nothing may "prevent or hinder the deletion of the Data"?
4. **Onward API.** Does exposing Blizzard-derived fields through our own public read API count as
   permitted distribution "to end users for their personal use via Your Application", or as
   prohibited distribution of "Data outside of your authorized Applications"?
5. **Opt-out standing.** Must we honour a de-linking request from a player who has never used
   SlashWho and never authorised it — i.e. does §11's "any individual" cover every player whose
   public character data we hold, on request? And is the upstream "Share my game data with
   community developers" toggle intended to be the *sufficient* opt-out for a service of this
   kind, given it is all-or-nothing across every community tool and takes up to 30 days? If a
   player asks to leave the linkage graph without disabling data sharing, what does §11 require?
6. **Consent-gated linkage.** Blizzard exposes account-scoped character lists only behind the
   player's own OAuth consent, and cross-character visibility between players only behind mutual
   Real ID friendship. Is reconstructing that linkage from public per-character data, without
   consent, an intended use of the public endpoints or a circumvention of a deliberate design
   choice?
7. **Rate limit scope.** Confirm whether the 36,000/hour ceiling is enforced per client id, per
   application, or additionally per originating IP (relevant to running multiple replicas behind
   one client id), and whether any elevated allowance exists for a non-commercial community
   project. Also confirm whether OAuth token requests count against the quota. Worth asking
   because the widely repeated "per application" answer turns out to be a community MVP's, never
   confirmed by staff (§2.3).
8. **Controller or processor.** Does Blizzard regard the developer as controller or processor
   under GDPR/UK GDPR for an inference the developer generates rather than retrieves? The ToU
   designates us a CCPA "Service Provider" and forbids acting so as to change that status; does
   publishing a novel inference about a player cross that line? (§4.7)
9. **Design mitigations.** Would any of these change Blizzard's assessment: showing linkage only
   to the authenticated account owner rather than publicly; a per-site opt-out register; a
   confidence threshold; `noindex` on linkage pages? Knowing which mitigations count is more
   useful than a bare yes/no.

Question 1 is the one that decides the effort. It should be asked in writing, with the answer
recorded, before any implementation work.

### What to do before asking

The registration form requires a declared intent of use and application URL. Do not register a
client with a vague intent and work out the answer later — a declared purpose that does not match
what the Application does is a misrepresentation under ToU §5(c) ("the information You provided
when Registering on the Developer Site was true and correct and will remain true and correct as
long as you possess Data"). Draft the honest one-line intent first; if it is uncomfortable to
write down, that is itself the answer to question 1.

---

## Bottom line

**Ambiguous, leaning restrictive — and definitely not a green light.**

- **(a) Access** is clearly permitted in form: a public website is an expressly contemplated
  Application, registration is straightforward, and the request volume implied by tens to low
  hundreds of searches a day sits far inside the documented ceiling. Conditions we do not
  currently meet — a published privacy policy, Blizzard attribution, an immediate-response
  removal channel — are real but tractable.
- **(b) Storage as currently envisaged is prohibited, but the fix is mechanical.** This is the
  one flat "no" in the note. The 30-day maximum TTL is explicit, Blizzard staff confirmed
  anonymisation is not an acceptable substitute for deletion, and "permanent, crawlable public
  character pages" backed by retained achievement timestamps cannot be squared with it. It forces
  a redesign — continuous revalidation of the whole corpus rather than fetch-once-and-keep — but
  the Character Profile Status endpoint makes that one cheap call per character per 30 days, well
  within budget. What remains genuinely unresolved is whether a *derived* linkage edge, holding no
  raw timestamps, is itself "Data" subject to the TTL. Nothing in the terms answers that; it is
  question 2 in §5, and until it is answered the safe assumption is that it is.
- **(c) Publishing the derived inference is unresolved and cannot be resolved by reading.** The
  terms neither permit nor prohibit it in terms. They instead route it through "invasive of the
  privacy of another person ... as determined by Blizzard in Blizzard's sole discretion" and
  "negatively affects Blizzard's players ... in Blizzard's sole discretion", backed by
  termination without notice and an uncapped indemnity. A confident reading either way would be
  manufactured. What can be said is that the two clauses that reach it both point the same way,
  both are decided unilaterally by Blizzard, and the surrounding evidence — the privacy policy's
  "benefit our player community" basis, the upstream player opt-out, and Blizzard's practice of
  gating cross-character visibility behind consent — tilts an adverse reading more likely than a
  favourable one.

Two things worth carrying out of this note beyond the three-way split. First, the **larger legal
exposure may not be Blizzard at all**: the ToU makes us warrant GDPR compliance and indemnify
Blizzard without cap, so the realistic worst case is a player complaint to a supervisory authority
landing on us, not a terse email from Irvine (§4.7). Second, **the technique has been public since
2019 and Blizzard has never commented on it** (§4.8) — which is not permission, and should not be
read as any.

**The single most important open question:** *does Blizzard consider an Application that publicly
links characters to a shared account, against the apparent wishes of that account's owner, to
"benefit the Blizzard player community" — or to be "invasive of the privacy of another person"?*
Put it to Blizzard directly, in writing, before registering a client or budgeting requests.
