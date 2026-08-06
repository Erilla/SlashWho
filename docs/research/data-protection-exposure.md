# Data-protection exposure for publishing derived account linkage

Research note for GitHub issue #16 (`wayfinder:research`).

**Question.** What data-protection obligations attach to generating, storing and publishing the
inference "these World of Warcraft characters share an owner", where the inference is derived from
account-wide Blizzard achievement completion timestamps and is published for players who
deliberately hid that link elsewhere? The operator is an individual in the United Kingdom running
SlashWho as an unpaid hobby project.

**Researched:** 6 August 2026. Every primary citation below was retrieved live on that date. Where
a source states its own "last updated" date, that date is recorded alongside.

**This is research, not legal advice.** §13 sets out the specific questions to put to a solicitor.
Nothing here is a substitute for that step, and §13 exists precisely because several of the
load-bearing questions cannot be settled from the sources.

---

## Scope note: three acts, not one

The ticket is right that these must be separated, and the separation drives the whole analysis:

- **(a) Creating** the inference — running the timestamp comparison and producing the conclusion.
- **(b) Storing** it — persisting the linkage and the snapshots it appears in.
- **(c) Publishing** it — serving it on permanent, crawlable, dated public pages and through a
  public API.

All three are "processing" under Article 4(2), so all three need a lawful basis. But they are not
equally defensible, they attract different balancing outcomes, and only (c) creates the
irreversibility problem in §7.5. Where this note says "the answer differs", it means the answer
differs between these three.

---

## Read this first: the law moved, recently

Anything written about UK data protection before February 2026 is now partly out of date, and two
of the changes bear directly on this ticket.

1. **The Data (Use and Access) Act 2025 (c. 18) is substantially in force.** Its data-protection
   provisions were commenced by S.I. 2026/82 on **5 February 2026**, with a further tranche on
   **19 June 2026**. It restructured UK GDPR Article 6 (adding a "recognised legitimate interest"
   basis at Article 6(1)(ea) and Annex 1), rewrote the Article 14 transparency exemptions, and
   inserted a **new statutory duty on controllers to handle data-subject complaints** at section
   164A of the DPA 2018. Article numbering in older commentary no longer matches the statute.
   It also inserted a **new Chapter 8A (Articles 84A and 84B)** which tightens the
   research/archiving/statistics gateway that Articles 5(1)(e) and 17(3)(d) now depend on — see §7.2,
   where it turns out to be decisive against permanent snapshots.
2. **The ICO rewrote its lawful-basis guidance on 23 March 2026** to reflect the DUAA, and published
   **new anonymisation guidance on 28 March 2025** which codifies the identifiability test, the
   "whose hands?" question and the motivated-intruder test (§1.8). Several other ICO pages now carry
   a banner reading "Due to changes made by the Data (Use and Access) Act, this guidance is under
   review and may be subject to change" — including the "What is personal data?" guidance this note
   leans on heavily in §1. Those pages are cited as the regulator's current position, but their
   current position is expressly provisional, and some still quote repealed article numbers.
3. **The Upper Tribunal reversed the Clearview jurisdiction ruling on 6 October 2025**, construing
   "monitoring of behaviour" in Article 3(2)(b) very broadly and holding that it does not require any
   human watchfulness (§3.4). Anything written between October 2023 and October 2025 that treats the
   First-tier Tribunal's decision as good law is out of date. Clearview has permission to appeal.
4. **The EDPB adopted draft Guidelines 03/2026 on web scraping on 7 July 2026**, in consultation to
   30 October 2026 (§9). Not UK law, not final, and scoped to generative AI — but the clearest
   current statement at EU level that public availability is not a licence.
5. **The regulator is still the Information Commissioner.** The DUAA establishes an Information
   Commission, but ss. 118 and 119 (abolishing the office and transferring functions) remain marked
   *Prospective* on legislation.gov.uk as at 6 August 2026, notwithstanding an ICO statement of 19
   June 2026 to the contrary. See §10.2.

Where this note quotes an article number, it is the number **as currently in force in the UK GDPR
on legislation.gov.uk**, which is not always the number in the EU GDPR or in pre-2026 writing. The
most consequential renumbering for us is the "disproportionate effort" transparency exemption:
formerly Article 14(5)(b), now **Article 14(5)(e)** with new supporting paragraphs 14(6) and
14(7). See §6.

---

## Primary source inventory

| Document | URL | Stated date | Retrieved |
| --- | --- | --- | --- |
| UK GDPR (Regulation (EU) 2016/679 as retained and amended) | <https://www.legislation.gov.uk/eur/2016/679/contents> | revised to 2026-06-22, valid 2026-06-19 | 2026-08-06 |
| UK GDPR recitals (as retained) | <https://www.legislation.gov.uk/eur/2016/679/introduction> | as above | 2026-08-06 |
| UK GDPR Annex 1 (recognised legitimate interests) | <https://www.legislation.gov.uk/eur/2016/679/annex/1> | inserted by DUAA 2025 | 2026-08-06 |
| Data Protection Act 2018 (c. 12) | <https://www.legislation.gov.uk/ukpga/2018/12/contents> | as amended | 2026-08-06 |
| DPA 2018 s.164A (complaints to controllers) | <https://www.legislation.gov.uk/ukpga/2018/12/section/164A> | in force 19.6.2026 | 2026-08-06 |
| DPA 2018 Sch. 2 Pt. 5 para. 26 (special purposes) | <https://www.legislation.gov.uk/ukpga/2018/12/schedule/2/paragraph/26> | — | 2026-08-06 |
| DPA 2018 s.170 (unlawful obtaining) | <https://www.legislation.gov.uk/ukpga/2018/12/section/170> | — | 2026-08-06 |
| Data Protection (Charges and Information) Regulations 2018 (S.I. 2018/480) | <https://www.legislation.gov.uk/uksi/2018/480> | fees amended by S.I. 2025/63 from 17.2.2025 | 2026-08-06 |
| ICO — "What is personal data?" (guide) | <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/personal-information-what-is-it/what-is-personal-data/> | flagged "under review" post-DUAA | 2026-08-06 |
| ICO — "What are identifiers and related factors?" | <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/personal-information-what-is-it/what-is-personal-data/what-are-identifiers-and-related-factors/> | flagged "under review" post-DUAA | 2026-08-06 |
| ICO — "What is the meaning of 'relates to'?" | <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/personal-information-what-is-it/what-is-personal-data/what-is-the-meaning-of-relates-to/> | flagged "under review" post-DUAA | 2026-08-06 |
| ICO — "Legitimate interests" | <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/a-guide-to-lawful-basis/legitimate-interests/> | **last updated 23 March 2026** | 2026-08-06 |
| ICO — "When do we need to do a DPIA?" | <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/when-do-we-need-to-do-a-dpia/> | — | 2026-08-06 |
| ICO — anonymisation guidance | <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-sharing/anonymisation/> | **published 28 March 2025** | 2026-08-06 |
| ICO — data protection and journalism code of practice | <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-and-journalism-code-of-practice/> | in force 22 February 2024 | 2026-08-06 |
| ICO — web scraping for generative AI (outcomes report) | <https://ico.org.uk/about-the-ico/what-we-do/our-work-on-artificial-intelligence/response-to-the-consultation-series-on-generative-ai/the-lawful-basis-for-web-scraping-to-train-generative-ai-models/> | December 2024 | 2026-08-06 |
| ICO — data protection fee | <https://ico.org.uk/for-organisations/data-protection-fee/> | now points to GOV.UK | 2026-08-06 |
| *ICO v Clearview AI Inc* [2025] UKUT 319 (AAC) | <https://caselaw.nationalarchives.gov.uk/ukut/aac/2025/319> | 6 October 2025 | 2026-08-06 |
| EDPB Guidelines 5/2019 (RTBF, search engines) | <https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_guidelines_201905_rtbfsearchengines_afterpublicconsultation_en.pdf> | adopted 7 July 2020 | 2026-08-06 |
| EDPB Guidelines 03/2026 (web scraping, draft) | <https://www.edpb.europa.eu/public-consultations/guidelines-032026-on-web-scraping-in-the-context-of-generative-ai_en> | adopted 7 July 2026, in consultation | 2026-08-06 |
| Art 29 WP Guidelines on profiling, WP251rev.01 | <https://www.edpb.europa.eu/our-work-tools/general-guidance/endorsed-wp29-guidelines_en> | rev. adopted 6 February 2018 | 2026-08-06 |
| Cal. Civ. Code § 1798.140 | <https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1798.140> | amended Stats. 2025 Ch. 67, eff. 1 January 2026 | 2026-08-06 |
| SlashWho staging privacy page | <https://web-test-2855.up.railway.app/privacy> | live | 2026-08-06 |
| SlashWho removal template and removals runbook | `.github/ISSUE_TEMPLATE/removal-request.yml`, `docs/operations/removals.md` | this repository | 2026-08-06 |

**Retrieval caveat.** `ico.org.uk` returns HTTP 403 to plain fetchers; every ICO quotation here was
read with a browser user-agent and the text is the rendered page content. `legislation.gov.uk`
serves the amended text cleanly, and the article text below is taken from its
`.../data.xht` renderings. Curly quotes in the source have been normalised to straight quotes; no
words have been changed.

**Sibling notes.** This note takes as given, from `docs/research/blizzard-api-terms.md` (#5) and
`docs/research/fingerprint-mechanics.md` (#6): the Blizzard ToU imposes a mandatory 30-day TTL on
all API data; Blizzard staff expressly rejected anonymisation as a substitute for deletion; there
is an upstream player opt-out, "Share my game data with community developers", whose effect is a
404 and consequent mandatory deletion; and the linkage is inferred from account-wide achievement
completion timestamps.

---

## 1. Is a character-to-account linkage inference personal data?

This is the crux. If the answer is no, almost nothing else in this note applies. The answer is
**yes**, and it is less marginal than the "characters are pseudonyms" framing suggests. Four
independent routes get there.

### 1.1 The definition, and what it actually requires

> "'personal data' means any information relating to an identified or identifiable natural person
> ('data subject'); an identifiable natural person is one who can be identified, directly or
> indirectly, in particular by reference to an identifier such as a name, an identification
> number, location data, an online identifier or to one or more factors specific to the physical,
> physiological, genetic, mental, economic, cultural or social identity of that natural person"
>
> — UK GDPR Article 4(1), <https://www.legislation.gov.uk/eur/2016/679/article/4>, retrieved 2026-08-06

Two limbs, and both must be satisfied: the information must **relate to** a person, and that
person must be **identified or identifiable**. Take them in turn.

### 1.2 "Identifiable": the ICO says a pseudonymous handle is enough, on its own

The single most decisive source in this whole note is the ICO's own guidance on online
identifiers. It addresses precisely the "but it's just a character name" objection, and it rejects
it:

> "An individual's social media 'handle' or username, which may seem anonymous or nonsensical, is
> still sufficient to identify them as it uniquely identifies that individual. The username is
> personal data if it distinguishes one individual from another **regardless of whether it is
> possible to link the 'online' identity with a 'real world' named individual**."
>
> — ICO, "What are identifiers and related factors?",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/personal-information-what-is-it/what-is-personal-data/what-are-identifiers-and-related-factors/>,
> retrieved 2026-08-06 (emphasis added)

That paragraph is fatal to the pseudonymity defence as usually stated. The regulator's test is
**singling out**, not naming. A WoW character name is realm-unique by construction — the game
enforces it — so `region/realm/name` distinguishes exactly one individual from every other. On the
ICO's stated test that is sufficient, and the fact that SlashWho cannot put a legal name to it is
explicitly irrelevant.

The same page lists "account handles" and "device fingerprints" among the examples of online
identifiers, and describes the mechanism we are building:

> "The use of these may leave traces which, when combined with unique identifiers and other
> information received by servers, may be used to create profiles of individuals and identify
> them. When assessing if an individual is identifiable, you must consider whether online
> identifiers, on their own or in combination with other information that may be available to
> those processing the data, may be used to distinguish one user from another, possibly by the
> creation of profiles of the individuals to identify them. This may be either as a named
> individual or **simply as a unique user** of electronic communications and other internet
> services who may be distinguished from other users."
>
> — same page (emphasis added)

An achievement-timestamp fingerprint is a behavioural fingerprint used to distinguish one account
from another. It is squarely within the described category.

### 1.3 Recital 26: "all the means reasonably likely to be used"

Even if the ICO's singling-out position were set aside, Recital 26 arrives at the same place by a
different route. The UK retained the recital verbatim:

> "The principles of data protection should apply to any information concerning an identified or
> identifiable natural person. Personal data which have undergone pseudonymisation, which could be
> attributed to a natural person by the use of additional information should be considered to be
> information on an identifiable natural person. To determine whether a natural person is
> identifiable, account should be taken of all the means reasonably likely to be used, such as
> singling out, **either by the controller or by another person** to identify the natural person
> directly or indirectly. To ascertain whether means are reasonably likely to be used to identify
> the natural person, account should be taken of all objective factors, such as the costs of and
> the amount of time required for identification, taking into consideration the available
> technology at the time of the processing and technological developments."
>
> — UK GDPR Recital 26, <https://www.legislation.gov.uk/eur/2016/679/introduction>, retrieved 2026-08-06 (emphasis added)

Three phrases do the work.

**"such as singling out"** — singling out is named as a form of identification, not merely a step
towards it. This is the same test as §1.2.

**"either by the controller or by another person"** — the means need not be available to
SlashWho. It is enough that they are reasonably likely to be used by *someone*. This is the point
at which the WoW context becomes decisive rather than incidental. Character names are routinely
tied to Discord handles in guild rosters, to streaming identities, to Raider.IO profiles carrying
real names, and to a dense social graph in which guildmates, ex-guildmates and raid teams know
exactly who a character is. The means are not hypothetical, exotic or expensive; for a large share
of the player base they are one search away, at zero cost, and are used routinely.

**"the costs of and the amount of time required"** — the objective-factors test is a cost test,
and the cost here is near zero.

Note the direction of travel: SlashWho's output *increases* identifiability rather than being
neutral to it. A published linkage set is a re-identification aid — it hands anyone who knows one
character a list of the others. That is not an incidental feature; it is the product.

### 1.4 Pseudonymised data is still personal data — and this is not even pseudonymisation

> "'pseudonymisation' means the processing of personal data in such a manner that the personal
> data can no longer be attributed to a specific data subject without the use of additional
> information, provided that such additional information is kept separately and is subject to
> technical and organisational measures to ensure that the personal data are not attributed to an
> identified or identifiable natural person"
>
> — UK GDPR Article 4(5), retrieved 2026-08-06

The ICO is unambiguous about the consequence:

> "However, pseudonymisation is effectively only a security measure. It does not change the status
> of the data as personal data. Recital 26 makes it clear that pseudonymised personal data remains
> personal data and within the scope of the UK GDPR."
>
> — ICO, "What is personal data?",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/personal-information-what-is-it/what-is-personal-data/what-is-personal-data/>,
> retrieved 2026-08-06

There is a further point worth being precise about, because it is easy to claim the wrong
protection. A character name is **not** pseudonymised data in the Article 4(5) sense at all.
Article 4(5) describes a deliberate control — replacing identifiers, holding the key separately
under technical and organisational measures. Nobody applied that control here. A character name is
simply a **pseudonymous identifier chosen by the user**, with no separated key and no safeguards.
It therefore does not even attract the (already limited) risk-reduction credit that Article 4(5)
pseudonymisation earns. Calling the data "pseudonymous" is accurate as English and legally worth
nothing.

The ICO is likewise firm that near-anonymisation does not count:

> "In order to be truly anonymised under the UK GDPR, you must strip personal data of sufficient
> elements that mean the individual can no longer be identified. However, if you could at any
> point use any reasonably available means to re-identify the individuals to which the data
> refers, that data will not have been effectively anonymised but will have merely been
> pseudonymised."
>
> — same page

This closes the "hash the timestamps" escape route, and it converges with the position Blizzard
staff took independently in the sibling note (#5), where anonymisation was rejected as a
substitute for deletion.

### 1.5 "Relates to": the purpose of the processing settles it

The second limb of Article 4(1) is sometimes the harder one — data can mention a person without
being about them. Not here. The ICO's test:

> "Data which identifies an individual, even without a name associated with it, may be personal
> data if you are processing it **to learn or record something about that individual**, or where
> the processing has an impact on that individual."
>
> — ICO, "What is the meaning of 'relates to'?",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/personal-information-what-is-it/what-is-personal-data/what-is-the-meaning-of-relates-to/>,
> retrieved 2026-08-06 (emphasis added)

> "If the data is used, or is likely to be used, to learn, evaluate, treat in a certain way, make
> a decision about, or influence the status or behaviour of an individual, then it is personal
> data."
>
> — same page

Learning something about an individual is not a side effect of SlashWho; it is the entire product.
The service exists to answer "who else is this person?". There is no reading on which the output
does not "relate to" the person.

### 1.6 The inference is itself personal data, and a wrong inference still is

Two further ICO statements close off the remaining escape routes.

> "An opinion relating to an individual is also capable of constituting personal data,
> irrespective of the accuracy of that opinion."
>
> — same page

> "If information seemingly relating to a particular individual is inaccurate (ie it is factually
> incorrect or it is information about a different individual), the information is still personal
> data, as it relates to that individual."
>
> — same page

The ICO's worked example makes the second point sharply: where a landlord records a complaint
against the wrong tenant, the record is personal data **about both** the person named and the
person it actually concerns. Transposed, a false-positive fingerprint match — two unrelated
players who happen to share achievement timestamps — produces published personal data about two
data subjects, one of whom is being publicly and wrongly associated with the other's characters.
Both then hold Article 16 rectification rights. §7.3 returns to this.

So the "we are creating new data, not processing existing data" framing in the ticket does not
help. It is true as a description and irrelevant as a defence: creating personal data *is*
processing, the resulting inference *is* personal data, and its being novel makes the transparency
and expectation problems worse rather than better.

### 1.7 The case law, including a 2025 judgment that looks helpful and is not

Three CJEU judgments govern identifiability. A note on their status first: since the Retained EU Law
(Revocation and Reform) Act 2023 abolished the supremacy of EU law and retained general principles
from 1 January 2024, pre-Brexit CJEU decisions are **assimilated case law** of limited binding force
and UK courts may depart from them. They remain the most authoritative interpretation available of
wording the UK has retained verbatim, and the ICO's guidance is built on them, so they are cited
here as strongly persuasive rather than binding. Post-Brexit CJEU judgments (which includes the 2025
one below) bind nobody in the UK at all, but they interpret identical text and will influence how a
UK court reasons.

**Breyer (C-582/14, Second Chamber, 19 October 2016, ECLI:EU:C:2016:779)** established that the
identifying information need not all sit in one place:

> "41. The use by the EU legislature of the word 'indirectly' suggests that, in order to treat
> information as personal data, it is not necessary that that information alone allows the data
> subject to be identified."
>
> "43. In so far as that recital refers to the means likely reasonably to be used by both the
> controller and by 'any other person', its wording suggests that ... **it is not required that all
> the information enabling the identification of the data subject must be in the hands of one
> person**."
>
> "46. ... that would not be the case if the identification of the data subject was **prohibited by
> law or practically impossible** on account of the fact that it requires a disproportionate effort
> in terms of time, cost and man-power, so that the risk of identification appears in reality to be
> insignificant."

Note how high paragraph 46 sets the bar for escaping the definition: not "difficult", but prohibited
by law or practically impossible, with a risk that is "in reality insignificant". Identifying the
human behind a WoW character is neither prohibited nor impossible; for many characters it is
trivial.

**Nowak (C-434/16, Second Chamber, 20 December 2017, ECLI:EU:C:2017:994)** settles that a third
party's derived assessment of a person is that person's personal data:

> "34. The use of the expression 'any information' ... reflects the aim of the EU legislature to
> assign a wide scope to that concept, which is not restricted to information that is sensitive or
> private, but **potentially encompasses all kinds of information, not only objective but also
> subjective, in the form of opinions and assessments**, provided that it 'relates' to the data
> subject."
>
> "35. As regards the latter condition, it is satisfied where the information, **by reason of its
> content, purpose or effect, is linked to a particular person**."
>
> "45. **The same information may relate to a number of individuals** and may constitute for each of
> them, provided that those persons are identified or identifiable, personal data ..."

Paragraph 35's three limbs are disjunctive — content **or** purpose **or** effect. SlashWho's output
satisfies all three. Paragraph 45 is the authority for the point made at §1.6: a linkage set is
simultaneously personal data of every person in it, including anyone wrongly included.

**EDPS v SRB (C-413/23 P, First Chamber, 4 September 2025)** is the recent one, it is the one that
will be cited at us, and it needs handling carefully because it is genuinely two-edged. The Court set
aside the General Court's judgment and referred the case back. Note it concerns Regulation (EU)
2018/1725 rather than the GDPR, but paragraph 52 requires Article 3(1) EUDPR, Article 4(1) GDPR and
Article 2(a) of Directive 95/46 to be interpreted the same way.

The half that helps a publisher:

> "86. ... pseudonymised data must not be regarded as constituting, in all cases and for every
> person, personal data ... in so far as pseudonymisation may, depending on the circumstances of the
> case, effectively prevent persons other than the controller from identifying the data subject in
> such a way that, for them, the data subject is not or is no longer identifiable."

That is a genuinely relative approach: data can be personal in one party's hands and not in
another's. Taken alone it looks like the answer to "we cannot identify anyone". It is not, for four
reasons the same judgment supplies.

> "85. in so far as it cannot be ruled out that those third parties have means reasonably allowing
> them to attribute pseudonymised data to the data subject, such as **cross-checking with other data
> at their disposal**, the data subject must be regarded as identifiable **as regards both that
> transfer and any subsequent processing** of those data by those third parties. In such
> circumstances, pseudonymised data should be considered to be personal in nature."
>
> "82. a means of identifying the data subject is not reasonably likely to be used where the risk of
> identification appears in reality to be **insignificant**, in that the identification ... is
> **prohibited by law or impossible in practice** ..."
>
> "99. ... it is settled case-law that, for information to be treated as 'personal data', it is not
> required that all the information enabling the identification of the data subject must be in the
> hands of one person"
>
> "111. ... for the purposes of applying the obligation to provide information laid down in Article
> 15(1)(d) ..., the identifiable nature of the data subject must be assessed **at the time of
> collection of the data and from the point of view of the controller**."

Read together, the judgment is fatal rather than helpful on our facts, and it is worth being precise
about why:

1. **Paragraph 86's relativity protects a walled-off *recipient*, not a *publisher*.** The scenario
   is a controller transferring pseudonymised data to a party who cannot lift the pseudonymisation.
   SlashWho is not a walled-off recipient; it is a disseminator to an unrestricted public audience.
2. **Paragraph 85 is the anti-circumvention rule and it lands squarely.** Where third parties have
   means "such as cross-checking with other data at their disposal", the subject is identifiable "as
   regards both that transfer and any subsequent processing". SlashWho's audience — guildmates,
   ex-guildmates, Discord communities, ex-partners — is defined by its ability to cross-check. The
   site is not merely exposed to that audience; it is built for it.
3. **Paragraph 82's threshold is not met**, for the same reason Breyer's is not.
4. **Paragraph 111 fixes the perspective at the controller for transparency duties.** Even on the
   most generous relative reading, an operator's own inability to name people would not discharge
   the Article 14 obligations in §6.

There is a further passage worth having, because it disposes of the "we are stating a fact, not an
opinion, so Nowak doesn't apply" move — the Court expanded rather than narrowed Nowak:

> "54. ... potentially encompasses all kinds of information, not only objective but also subjective,
> in the form of opinions and assessments, provided that it 'relates' to the data subject"
>
> "56. ... an examination of the content of information need not necessarily be supplemented by an
> analysis of the purpose and effects of that information, as indicated by **the use of the
> conjunction 'or'**"

**Retrieval caveat, which matters here more than elsewhere.** `curia.europa.eu`'s InfoCuria pages
return a JavaScript shell and `eur-lex.europa.eu` was unreachable from this environment. The C-413/23
P holdings were confirmed against the official curia press release PDF
(<https://curia.europa.eu/site/upload/docs/application/pdf/2025-09/cp250107en.pdf>), but the
paragraph-level quotations above come from a third-party mirror (<https://ipcuria.eu/case?reference=C-413%2F23>)
and the ECLI has not been confirmed against a primary host. Nowak was read from an official *Reports
of Cases* PDF with printed paragraph numbers and is high confidence. Breyer's paragraph numbers were
reconstructed from cross-references, not read off a numbered page. **Re-verify any paragraph number
before it is relied on in correspondence.** The substance is not in doubt; the citations are.

### 1.8 The ICO's anonymisation guidance (28 March 2025) applies the same test, harder

This is the one substantive change in ICO guidance since 2024, and it was missed by the framing in
the ticket: the long-running anonymisation/pseudonymisation consultation concluded and the
**anonymisation guidance was published on 28 March 2025**
(<https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-sharing/anonymisation/>,
retrieved 2026-08-06; the page's changelog reads in full "28 March 2025 - this guidance was
published"). It codifies the identifiability test in terms that map directly onto this case:

> "When you assess identifiability risk, the first question you should ask is whether the information
> is personal data **in your hands** ... If the information is not personal data in your hands, then
> you should consider whether there are means that are 'reasonably likely' to be used **by other
> people. For example, anyone who might obtain access to the information.** ... **This can sometimes
> be known as the 'whose hands?' question.**"
>
> "You must consider all practical steps and means that are reasonably likely to be used by someone
> motivated to identify people ... This is known as the **motivated intruder test**."
>
> — ICO, "How do we ensure anonymisation is effective?", retrieved 2026-08-06

And on inferences specifically, which is exactly our question:

> "An inference refers to the potential to infer, guess or predict details about someone who can
> already be identified directly or indirectly. In other words, using information from various
> sources to deduce something new about a person."
>
> "**An inference can therefore be something you create, as opposed to something that you collect or
> observe.**"
>
> "Whether an inference is personal data depends on whether it relates to an identified or
> identifiable person."
>
> — same guidance, retrieved 2026-08-06

The "whose hands?" question is the one to apply. SlashWho publishes to the open internet, so the
relevant hands are **everyone's**, including the motivated intruder. And the ICO names that intruder
in terms that should give this project pause:

> "You should assume that you are not looking just at the means reasonably likely to be used by an
> ordinary person, but also by **a determined person with a particular reason to want to identify
> individuals. For example, investigative journalists, estranged partners, stalkers, or industrial
> spies.**"
>
> — ICO, "Can we identify an individual indirectly ...?",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/personal-information-what-is-it/what-is-personal-data/can-we-identify-an-individual-indirectly-from-the-information-we-have-together-with-other-available-information/>,
> retrieved 2026-08-06 (emphasis added)

"Estranged partners, stalkers" is not a rhetorical flourish on our facts. A tool that reveals a
player's other characters, including ones they deliberately hid, is precisely the tool a motivated
intruder of that description would want. This is the single most uncomfortable sentence in the ICO's
corpus for this feature, and it should be quoted in the DPIA rather than avoided.

### 1.9 The DUAA did *not* change the definition — a premise worth correcting

It is worth recording explicitly, because the opposite is widely assumed: **the Data (Use and Access)
Act 2025 did not amend the definition of personal data and did not insert a new statutory
identifiability test.** DPA 2018 s.3 in its point-in-time version at 5 February 2026
(<https://www.legislation.gov.uk/ukpga/2018/12/section/3/2026-02-05>, retrieved 2026-08-06) still
carries the original 2018 wording, and UK GDPR Article 4(1) is textually untouched (the DUAA
renumbered the surrounding definitions list and added new paragraphs 4(2)–(7), but not the
definition).

The statutory identifiability test people half-remember — identifiability by the controller or
processor by reasonable means, or by another person likely to obtain the information — was **clause 1
of the Data Protection and Digital Information (No. 2) Bill**, which fell at the May 2024 dissolution
and was deliberately not carried into the DUA Bill. It is not law and should not be cited. Recital 26
therefore sits exactly where it always did.

### 1.10 Verdict on §1

The linkage inference is personal data under UK GDPR Article 4(1), and so are the achievement
timestamps it is built from. The pseudonymity of a character name does not defeat this on the ICO's
stated test (§1.2), on the Recital 26 test (§1.3), on the "relates to" test (§1.5), or on the case
law (§1.7). The relative approach in *EDPS v SRB* is the strongest argument the other way and it does
not survive contact with paragraph 85. Treat this as settled for planning purposes.

The residual uncertainty is real but narrow: whether the *timestamps alone*, before linkage, are
personal data in the operator's hands. Given that they arrive already bound to a named character,
that argument is weak, and it would not help anyway — the published output is the problem, not the
input. §13 Q1 puts the question to a solicitor for completeness, not because the answer is in doubt.

**One risk flagged and not resolved.** Where a player keeps a character hidden in order to keep
something private about themselves, the linkage may reveal information falling within UK GDPR
Article 9(1) — a role-playing character, a guild with a religious or political character, a
same-sex in-game relationship, a character maintained separately for reasons connected to health or
gender. Article 9 processing requires a condition in Article 9(2) *in addition to* an Article 6
basis, and none of the Article 9(2) conditions is available to a public hobby site except 9(2)(e)
(data "manifestly made public by the data subject") — which by construction fails for the concealed
cohort. SlashWho would not intend to infer any of this and could not detect when it had. That is a
tail risk which the volume of publication makes near-certain to materialise at some point, and it
is not addressed further in this note. It belongs in the DPIA and in §13.


---

## 2. Is publishing it profiling?

> "'profiling' means any form of automated processing of personal data consisting of the use of
> personal data to evaluate certain personal aspects relating to a natural person, in particular
> to analyse or predict aspects concerning that natural person's performance at work, economic
> situation, health, personal preferences, interests, reliability, behaviour, location or
> movements"
>
> — UK GDPR Article 4(4), retrieved 2026-08-06

Three cumulative elements: automated processing; of personal data; to evaluate personal aspects.
The first two are plainly met. The third is arguable in both directions, and the honest answer is
that it probably is met but the point is not worth relying on either way.

**For.** The fingerprint analyses a person's **behaviour** — when they completed achievements,
across characters — and behaviour is one of the named "personal aspects". The list is expressly
non-exhaustive ("in particular"). The output is an evaluative conclusion about the person (who
they are across the game), not a mere retrieval of a stored fact.

The Article 29 Working Party guidance on profiling (WP251rev.01, adopted 3 October 2017, last revised
and adopted 6 February 2018, endorsed by the EDPB and listed at
<https://www.edpb.europa.eu/our-work-tools/general-guidance/endorsed-wp29-guidelines_en>, retrieved
2026-08-06) breaks the definition into the three elements above and adds two passages that cut our
way:

> "Profiling is a procedure which may involve a series of statistical deductions. It is often used to
> make predictions about people, **using data from various sources to infer something about an
> individual**, based on the qualities of others who appear statistically similar."
>
> "**The use of the word 'evaluating' suggests that profiling involves some form of assessment or
> judgement about a person.**"
>
> — WP251rev.01, pp. 6–7

The same document supplies the most useful single sentence in this whole note for understanding what
SlashWho would be doing:

> "The process of profiling is often invisible to the data subject. **It works by creating derived or
> inferred data about individuals – 'new' personal data that has not been provided directly by the
> data subjects themselves.**"
>
> — WP251rev.01, p. 9

That is a precise description of the feature, written nine years before it was proposed, and it is
also the answer to the ticket's "is this the creation of new personal data rather than the processing
of existing personal data?" question: it is both, and the regulators have a name for it.

**Against.** "Evaluate" arguably imports an element of assessment or scoring — rating, ranking,
predicting — rather than mere matching, and WP251 says so expressly. Identity resolution is closer to
record linkage than to evaluation. On a narrow reading, determining *that* two records share a
subject is not evaluating an aspect *of* that subject. WP251 also carves out simple classification:
"A simple classification of individuals based on known characteristics ... does not necessarily lead
to profiling. **This will depend on the purpose of the classification.**" But the carve-out turns on
whether a conclusion is drawn about the individual, and SlashWho draws one.

**Why it barely matters.** Almost nothing turns on the label:

- Article 22 (and the DUAA's new Articles 22A–22D) engage only for **significant decisions** based
  solely on automated processing, meaning ones producing "a legal effect for the data subject" or
  "a similarly significant effect". Publishing a linkage does not obviously meet that threshold,
  and SlashWho makes no decision *about* the person at all. The automated-decision regime is
  probably not engaged.
- Article 21(1)'s right to object applies to Article 6(1)(f) processing "**including** profiling
  based on those provisions" — so the objection right exists whether or not this is profiling.
- The DPIA trigger in §8 is met several times over on grounds that do not depend on the profiling
  label.

**Practical position:** assume it is profiling, because doing so costs nothing and the alternative
requires winning an argument you do not need to win. Note it in the privacy notice as
profiling-adjacent behavioural analysis. Do not build any compliance argument on the claim that it
is *not* profiling.

---

## 3. Which regime applies, and does any exemption rescue a hobbyist?

Short answer: **UK GDPR plus DPA 2018 apply directly and no exemption applies.** The
domestic-purposes route in particular fails, and it fails clearly enough that it should not be
argued.

### 3.1 UK GDPR applies because the operator is established in the UK

> "This Regulation applies to the processing of personal data in the context of the activities of
> an establishment of a controller or a processor in [the United Kingdom], regardless of whether
> the processing takes place in [the United Kingdom] or not."
>
> — UK GDPR Article 3(1), <https://www.legislation.gov.uk/eur/2016/679/article/3>, retrieved 2026-08-06
> (square brackets mark the EU-Exit substitution in the retained text)

Establishment is where the controller is, not where the data subjects are. A UK-resident operator
is caught for **all** processing, including processing about US, EU and Oceanic players. There is
no "my users are mostly American" argument. Note also that Article 3(1) has no de minimis: it does
not care that this is unpaid, hobby, or small.

### 3.2 The domestic-purposes exemption does not apply

The UK renumbered this exemption, so pre-Brexit references to Article 2(2)(c) are wrong. It is now:

> "2. This Regulation does not apply to— (a) the processing of personal data by an individual in
> the course of a purely personal or household activity;"
>
> — UK GDPR Article 2(2)(a), <https://www.legislation.gov.uk/eur/2016/679/article/2>, retrieved 2026-08-06

The ticket asked for this to be established rather than assumed. It fails on the face of the
recital, without needing to reach the case law:

> "This Regulation does not apply to the processing of personal data by a natural person in the
> course of a purely personal or household activity **and thus with no connection to a
> professional or commercial activity**. Personal or household activities could include
> correspondence and the holding of addresses, or social networking and online activity undertaken
> within the context of such activities. However, this Regulation applies to controllers or
> processors which provide the means for processing personal data for such personal or household
> activities."
>
> — UK GDPR Recital 18, retrieved 2026-08-06 (emphasis added)

Two independent reasons it fails:

1. **"Purely"** is doing real work. The activity must be wholly personal. Operating a public
   website that publishes information about **strangers**, indexed by search engines, reachable by
   anyone in the world, is not a personal or household activity in any ordinary sense. The
   exemption protects your address book and your family photos; it does not protect a public
   register.
2. The recital's carve-out for "social networking and online activity" is expressly limited to
   activity "undertaken **within the context of** such activities" — i.e. personal social use.
   SlashWho's data subjects have no personal or household relationship with the operator at all;
   they are unconnected third parties.

The "no connection to a professional or commercial activity" phrase is sometimes misread as making
non-commercial the test. It is not: it is a *further* restriction on an activity that must
*already* be purely personal or household. Being unpaid does not make a public service a household
activity. If anything the hobby framing hurts, because it removes any professional justification
from the legitimate-interests balancing in §5.

The CJEU decided the point directly in **Lindqvist (C-101/01, 6 November 2003)**, holding that the
exemption covers

> "only ... activities which are carried out in the course of private or family life of individuals,
> which is **clearly not the case with the processing of personal data consisting in publication on
> the internet so that those data are made accessible to an indefinite number of people**."

*Ryneš* (C-212/13, 11 December 2014) applied the same restrictive approach to a domestic CCTV camera
that captured a public footpath: even a genuinely household purpose loses the exemption once the
processing reaches beyond the private sphere. Both are assimilated case law under the Retained EU Law
(Revocation and Reform) Act 2023 rather than binding precedent, and this note did not verify whether
any UK court has departed from *Lindqvist* — but the ICO's guidance is built on the same reading, and
Recital 18 says the same thing in the statute itself, so nothing turns on the case law here.

**Conclusion:** do not rely on this. The expectation in the ticket was correct, and the answer is
clear enough that arguing it would damage credibility on the points that are genuinely arguable.

### 3.3 The special-purposes (journalism/academic) exemption is a stretch, but is the only shelter of its kind

This is the one exemption worth taking seriously, because it is broad where it applies. DPA 2018
Schedule 2, Part 5, paragraph 26 disapplies a long list of provisions — including Article 5(1)(a)
to (e), **Article 6 (lawfulness) in its entirety**, Articles 14(1)–(4), 15, 16, 17(1) and (2), and
21(1) — for processing for "the special purposes".

> "(2) Sub-paragraph (3) applies to the processing of personal data carried out for the special
> purposes if— (a) the processing is being carried out with a view to the publication by a person
> of journalistic, academic, artistic or literary material, and (b) the controller reasonably
> believes that the publication of the material would be in the public interest.
>
> (3) The listed GDPR provisions do not apply to the extent that the controller reasonably
> believes that the application of those provisions would be incompatible with the special
> purposes.
>
> (4) In determining whether publication would be in the public interest the controller must take
> into account the special importance of the public interest in the freedom of expression and
> information.
>
> (5) In determining whether it is reasonable to believe that publication would be in the public
> interest, the controller must have regard to any of the codes of practice or guidelines listed
> in sub-paragraph (6) that is relevant to the publication in question.
>
> (6) The codes of practice and guidelines are— (a) BBC Editorial Guidelines; (b) Ofcom
> Broadcasting Code; (c) Editors' Code of Practice."
>
> — DPA 2018 Sch. 2 para. 26,
> <https://www.legislation.gov.uk/ukpga/2018/12/schedule/2/paragraph/26>, retrieved 2026-08-06

**The standing question is not the obstacle.** It is tempting to dismiss this on the basis that a
hobbyist is not a journalist. The ICO's statutory **Data protection and journalism code of practice**,
which came into force on 22 February 2024 and which courts and the Commissioner must take into
account under DPA 2018 s.124, says otherwise:

> "13.9 Data protection law does not define journalism, so you should interpret it broadly in line
> with its everyday meaning and purpose."
>
> "13.11 However, **journalism is not limited to professional journalists and media organisations. For
> example, members of the public may carry out journalism, typically online. This is sometimes known
> as 'citizen journalism'.**"
>
> — ICO, Data protection and journalism code of practice,
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-and-journalism-code-of-practice/>,
> in force 22 February 2024, retrieved 2026-08-06

The CJEU takes the same view: in *Buividas* (C-345/17, 14 February 2019) it held that video recording
by a private individual, published on a video website, "**may constitute a processing of personal data
solely for journalistic purposes** ... in so far as it is apparent from that video that the sole
object of that recording and publication thereof is the disclosure of information, opinions or ideas
to the public".

So the door is open on *who*. It closes on *what* and *why*. The code sets four cumulative conditions
(para 13.4): use personal information for a journalistic purpose; act with a view to the publication
of journalistic material; reasonably believe publication would be in the public interest; and
reasonably believe that complying with a part of data protection law would be incompatible with that
purpose. And para 13.16: "You should ... be able to justify your view so that another reasonable
person would consider that it is **objectively reasonable**."

**Assess the rest sceptically, because the sceptical answer is the right one.** Every remaining limb
is a problem:

- **"Journalistic, academic, artistic or literary material."** SlashWho publishes a database, not
  material. There is no reporting, no commentary, no analysis, no authorship — the output is a
  machine-generated list. "Academic purposes" would require research framing that does not exist,
  and Article 4(2)–(5) of the UK GDPR (as amended) now defines scientific and statistical purposes
  restrictively; note in particular that Article 4(5) says processing is for statistical purposes
  only where "the information that results from the processing is **aggregate data that is not
  personal data**". Per-character published linkage is the opposite of that.
- **"Reasonably believes that the publication would be in the public interest."** This is an
  objective reasonableness standard, not a sincere belief standard. There is a public interest in
  detecting gold-selling, harassment evasion or ban evasion — but SlashWho publishes
  indiscriminately, for every character searched, not selectively where a public interest arises.
  A blanket practice is very hard to justify by reference to interests that arise in a minority of
  cases.
- **Sub-paragraph (5)** requires regard to the BBC Editorial Guidelines, the Ofcom Broadcasting
  Code, or the Editors' Code. All three are journalistic ethics codes containing privacy
  provisions that a mass de-anonymisation database would fail. Having to consult them is itself a
  signal about the kind of activity the exemption contemplates.
- The exemption operates "**to the extent that**" the controller reasonably believes compliance
  would be incompatible with the special purposes. It is not a blanket switch; it must be
  justified provision by provision — and, the ICO says, "Exemptions should not routinely be relied
  upon or applied in a blanket fashion. You must consider each exemption on a **case-by-case
  basis**." A service processing every character searched cannot form a per-subject reasonable
  belief, which is what the provision demands.
- There is a cautionary precedent. Sweden's IMY fined the people-search site Mrkoll.se €35,000 on 16
  December 2019 notwithstanding its constitutional publication certificate (*utgivningsbevis*),
  because the activity was characterised as credit reporting rather than as publishing
  (<https://www.imy.se/om-oss/arkiv/nyhetsarkiv/sanktionsavgift-pa-35-000-euro-mot-sajten-mrkoll/>,
  retrieved 2026-08-06). **A freedom-of-expression shelter is defeated by characterising the activity
  as something other than journalism** — which is exactly the argument a regulator would make about a
  lookup API.

**Position:** this is not a viable route for the service as designed. It is worth putting to a
solicitor (§13 Q6) only because it is the only mechanism in UK law that would disapply Article 6
altogether, and because a *narrower, selective, editorialised* product might one day reach it. The
current design does not.

### 3.4 EU GDPR applies in parallel

UK GDPR Article 3 was rewritten on exit to substitute "the United Kingdom" for "the Union"
throughout, so the UK version's extraterritorial arm (Article 3(2)) reaches non-UK controllers
processing data about people **in the UK**. It says nothing about EU data subjects. For those, the
**EU** GDPR applies on its own terms, and its Article 3(2) is the mirror image:

> "2. This Regulation applies to the processing of personal data of data subjects who are in the
> Union by a controller or processor not established in the Union, where the processing activities
> are related to: (a) the offering of goods or services, irrespective of whether a payment of the
> data subject is required, to such data subjects in the Union; or (b) the monitoring of their
> behaviour as far as their behaviour takes place within the Union."

Both limbs are arguable and (b) is now dangerous.

**(a) Offering services.** "Irrespective of whether a payment ... is required" disposes of the "it's
free" objection. Recital 23 requires evidence that the controller "envisages offering services" to
people in the Union, and lists indicators such as language and currency. A global English-language
site about a game with large EU realm populations, which accepts and publishes data about EU
characters and exposes EU realms explicitly, is at least arguable. Not certain, but arguable.

**(b) Monitoring behaviour.** Recital 24 explains the test:

> "In order to determine whether a processing activity can be considered to monitor the behaviour of
> data subjects, it should be ascertained whether natural persons are tracked on the internet
> including potential subsequent use of personal data processing techniques which consist of
> profiling a natural person, particularly in order to take decisions concerning her or him or for
> analysing or predicting her or his personal preferences, behaviours and attitudes."
>
> — UK GDPR Recital 24, <https://www.legislation.gov.uk/eur/2016/679/introduction>, retrieved 2026-08-06
> (the EU recital is identical save for "the Union")

**And this limb has just been construed very broadly by a UK court.** In *Information Commissioner v
Clearview AI Inc* the Upper Tribunal, on 6 October 2025, set aside the First-tier Tribunal's 2023
jurisdiction ruling and held:

> "the words 'behavioural monitoring' in Article 3(2)(b) GDPR are to be interpreted broadly, as a
> response to the challenges posed by 'Big Data' in the digital age, and they **can encompass passive
> collection, sorting, classification and storing of data by automated means with a view to potential
> subsequent use, including use by another controller, of personal data processing techniques which
> consist of profiling a natural person. 'Behavioural monitoring' does not require an element of
> active 'watchfulness' in the sense of human involvement**; and ... the words 'related to' in Article
> 3(2) ... have an expansive meaning, and apply not only to controllers who themselves conduct
> behavioural monitoring, but also to controllers whose data processing is related to behavioural
> monitoring carried out by another controller."
>
> — *ICO v Clearview AI Inc (Privacy International intervening)* [2025] UKUT 319 (AAC),
> UA-2024-001563-GIA, 6 October 2025,
> <https://caselaw.nationalarchives.gov.uk/ukut/aac/2025/319>, retrieved 2026-08-06 (emphasis added)

The Tribunal also held that the FTT "erred materially in law in finding that the Respondent's
processing was outside the material scope of the GDPRs by operation of Article 2(2)(a)" — the
household/out-of-scope exclusion. Clearview obtained permission to appeal to the Court of Appeal on
19 December 2025, and this note did not find any Court of Appeal listing or judgment as at 6 August
2026, nor any FTT decision on the remitted merits. **Treat the UT decision as the current UK
authority, subject to appeal.**

Be precise about what Clearview decides and does not. The FTT and UT both ruled only on
**jurisdiction**. Neither has ruled on lawful basis, fairness, transparency, Article 14 or penalty
quantum; the merits are remitted and undecided. But on jurisdiction the reasoning is directly
transferable: passive automated collection, sorting and classification of behavioural data, with no
human watchfulness, counts as monitoring. Achievement-timestamp comparison is exactly that.

**Consequences if the EU GDPR applies in parallel:**

- Article 27 requires a representative in the Union, in writing, unless the Article 27(2)(a)
  derogation applies — processing that is "occasional, does not include, on a large scale, processing
  of special categories of data ... and is unlikely to result in a risk to the rights and freedoms of
  natural persons". SlashWho's processing is **not occasional** (it is the product) and the whole of
  §5 and §8 concludes it **is** likely to result in risk. The derogation is therefore probably
  unavailable, and appointing an EU representative is a real cost for a hobby project.
- This is not a theoretical exposure. The Dutch DPA fined **Locatefamily.com €525,000 on 12 May 2021**
  — a people-search site publishing addresses of around 700,000 Dutch residents who "did not provide
  the site with their information" — **for failing to appoint an Article 27 representative**, not for
  the publication itself
  (<https://www.autoriteitpersoonsgegevens.nl/en/current/dutch-dpa-imposes-fine-of-eu525000-on-locatefamilycom>,
  retrieved 2026-08-06). That is the tactical lesson: where the substantive case is hard, a
  supervisory authority can reach a non-EU aggregator through the procedural route. Article 27 is the
  cheapest thing to get wrong and the easiest thing for a regulator to prove.
- EU supervisory authorities would each have jurisdiction over their own residents; with no EU
  establishment there is no one-stop-shop lead authority to consolidate complaints.

**Honest assessment:** whether the EU GDPR applies is genuinely uncertain and turns on facts about
who uses the site. The practical answer is that it does not much matter for design, because the UK
GDPR applies to everything anyway (§3.1) and imposes essentially the same obligations. Where it does
matter is **Article 27**, which is a UK-GDPR-free obligation that would otherwise be missed. That is
§13 Q10.



### 3.5 The ICO fee, and a side effect worth knowing about

> "Under the Data Protection (Charges and Information) Regulations 2018, organisations (including
> sole traders) that use personal information need to pay a data protection fee, unless they are
> exempt."
>
> — ICO, <https://ico.org.uk/for-organisations/data-protection-fee/>, retrieved 2026-08-06

The tier-1 ("micro organisations") fee is **£52** per year, reduced by £5 for direct debit, under
regulation 3(1)(a) as substituted by S.I. 2025/63 with effect from 17 February 2025
(<https://www.legislation.gov.uk/uksi/2018/480/regulation/3>, retrieved 2026-08-06). The cost is
trivial. The side effect may not be:

> "(3) Within the first 21 days of each charge period a data controller must provide to the
> Information Commissioner the following information ... (a) the name and address of the data
> controller ... (5) For the purposes of paragraph (3)(a) ... (b) the address of a person (other
> than a registered company) is that of the person's principal place of business in the UK."
>
> — S.I. 2018/480 reg. 2, <https://www.legislation.gov.uk/uksi/2018/480/regulation/2>, retrieved 2026-08-06

For an individual operating from home with no business premises, "principal place of business" is
their home address, and the ICO maintains a public register of controllers. **An operator
publishing other people's linkages may find their own name and home address published in
consequence.** That is a real consideration for someone whose service will attract angry
correspondence, and it interacts badly with §6.3's requirement to publish contact details anyway.

**There is, however, a genuinely arguable exemption — and it is broader than expected.** The
Schedule to S.I. 2018/480 exempts processing:

> "(b) undertaken by a data controller for the purposes of their **personal, family or household
> affairs, including— (i) the processing of personal data for recreational purposes**, and (ii) the
> capturing of images, in a public space, containing personal data"
>
> — S.I. 2018/480, Schedule, para. 2(2)(b),
> <https://www.legislation.gov.uk/uksi/2018/480/schedule/paragraph/2>, retrieved 2026-08-06 (emphasis added)

The ICO's gloss goes further than the statute:

> "Individuals are exempt from paying a fee if the only information they process is for personal,
> family or household affairs that have no connection to any commercial or professional activity.
> **'Personal, family or household affairs' includes recreational activities** ... Examples include
> holding a personal address list; **social networking and online activity, including blogging (as
> long as this is done in a purely personal capacity and you do not use the blog to endorse or
> promote businesses, services or products)**; ... and **personal information held in connection with
> a hobby**"
>
> — ICO, "Activities of households sector",
> <https://ico.org.uk/for-organisations/data-protection-fee/paying-a-data-protection-fee-what-do-you-need-to-know/activities-of-households-sector/>,
> retrieved 2026-08-06 (emphasis added)

Three cautions, and the third is the important one:

1. The exemption applies **only if the processing is exclusively for exempt purposes**. Any
   advertising, sponsorship, affiliate link or promotional donation collapses it.
2. ICO defaults everyone to tier 3 until told otherwise: "**We regard all controllers as eligible to
   pay a fee in tier 3 unless and until they tell us otherwise**"
   (<https://ico.org.uk/for-organisations/data-protection-fee/data-protection-fee/>, retrieved
   2026-08-06). Silence is not neutral.
3. **This is an exemption from the fee, not from the law**, and the two must not be confused. ICO is
   explicit: "even if you are exempt from paying a fee, **you still need to comply with your other
   data protection obligations**." The fee exemption uses similar words to the UK GDPR Article 2(2)(a)
   household exemption in §3.2 but is a different and much wider provision. Qualifying for the £52
   exemption tells you nothing about whether the UK GDPR applies — it does, per §3.2.

**Practical recommendation:** pay the £52. The exemption is arguable, the amount is trivial, ICO
treats non-registrants as tier 3 by default, and claiming an exemption invites a correspondence about
the nature of the activity that this project does not want to have. The home-address problem is real
and is §13 Q7.

---

## 4. Controller status, and what the Blizzard CCPA clause has to do with it

The ToU (sibling note #5, §1.2) states that "Blizzard and You agree that you are a Service Provider
pursuant to the California Consumer Privacy Act", and forbids doing anything "that would change
your status under the CCPA from being a Service Provider to being a Purchaser of the Blizzard
Data". The ToU is silent on GDPR roles.

That silence does not create ambiguity about the GDPR position. Roles under the UK GDPR are
determined by the facts, not by contractual labels:

> "'controller' means the natural or legal person, public authority, agency or other body which,
> alone or jointly with others, **determines the purposes and means** of the processing of personal
> data"
>
> — UK GDPR Article 4(7), retrieved 2026-08-06 (emphasis added)

SlashWho decides that the linkage should be computed, decides how (achievement-timestamp
comparison), decides that it should be published permanently, and decides the suppression policy.
Blizzard instructs none of it and derives no benefit from it. **SlashWho is a controller in its own
right** for the inference, whatever the ToU says about CCPA status.

The two questions then interlock unhelpfully:

- Being a GDPR controller does not by itself breach the CCPA clause — the regimes have different
  taxonomies, and CCPA "service provider" and GDPR "processor" are not the same concept.
- But the *facts* that make SlashWho a GDPR controller — own purpose, own novel output, publication
  for its own ends rather than the discloser's — are the same facts that a CCPA analysis would
  weigh. It is difficult to be an independent controller under one regime for exactly this
  processing while remaining a service provider under the other.

**On the CCPA question the ticket raises, two findings, and the second is the more useful.**

*First, the substance: publishing the inference does take a recipient outside Service Provider
status.* The current definition (Cal. Civ. Code § 1798.140(ag)(1), as amended by Stats. 2025, Ch. 67,
Sec. 27 (AB 1170), effective 1 January 2026,
<https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1798.140>,
retrieved 2026-08-06) requires the contract to prohibit the recipient from:

> "(B) Retaining, using, or disclosing the personal information for any purpose other than for the
> business purposes specified in the contract for the business, **including retaining, using, or
> disclosing the personal information for a commercial purpose other than the business purposes
> specified in the contract** with the business ...
>
> (C) Retaining, using, or disclosing the information **outside of the direct business relationship**
> between the service provider and the business.
>
> (D) **Combining the personal information that the service provider receives from, or on behalf of,
> the business with personal information that it receives from, or on behalf of, another person or
> persons, or collects from its own interaction with the consumer** ..."

Limb (C) is the cleanest basis: publishing to the open web is the paradigm of disclosing information
"outside of the direct business relationship". The implementing regulations reinforce it — 11 CCR
§ 7050(a)(3) permits internal use only "to build or improve the quality of **the services it is
providing to the business**", and § 7051(a)(4) requires the contract to prohibit "**combining or
updating personal information that it collected pursuant to the written contract with the business
with personal information that it received from another source**". (Note the operative version is the
CPPA's consolidated regulations effective 1 January 2026; the § 7051(a) paragraphs were renumbered,
so anything citing § 7051(a)(5) from a pre-2026 source is now citing the wrong paragraph.)

Note also that § 1798.140(v)(1)(K) expressly includes "**inferences** drawn from any of the
information identified in this subdivision to create a profile about a consumer" within "personal
information". Deriving the linkage does not take it outside the definition; it puts it squarely
inside.

The consequence is spelled out in the regulations. 11 CCR § 7050(e): "A person who does not have a
contract that complies with section 7051, subsection (a), **is not a service provider or a contractor
under the CCPA** ... a business's disclosure of personal information to [such] a person ... **may be
considered a sale or sharing of personal information** for which the business must provide the
consumer with the right to opt-out". And § 7050(d): such a person "shall comply with the CCPA ... with
regard to any personal information that it collects, maintains, or sells **outside of its role as a
service provider**". In other words, acting outside the role does not just breach a covenant — it
converts the operator into a third party and creates a compliance problem for **Blizzard**, which is
precisely why the ToU forbids it.

*Second, and more useful for deciding what to do: the CCPA almost certainly does not bind SlashWho
statutorily at all.* "Business" under § 1798.140(d)(1) requires an entity "organized or operated for
the profit or financial benefit of its shareholders or other owners ... that does business in the
State of California", plus a threshold: gross revenues above the inflation-adjusted $26,625,000, or
buying/selling/sharing the personal information of 100,000+ consumers or households, or 50%+ of
revenue from selling or sharing personal information. **A non-commercial UK hobby project fails the
for-profit chapeau before reaching any threshold.**

**So the CCPA constrains SlashWho contractually, not statutorily** — through the ToU covenant, which
is enforceable by Blizzard rather than by the California Privacy Protection Agency. That reframes the
risk usefully: the realistic CCPA consequence is not a Californian regulator, it is **Blizzard
terminating access under ToU §11 and invoking the indemnity under ToU §6**. Which is a real risk, and
one this project can actually do something about — by asking Blizzard first, as sibling note #5 §5
recommends.

One caveat on the source: the Blizzard Developer API Terms of Use is still dated "Last updated October
1, 2019". Its CCPA framing therefore predates the CPRA amendments and the current regulations
entirely. Nobody at Blizzard has revisited this clause in the light of what the CCPA now says.


The practical consequence is the one flagged in sibling note #5 §4.7 and now confirmed: the
compliance burden lands entirely on the operator, and the ToU's uncapped indemnity (ToU §6) means
a third-party complaint carries Blizzard's costs too.

---

## 5. Lawful basis

Article 6(1) is a closed list. Processing without one is unlawful full stop — and the DUAA added a
paragraph to Article 5 making a related point explicit:

> "3. For the avoidance of doubt, processing is not lawful by virtue only of being processing in a
> manner that is compatible with the purposes for which the personal data was collected."
>
> — UK GDPR Article 5(3), retrieved 2026-08-06

### 5.1 Five of the seven bases are unavailable in a sentence each

- **6(1)(a) consent** — requires "any freely given, specific, informed and unambiguous indication
  of the data subject's wishes by which he or she, by a statement or by a clear affirmative
  action, signifies agreement" (Article 4(11)). SlashWho has no relationship with its data
  subjects, no contact route, and processes them precisely *because* they have not agreed. Consent
  is structurally impossible, not merely inconvenient. It is worth stating plainly that the class
  of subject this feature specifically targets — the player who hid the link — is the class that
  has most clearly not consented.
- **6(1)(b) contract** — no contract with the data subject.
- **6(1)(c) legal obligation** — none.
- **6(1)(d) vital interests** — no.
- **6(1)(e) public task** — must "be laid down by domestic law" (Article 6(3)); none exists.

### 5.2 The new "recognised legitimate interest" basis does not apply

Article 6(1)(ea) is the DUAA's addition, and Article 6(5) confines it: "processing is necessary for
the purposes of a recognised legitimate interest only if it meets a condition in Annex 1." Annex 1
is short and exhaustive. Its conditions are:

> "1 Disclosure for purposes of processing described in Article 6(1)(e) ... 2 National security,
> public security and defence ... 3 Emergencies ... 5 Crime ... 6 Safeguarding vulnerable
> individuals"
>
> — UK GDPR Annex 1, <https://www.legislation.gov.uk/eur/2016/679/annex/1>, retrieved 2026-08-06

None applies. The "Crime" condition (necessary "for the purposes of detecting, investigating or
preventing crime, or apprehending or prosecuting offenders") is the only one within sight, and it
is not within reach: SlashWho publishes indiscriminately about all players, not selectively in aid
of a criminal investigation, and in-game rule-breaking is not crime. Worth noting because the
DUAA's new basis will be cited hopefully by people who have not read Annex 1.

### 5.3 So the only candidate is Article 6(1)(f), legitimate interests

> "(f) processing is necessary for the purposes of the legitimate interests pursued by the
> controller or by a third party, except where such interests are overridden by the interests or
> fundamental rights and freedoms of the data subject which require protection of personal data, in
> particular where the data subject is a child."
>
> — UK GDPR Article 6(1)(f), retrieved 2026-08-06

The ICO's current (23 March 2026) framing of the test:

> "Legitimate interests can be broken down into a three-part test: **Purpose test:** Are you
> pursuing a legitimate interest? **Necessity test:** Is your use of personal information necessary
> for that purpose? **Balancing test:** Do the person's interests override the legitimate interest?"
>
> — ICO, "Legitimate interests",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/a-guide-to-lawful-basis/legitimate-interests/>,
> last updated 23 March 2026, retrieved 2026-08-06

Note the burden: Article 6(1)(f) is the only basis with a built-in override, and Article 5(2)
accountability puts the onus on the controller to demonstrate it was satisfied.

#### Purpose test — passable

The interest need not be weighty. The ICO: "A wide range of interests can be legitimate interests
... Legitimate interests may be compelling or trivial. But the balancing test may override trivial
interests more easily." Interests plausibly available to SlashWho: helping players find friends and
guildmates across alts; transparency in a competitive scene; identifying accounts that evade guild
bans or harassment blocks by rerolling.

The sting is in the ICO's last purpose-test question: "**Would your use of that information be
unethical or unlawful in any way?**" The feature's defining characteristic is that it defeats a
choice the player made. That question cannot be answered comfortably, and it is asked at the
*purpose* stage, before the balancing even begins.

The interest also has to be stated honestly. "It is interesting" and "it is technically possible"
are not interests. Nor, on the ICO's framing, is the operator's curiosity likely to weigh much
against a countervailing privacy interest.

#### Necessity test — this is where it starts to fail

> "'Necessary' means that you must use the personal information in a targeted and proportionate way
> to achieve your purpose. **You can't rely on legitimate interests if you have another reasonable
> and less intrusive way to achieve the same result.**"
>
> — same page (emphasis added)

There are obvious less intrusive alternatives that achieve most of the stated benefit:

- Publish only linkages the player has **already published themselves** on Raider.IO — which is
  exactly what SlashWho does today, before this feature. The existence of the current product is
  itself evidence that a less intrusive means achieves much of the purpose.
- Compute the fingerprint but require the player's own Battle.net OAuth to reveal it — Blizzard's
  own design for this (the protected profile endpoints, and Real ID) is consent-gated, per sibling
  note #5 §4.6.
- Show the inference privately to the searching user without publishing a permanent page.
- Publish an opt-in directory.

The necessity test does not ask whether the alternative is as *good*; it asks whether it is
reasonable and less intrusive. Several are. **Necessity is the weakest link in the chain for the
publication step specifically**, and it is weakest of all for publishing linkages the player
suppressed — because for exactly those players, the "less intrusive way" is the status quo.

#### Balancing test — where the deliberate-concealment fact is decisive

The regulation's own steer:

> "The legitimate interests of a controller ... may provide a legal basis for processing, provided
> that the interests or the fundamental rights and freedoms of the data subject are not overriding,
> taking into consideration the reasonable expectations of data subjects based on their
> relationship with the controller. ... At any rate the existence of a legitimate interest would
> need careful assessment including whether a data subject can reasonably expect at the time and in
> the context of the collection of the personal data that processing for that purpose may take
> place. **The interests and fundamental rights of the data subject could in particular override the
> interest of the data controller where personal data are processed in circumstances where data
> subjects do not reasonably expect further processing.**"
>
> — UK GDPR Recital 47, retrieved 2026-08-06 (emphasis added)

And the ICO:

> "You must balance your interests against those of the person whose information you want to use.
> Their interests are likely to override yours if: they wouldn't reasonably expect you to use their
> information; or you would cause them unwarranted harm by using it."
>
> — ICO, "Legitimate interests", retrieved 2026-08-06

The ICO's detailed guidance sets out how the expectations question is asked, and the test is
objective rather than empirical:

> "You must consider whether people will reasonably expect you to use their information in this way
> in the particular circumstances. You should consider all relevant factors, including the following:
> Do you have an existing relationship with that person? If so, what is the nature of that
> relationship? ... **Did you collect the information directly from that person?** What did you tell
> them at the time? If you obtained the information from another source, what did they tell people
> about the reuse of their information by third parties for other purposes? ... **Is what you want to
> do and how you want to do it obvious or widely understood? Are you intending to do anything new or
> innovative?**"
>
> "This is an objective test. You don't have to show that every person does, in fact, expect you to
> use their information in this way. Instead, **you should show that a reasonable person would expect
> the processing in the particular circumstances.**"
>
> — ICO, "How do we apply legitimate interests in practice?",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/legitimate-interests/how-do-we-apply-legitimate-interests-in-practice/>,
> retrieved 2026-08-06 (emphasis added)

Every prompt in that list is answered adversely: no relationship; not collected from the subject;
nothing told to them at the time; Blizzard told them their data would go to developers building
things that "benefit our player community", not that a novel linkage would be published; the
technique is not widely understood; and it is expressly new. The guidance also contains an escalation
clause: "If you identify the potential for a high risk to people, **you must have a more compelling
legitimate interest** to satisfy the balancing test ... **This also triggers the need to do a DPIA**."

**The ticket's central fact resolves this, and resolves it against us.** Recital 47 anchors
reasonable expectations in the data subject's *relationship with the controller*. Here there is no
relationship at all — the subject has never heard of SlashWho. That alone weighs against. But the
feature goes further: it targets a population who have taken a **positive, documented step to
prevent exactly this disclosure**. A player who hid their alts on Raider.IO has not merely failed
to expect the processing; they have demonstrably expected and intended the opposite. This is the
strongest possible form of the "does not reasonably expect" finding, and it is evidenced rather
than inferred — the hidden flag is a record of the subject's own contrary expectation.

Working through the ICO's balancing prompts in order:

| ICO prompt | SlashWho |
| --- | --- |
| What's the nature of your relationship with the person? | None. They are strangers who did not choose the service. |
| Is any of the information particularly sensitive or private? | The linkage is not special category data, but it is information the subject actively concealed. Concealment is evidence of subjective privacy expectation. |
| Are you happy to explain your use of the information to them? | The service cannot contact them at all (§6). That is itself an answer. |
| Are some people likely to object or find it intrusive? | Yes, demonstrably — the suppressed-link population *is* the objecting population, identified in advance. |
| What's the possible impact? | Deanonymisation across alts; exposure of characters kept separate from a main identity; loss of a refuge from harassment; outing of alts kept private for reasons the operator cannot see. |
| How big an impact might it have? | Potentially severe for a minority, and the operator has no way to know which minority. |
| Are you using children's information? | Unknown and unknowable. WoW has minor players; Article 6(1)(f) singles out children as a group whose interests weigh more heavily; SlashWho cannot identify or exclude them. This is an unmanaged risk, not a small one. |
| Are any of the people at increased risk of harm? | Unknowable, and the population most likely to hide alts overlaps with the population avoiding a harasser or a stalker. |
| Are there safeguards to minimise impact? | Suppression on request — but reactive, post-publication, and via the channel criticised in §7.4. |
| Can you collect less, or let them opt out? | Yes — see the necessity alternatives above. That this is possible is itself adverse. |

Every prompt points the same way for the concealed-link cohort. The ICO's own summary of when the
basis is inapt is uncomfortably on the nose:

> "**Legitimate interests is often not appropriate for using personal information in a way which is
> unexpected or high risk.**"
>
> — same page (emphasis added)

The processing is unexpected by construction and high risk on the ICO's own DPIA criteria (§8). Its
detailed guidance is more pointed still, and one item is essentially a description of this project:

> "You should avoid using legitimate interests where: you want to use personal information in ways
> people don't understand and wouldn't reasonably expect; **you think some people would object if you
> explain to them what you want to do with their information** ..."
>
> — ICO, "When can we rely on legitimate interests?",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/legitimate-interests/when-can-we-rely-on-legitimate-interests/>,
> retrieved 2026-08-06 (emphasis added)

There is no honest way to answer that question "no". The concealed-link cohort has already objected,
in advance, by conduct.

### 5.4 The balance differs across the three acts — and that is the design lever

This is where separating create/store/publish earns its keep. The Article 6(1)(f) analysis is not
one analysis but three, and they do not come out the same way:

- **Creating** the inference, transiently, to answer a specific user's query: the most defensible.
  Limited retention, limited audience, closest analogy to a search tool. Still requires a basis and
  still requires transparency, but the balancing is genuinely arguable.
- **Storing** it: harder, and directly constrained by the Blizzard 30-day TTL (sibling #5 §3.1) and
  by Article 5(1)(e) storage limitation. Defensible with a short retention period and revalidation;
  not defensible as a permanent record.
- **Publishing** it on permanent, crawlable, dated pages: the weakest by a wide margin. It maximises
  the interference (unbounded audience, indefinite duration, search-engine amplification,
  third-party archiving), it fails necessity most clearly, and it is the step that makes the
  processing effectively irreversible (§7.5). It is also the step that puts the operator outside
  anything Blizzard's ToU contemplates.

**The single most useful thing this analysis says for product decisions:** the legal risk is
concentrated overwhelmingly in the *publication* of the *inferred* (as opposed to
player-published) linkage, and it can be reduced by orders of magnitude without abandoning the
fingerprint. A design that computes the fingerprint but does not publish inferred-only edges — or
publishes them only where the player has not suppressed the link upstream — sits in a materially
different legal position from the one the ticket describes.

### 5.5 A note on the "it was already public" argument

The inputs are public. That does not carry the conclusion, for three reasons:

- Publicly available personal data is still personal data; the UK GDPR contains no public-source
  exemption. Article 14(2)(f) assumes the opposite, requiring a controller to disclose "from which
  source the personal data originate, and if applicable, **whether it came from publicly accessible
  sources**" — the drafters contemplated public sources and imposed obligations rather than
  removing them.
- The *linkage* was never public. It is new information, which is the ticket's own framing and
  which cuts against us here.
- Purpose limitation (Article 5(1)(b)) requires data collected for one purpose not be further
  processed incompatibly. Blizzard disclosed game data for "applications and websites that benefit
  our player community" (sibling #5 §4.6). Whether defeating a player's privacy choice is
  compatible with that purpose is, at best, unsettled.

---

## 6. Transparency when you cannot contact your data subjects

The data does not come from the data subject, so Article 14 governs, and Article 14 is demanding.

### 6.1 What Article 14 requires

> "1. Where personal data have not been obtained from the data subject, the controller shall
> provide the data subject with the following information: (a) the identity and the contact details
> of the controller ...; (c) the purposes of the processing for which the personal data are
> intended as well as the legal basis for the processing; (d) the categories of personal data
> concerned; (e) the recipients or categories of recipients of the personal data, if any; ...
>
> 2. In addition ...: (a) the period for which the personal data will be stored, or if that is not
> possible, the criteria used to determine that period; (b) where the processing is based on point
> (f) of Article 6(1), the legitimate interests pursued by the controller or by a third party; (c)
> the existence of the right to request from the controller access to and rectification or erasure
> of personal data or restriction of processing concerning the data subject and to object to
> processing as well as the right to data portability; ... (da) the right to make a complaint to
> the controller (see section 164A of the 2018 Act); (e) the right to make a complaint to the
> Commissioner under section 165 of the 2018 Act; (f) **from which source the personal data
> originate, and if applicable, whether it came from publicly accessible sources**; (g) the
> existence of automated decision-making, including profiling ...
>
> 3. The controller shall provide the information referred to in paragraphs 1 and 2: (a) within a
> reasonable period after obtaining the personal data, but **at the latest within one month** ...;
> (c) if a disclosure to another recipient is envisaged, at the latest when the personal data are
> first disclosed."
>
> — UK GDPR Article 14, <https://www.legislation.gov.uk/eur/2016/679/article/14>, retrieved 2026-08-06 (emphasis added)

Article 14(2)(da) is new (DUAA) and matters: the notice must now advertise a **complaint route to
the controller itself**, not only to the ICO. See §7.4.

### 6.2 The disproportionate-effort exemption, as amended

The DUAA rewrote Article 14(5) and added two paragraphs. The current text:

> "5. Paragraphs 1 to 4 [do not apply to the extent that]: (a) the data subject already has the
> information; ... **(e) providing the information is impossible or would involve a disproportionate
> effort, or (f) the obligation referred to in paragraph 1 is likely to render impossible or
> seriously impair the achievement of the objectives of the processing for which the personal data
> are intended.**
>
> 6. For the purposes of paragraph 5(e), whether providing the information would involve a
> disproportionate effort depends on, among other things, **the number of data subjects, the age of
> the personal data and any appropriate safeguards applied to the processing**.
>
> 7. A controller relying on paragraph 5(e) or (f) **must take appropriate measures to protect the
> data subject's rights, freedoms and legitimate interests, including by making the information
> available publicly**."
>
> — UK GDPR Article 14(5)–(7), retrieved 2026-08-06 (emphasis added)

This is the most helpful finding in the note for practical purposes, and it needs care in both
directions.

**It helps.** SlashWho genuinely cannot contact its data subjects: it has no email address, no
account, no in-game messaging route, and no lawful way to obtain one. That is not
"disproportionate effort", it is **impossible**, which paragraph 5(e) covers expressly and on
easier terms. Paragraph 14(6) then makes "the number of data subjects" and "appropriate
safeguards" relevant factors, both of which point our way at scale.

The ICO's guidance on the exception frames it in terms that fit and do not fit in equal measure:

> "**There is no automatic exception from the right to be informed just because the personal data is
> in the public domain.** You should still provide privacy information to individuals, unless you can
> rely on a specific exception or exemption."
>
> "Situations in which it is impossible to provide privacy information to individuals are few and far
> between. **This is most likely to occur if you do not have any contact details for individuals and
> have no reasonable means to obtain them.**"
>
> "To rely on this exception, you must make (and document) an assessment of whether there is a
> proportionate balance between the effort involved for you to provide individuals with privacy
> information and **the effect that your use of their personal data will have on them. The more
> significant the effect, the less likely you will be able to rely on this exception.**"
>
> "**This is an exception to the general obligation of transparency, and should be treated as the
> exception, not the rule.** You should not use it to routinely escape your obligations to inform
> individuals about your use of their data."
>
> — ICO, "Are there any exceptions?",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/are-there-any-exceptions/>,
> retrieved 2026-08-06 (emphasis added)

And there is a passage in the ICO's transparency guidance that describes this feature so closely it
could have been written for it:

> "**Organisations sometimes obtain information from publicly accessible sources in order to combine,
> match or add to information that they already hold on an individual ... This can be particularly
> intrusive, and unexpected, as it can create a very detailed picture of an individual's affairs. If
> you intend to do this, you need to tell people about it ... This type of processing also requires
> you to carry out a DPIA, due to the high risks involved.**"
>
> — ICO, "What common issues might come up in practice?",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/what-common-issues-might-come-up-in-practice/>,
> retrieved 2026-08-06 (emphasis added)

Three things in one paragraph: the ICO regards this specific activity as "particularly intrusive, and
unexpected"; it says you must tell people; and it says it requires a DPIA. It should be quoted in
full in the DPIA, because a regulator reading a DPIA that omits it will draw a conclusion.

The second passage above is our paradigm case exactly. The third is the trap: the more significant the
effect on the data subject, the less available the exception — and the significance of the effect is
the whole reason this ticket exists. The two limbs pull against each other, and the operator cannot
have both "the impact is minor" (for the §5.3 balancing) and "the impact is significant" (nowhere).
Whichever is argued, it must be argued consistently.

**It does not help as much as it looks.** Four constraints:

1. **14(7) makes a public notice mandatory, not optional.** Relying on 5(e) *obliges* the operator
   to take appropriate measures "including by making the information available publicly". So the
   privacy notice stops being good practice and becomes the condition of the exemption. If the
   notice is inadequate, the exemption is not made out and the Article 14(1)–(2) duty revives in
   full — a duty that cannot be discharged.
2. **"Appropriate measures" is plural and is not satisfied by the notice alone.** Publication is
   named as an inclusion ("including by"), not as the whole. A controller relying on 5(e) is
   expected to do more — the natural candidates being a genuine objection route, short retention,
   and not indexing the pages.
3. **The impossibility is self-inflicted, and that is a live argument against us.** A controller
   cannot design a system that makes notice impossible and then rely on the impossibility. The
   safeguards limb of 14(6) is where a regulator would press.
4. **Relying on 5(e) triggers a mandatory DPIA.** The ICO's high-risk list defines "invisible
   processing" by reference to exactly this exemption — see §8. Claiming the exemption is an
   admission against interest for DPIA purposes.

Paragraph 5(f) — that notice would "seriously impair the achievement of the objectives of the
processing" — is a new UK-only exemption and should be treated with suspicion. Read broadly it
would swallow the rule (any covert processing is impaired by notice). It is untested. Do not build
on it.

### 6.3 What a compliant privacy notice would actually have to say

The current staging notice at <https://web-test-2855.up.railway.app/privacy> (retrieved 2026-08-06)
covers data sources, permanent snapshot retention, what is not stored, and a GitHub removal route.
Measured against Article 14 as amended it is **materially incomplete**. It would need, at minimum:

- **Identity and contact details of the controller** (14(1)(a)) — a real name or a real
  contactable identity, and an address for service. "The maintainer" is not compliance. This is the
  most uncomfortable requirement for a pseudonymous hobbyist and there is no way round it: a
  controller who will not identify themselves cannot run a lawful Article 14 notice.
- **The purposes and the legal basis** (14(1)(c)) — stated as legitimate interests, with **the
  interests themselves spelled out** (14(2)(b)). Not "to provide the service"; the actual interest.
- **Categories of personal data** (14(1)(d)) — including, explicitly, *the inferred account
  linkage itself* and the fact that it is derived rather than observed.
- **Recipients** (14(1)(e)) — that pages are public, indexable by search engines, served through a
  public API, and consequently may be copied and archived by third parties beyond the operator's
  control.
- **Retention** (14(2)(a)) — and here the current notice states the problem rather than solving it:
  "Refresh snapshots—both completed and partial—are retained permanently." Permanent retention has
  to be reconciled with Article 5(1)(e) and with the Blizzard 30-day TTL. As drafted the notice is
  an admission of two separate breaches.
- **Rights**, listed individually (14(2)(c)): access, rectification, erasure, restriction,
  objection, portability — with the objection right for Article 6(1)(f) processing given the
  prominence Article 21(4) requires.
- **The right to complain to the controller** under DPA 2018 s.164A (14(2)(da)) **and** to the ICO
  under s.165 (14(2)(e)). The current notice mentions neither.
- **The source** (14(2)(f)) — Raider.IO and the Blizzard API, and expressly that they are publicly
  accessible sources.
- **The existence of profiling / automated inference** and meaningful information about the logic
  (14(2)(g)) — i.e. an honest description of the achievement-timestamp fingerprint, its confidence,
  and its false-positive behaviour.
- **The upstream Blizzard opt-out**, explained accurately (§11), including that it is all-or-nothing
  across every community tool and takes up to 30 days.
- An explicit statement that the operator is relying on Article 14(5)(e) and why, since 14(7)
  conditions the exemption on the public notice.

There is an unavoidable tension worth naming: Article 12(1) requires all of this "in a concise,
transparent, intelligible and easily accessible form, using clear and plain language". The list
above is not concise. That tension is normal and is resolved by layering — a short top-level notice
with expandable detail — not by omitting items.

**A published notice does not make the processing visible.** The ICO says this in terms, and it is
worth quoting because it forecloses the obvious rejoinder:

> "The processing is 'invisible' because the individual is unaware that you are collecting and using
> their personal data, **even if you publish a privacy notice on your website**."
>
> — ICO, "When do we need to do a DPIA?", retrieved 2026-08-06 (emphasis added)

The ICO's own worked example of relying on the exception has a library publicising a digitisation
project *in a local newspaper* to direct people to the privacy information — i.e. actively pushing
the notice towards the affected population, not merely posting it. The analogue here would be
announcing the feature where WoW players actually are, before it ships.

**The deeper problem the notice cannot solve.** Article 14 assumes the data subject will *see* the
notice. SlashWho's data subjects have no reason ever to visit the site. A notice nobody reads
satisfies 14(7)'s literal requirement while achieving none of transparency's purpose, and a
regulator assessing "appropriate measures to protect the data subject's rights" would notice that.
The mitigation is to make the notice findable *from the page about the person* — a prominent link
on every character page, in the API responses, and in the page metadata — so that anyone who finds
the linkage also finds the notice and the objection route. That is cheap and should be treated as
mandatory rather than nice-to-have.

---

## 7. Rights, and whether SlashWho can honour them

### 7.1 The rights that attach

Because the basis is Article 6(1)(f), the data subject has access (Art 15), rectification (Art 16),
erasure (Art 17), restriction (Art 18) and objection (Art 21). Portability (Art 20) does not apply.

The objection right is the sharp one:

> "1. The data subject shall have the right to object, on grounds relating to his or her particular
> situation, at any time to processing of personal data concerning him or her which is based on
> point (e), (ea) or (f) of Article 6(1), **including profiling based on those provisions. The
> controller shall no longer process the personal data unless the controller demonstrates compelling
> legitimate grounds for the processing which override the interests, rights and freedoms of the
> data subject** or for the establishment, exercise or defence of legal claims."
>
> — UK GDPR Article 21(1), <https://www.legislation.gov.uk/eur/2016/679/article/21>, retrieved 2026-08-06 (emphasis added)

Read the burden carefully. On objection, processing **stops by default**. The controller must then
affirmatively demonstrate grounds that are not merely legitimate but **compelling**, and which
**override** the subject's interests. Having already concluded in §5.3 that the ordinary balance is
difficult, the compelling-grounds standard is a higher bar again on the same facts. Realistically,
**every objection must be honoured**, and the service should be designed on that assumption rather
than on a case-by-case assessment it will lose.

The ICO confirms both the burden and the weighting:

> "In making a decision on this, you need to balance the individual's interests, rights and freedoms
> with your own legitimate grounds. During this process you should remember that **the responsibility
> is for you to be able to demonstrate that your legitimate grounds override those of the
> individual**."
>
> "... if an individual objects on the grounds that the processing is causing them substantial damage
> or distress ..., the grounds for their objection will have more weight."
>
> — ICO, "Right to object",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-object/>,
> retrieved 2026-08-06 (emphasis added)

The second sentence matters because the objections SlashWho receives will disproportionately come
from people with something to lose — which is exactly the "substantial damage or distress" cohort
whose objections carry more weight.

Article 21(4) adds a presentation duty: the right "shall be explicitly brought to the attention of
the data subject and shall be presented clearly and separately from any other information".

**One new erasure ground is worth flagging for what it says about the direction of the law.** The
DUAA inserted Article 17(1)(g), a mandatory erasure ground where personal data "have been processed as
a result of an allegation about the data subject" made by "a malicious person", with Articles 17(4)
and 17(5) defining that person by reference to a table of **harassment and stalking convictions and
stalking protection orders** (Protection from Harassment Act 1997, Stalking Protection Act 2019, and
the Scottish and Northern Irish equivalents). It does not apply to SlashWho directly — a search is
not an "allegation". But Parliament legislating in 2025 to give stalking victims a hard erasure right
over data processed at a stalker's instigation is a clear signal about how a regulator would view a
service that, on request from an anonymous stranger, reveals where else a person can be found.
SlashWho's search is initiated by an unidentified third party about a person who did not ask to be
looked up; that is the same shape of problem the new provision addresses.

Erasure then follows automatically:

> "1. The data subject shall have the right to obtain from the controller the erasure of personal
> data concerning him or her without undue delay and the controller shall have the obligation to
> erase personal data without undue delay where one of the following grounds applies: ... (c) the
> data subject objects to the processing pursuant to Article 21(1) and there are no overriding
> legitimate grounds for the processing ...; (d) the personal data have been unlawfully processed"
>
> — UK GDPR Article 17(1), <https://www.legislation.gov.uk/eur/2016/679/article/17>, retrieved 2026-08-06

Note 17(1)(d): if the §5 analysis is wrong and there was never a valid basis, **every** record is
erasable on demand, not just the ones objected to.

### 7.2 Suppression is not erasure

This is a concrete, presently-existing gap, not a hypothetical one.

> "Removal means suppression from every public current, history, snapshot, and job-status response.
> **It does not delete immutable snapshots or rewrite historical membership.**"
>
> — `docs/operations/removals.md`, this repository (emphasis added)

Article 17 requires **erasure**. UK GDPR Article 4(3) defines "restriction of processing" as "the
marking of stored personal data with the aim of limiting their processing in the future" — that is
what SlashWho does, and it is the Article 18 remedy, not the Article 17 one. Restriction is a valid
right in its own right and is sometimes an acceptable *interim* step, but it does not discharge an
erasure obligation.

The shelters in Article 17(3) do not obviously rescue the permanent snapshots:

> "3. Paragraphs 1 and 2 shall not apply to the extent that processing is necessary: (a) for
> exercising the right of freedom of expression and information; ... (d) for archiving purposes in
> the public interest, scientific or historical research purposes or statistical purposes in
> accordance with [Article 84B] in so far as the right referred to in paragraph 1 is likely to
> render impossible or seriously impair the achievement of the objectives of that processing; or
> (e) for the establishment, exercise or defence of legal claims."
>
> — Article 17(3), retrieved 2026-08-06

- **17(3)(a) freedom of expression** is real but is a balancing exercise, and the expressive value
  of a machine-generated linkage record about a private individual who has objected is slight.
- **17(3)(d) archiving/statistical** is the more tempting one and it fails on three independent
  grounds. This is worth setting out properly, because "it's an archive" is the argument most likely
  to be reached for.

**Ground one: the UK gate has just been narrowed, and the narrowing is fatal.** Article 17(3)(d) (and
Article 5(1)(e)'s storage-limitation extension) no longer cross-refer to Article 89(1). Since 5
February 2026 they cross-refer to a **new Article 84B**, inserted by DUAA 2025 s.86(2). Article 84A
defines "RAS purposes" as scientific or historical research, archiving in the public interest, and
statistical purposes. Article 84B then provides:

> "1. Personal data may only be processed for RAS purposes if— (a) the processing consists of the
> collection of the personal data (whether from the data subject or otherwise), (b) **the processing
> is carried out in order to convert the personal data into information which can be processed in a
> manner which does not permit the identification of a data subject**, or (c) **without the
> processing, the RAS purposes cannot be fulfilled**.
>
> 2. Processing of personal data for RAS purposes must be carried out subject to **appropriate
> safeguards for the rights and freedoms of the data subject**."
>
> — UK GDPR Article 84B, inserted 5 February 2026, retrieved 2026-08-06

Limb (b) points towards **de-identification** — the exact opposite of an identity-linking product.
Limb (c) requires that the archival purpose be unachievable without the identifying processing. A
service whose entire output *is* the identified linkage cannot satisfy (b), and can reach (c) only by
asserting that its archival purpose intrinsically requires naming individuals — which then collides
with 84B(2). This is a real tightening relative to the pre-2026 position and relative to the EU GDPR,
which still reads "Article 89(1)".

**Ground two: the DPA 2018 research and archiving exemptions do not touch Article 17 at all.** DPA
2018 Schedule 2, Part 6, paragraph 27 (research and statistics) and paragraph 28 (archiving in the
public interest) each list the disapplied provisions exhaustively: Articles 15(1)–(3), 16, 18(1), 19,
20(1) and 21(1). **Article 17 appears in neither list.** So the UK's domestic research and archiving
exemptions give no relief whatever from the right to erasure. The only 17(3)(d) route is the one
inside Article 17 itself, gated by Article 84B above.

**Ground three: the purpose must be exclusive.** Article 5(1)(e)'s extension applies only where data
"will be processed **solely**" for those purposes, and DPA 2018 Sch. 2 paras 27(4) and 28(4) provide
that where the processing "serves at the same time another purpose, the exemption ... is available
only where the personal data is processed for a purpose referred to in that sub-paragraph". A site
that also serves community curiosity, guild recruitment, and the operator's interest in running an
interesting project is not processing solely for archiving. It is worth being honest that SlashWho's
snapshots exist for product reasons — reproducibility, being able to revisit a result at its exact
refresh time — not for archival ones.

The same point can be made from Article 4(5) as amended, which restricts references to statistical
purposes to processing where "the information that results from the processing is aggregate data that
is **not** personal data" and where "the controller does not use the personal data processed ... in
support of measures or decisions with respect to a particular data subject". Per-character published
snapshots fail both limbs.

**Do not rely on an archival justification for permanent snapshots. It does not work, and post-DUAA
it works less well than it did.**

Independently, permanent retention collides with Article 5(1)(e) (data "kept in a form which
permits identification of data subjects for no longer than is necessary") and with the Blizzard
30-day TTL from sibling note #5. Three separate constraints point at the same conclusion:
**"immutable and permanent" is not a viable property for personal-data snapshots.** It is viable
for aggregate counts that are genuinely not personal data; it is not viable for per-character
membership.

### 7.3 Rectification of a probabilistic inference

Article 16 gives an unqualified right to rectification of inaccurate personal data, and Article
5(1)(d) requires that "every reasonable step must be taken to ensure that personal data that are
inaccurate ... are erased or rectified without delay".

An achievement-timestamp fingerprint is probabilistic. It will produce false positives, and per
§1.6 a false positive is personal data about *both* people.

The ICO's guidance offers an apparent safe harbour for opinions, and it is conditional in a way that
matters:

> "A record of an opinion is not necessarily inaccurate personal data just because the individual
> disagrees with it, or it is later proved to be wrong. Opinions are, by their very nature,
> subjective and not intended to record matters of fact. **However, in order to be accurate, your
> records must make clear that it is an opinion**, and, where appropriate, whose opinion it is."
>
> "Note that some records that may appear to be opinions do not contain an opinion at all. For
> example, many financial institutions use credit scores ... **Credit scores are based on a
> statistical analysis of individuals' personal data, rather than on a subjective opinion** about
> their creditworthiness. However, you must ensure the accuracy (and adequacy) of the underlying
> data."
>
> — ICO, "Principle (d): Accuracy",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/accuracy/>,
> retrieved 2026-08-06 (emphasis added)

A fingerprint match is a statistical analysis, not a subjective opinion — so on the ICO's second
paragraph the opinion route is not straightforwardly available, and the accuracy of the underlying
data must be assured. The most directly applicable guidance is in the ICO's AI material, which is
written for exactly this shape of output:

> "In many cases, the outputs of an AI system are not intended to be treated as factual information
> about the individual. Instead, they are intended to represent a **statistically informed guess** as
> to something which may be true about the individual now or in the future. **To avoid such personal
> data being misinterpreted as factual, you should ensure that your records indicate that they are
> statistically informed guesses rather than facts.** Your records should also include information
> about the provenance of the data and the AI system used to generate the inference."
>
> — ICO, "What do we need to know about accuracy and statistical accuracy?",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/guidance-on-ai-and-data-protection/what-do-we-need-to-know-about-accuracy-and-statistical-accuracy/>,
> retrieved 2026-08-06 (emphasis added)

Its compliance checklist puts it as an instruction: "**make sure data is clearly labelled as
inferences and predictions, and is not claimed to be factual**".

Three obligations follow that the current design does not meet:

- **The published output must not assert as fact what is a statistically informed guess.** Labelling
  the linkage as an inference, showing a confidence level, and stating the method and provenance is
  an Article 5(1)(d) accuracy requirement, not a UX nicety. It also happens to discharge part of
  Article 14(2)(f) and (g). This is cheap and should be non-negotiable.
- **There must be a route to contest a specific link**, distinct from a request to remove a character
  entirely. The current removal template offers only the latter.
- **Article 16's second sentence gives a supplementary-statement right** — "the data subject shall
  have the right to have incomplete personal data completed, including by means of providing a
  supplementary statement". A subject who disputes a link but cannot get it removed is entitled to
  have their denial recorded alongside it. There is nowhere in the current data model for that.

### 7.4 Can a public GitHub issue template serve as the rights channel?

**No — and after the DUAA it is not a close question.** Article 12 sets the standard:

> "1. The controller shall take appropriate measures to provide any information referred to in
> Articles 13 and 14 and any communication [made under or by virtue of Articles 15 to 22D] and 34
> relating to processing to the data subject in a **concise, transparent, intelligible and easily
> accessible form, using clear and plain language** ...
>
> 2. The controller shall **facilitate** the exercise of data subject rights [arising under or by
> virtue of Articles 15 to 22D]. ...
>
> 5. ... information provided under Articles 13 and 14 and any communication and any actions taken
> ... shall be provided **free of charge**."
>
> — UK GDPR Article 12, <https://www.legislation.gov.uk/eur/2016/679/article/12>, retrieved 2026-08-06 (emphasis added)

The DUAA moved the deadline out of Article 12(3) into a new **Article 12A**, which is worth knowing
because most compliance checklists still say "one month" without the qualifications:

> "1. In Article 12, 'the applicable time period' means **the period of one month beginning with the
> relevant time**, subject to paragraph 3.
>
> 2. 'The relevant time' means the latest of the following— (a) when the controller receives the
> request in question; (b) when the controller receives the information (if any) requested in
> connection with a request under Article 12(6); (c) when the fee (if any) charged in connection with
> the request under Article 12(5) is paid.
>
> 3. The controller may, by giving notice to the data subject, extend the applicable time period by
> two further months where that is necessary by reason of— (a) the complexity of requests made by the
> data subject, or (b) the number of such requests."
>
> — UK GDPR Article 12A, <https://www.legislation.gov.uk/eur/2016/679/article/12A.>, inserted 5.2.2026, retrieved 2026-08-06

Two practical points: the clock can be stopped by a proportionate Article 12(6) identity request
(12A(2)(b)), and it can be extended by two months on notice — but neither helps with an Article 21
objection, where the obligation is to *stop processing*, not merely to respond within a deadline.

**The channel itself.** The repository's template (`.github/ISSUE_TEMPLATE/removal-request.yml`)
requires the requester to supply the character URL and a free-text "Request reason", in a **public**
issue on a **public** repository. Against Article 12 it fails on at least five grounds:

0. **It cannot be the only channel, as a matter of law.** The ICO is explicit that there are no
   formalities: "**There are no formal requirements for a valid request.** A person can make a SAR
   verbally or in writing, including by social media. They can make it to any part of your
   organisation, **and they do not have to direct it to a specific person or contact point**"
   (<https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/right-of-access/how-do-we-recognise-a-subject-access-request-sar/>,
   retrieved 2026-08-06). The same formula appears in the rectification guidance. So a request
   arriving by email, by Discord, or in a forum post is valid and starts the Article 12A clock,
   whether or not the template was used. A GitHub-only *policy* is not merely inadequate — it is
   unenforceable, and operating as though it were would produce missed deadlines.

1. **It requires a GitHub account.** Requiring registration with an unrelated third party, and
   acceptance of that third party's terms and its own processing of the requester's personal data,
   is a barrier to the exercise of a right, not a facilitation of it. It is also arguably not "free
   of charge" in substance.
2. **It is public, and publicity is the injury.** This is the strongest of the objections. To object
   under Article 21(1) the subject must state "grounds relating to his or her particular situation" —
   they must identify the linkage and explain why it harms them. Doing that in a public GitHub issue
   **republishes, in a second permanent and indexed location, the exact linkage the request seeks to
   suppress**, adds a GitHub identity the original dataset did not contain, and in practice
   *confirms* the inference from the subject's own mouth. The remedy becomes the injury. That is
   incompatible with Article 12(2) (a channel whose use inflicts the harm the right exists to prevent
   does not "facilitate" the right); contrary to Article 5(1)(c) data minimisation, because it
   compels the subject to supply more personal data than any verification need requires; and hard to
   square with Article 5(1)(f), since the controller has designed the disclosure. The template's own
   privacy warning checkbox — asking requesters not to include BattleTags, Discord handles or
   ownership evidence — is an acknowledgement by the maintainers that the channel is unsafe for the
   information the process needs.

   No ICO statement addressing rights channels that compel public self-disclosure could be found;
   this argument is constructed from the Articles cited rather than taken from direct authority, and
   should be read as reasoned analysis. The nearest ICO wording points the same way: "**In general,
   responding on social media is not a secure way of providing information. You should ask for
   alternative delivery details instead.**"
3. **It is scoped to removal only.** There is no route for access (Art 15), rectification (Art 16),
   restriction (Art 18) or a reasoned objection (Art 21). Article 12(2) requires facilitation of
   *the rights*, not of one operational outcome.
4. **It creates an identity-verification trap.** Article 12(6) permits a controller with
   "reasonable doubts concerning the identity of the natural person making the request" to "request
   the provision of additional information necessary to confirm the identity of the data subject"
   and to "delay dealing with the request until the identity is confirmed". But verification cannot
   be conducted in public without defeating the purpose, and the operations doc already routes
   evidence to "a private maintainer channel" that is not documented publicly and is not offered in
   the template. The verification demand must also be proportionate: demanding strong proof of
   ownership as a precondition to *hiding* data is itself a barrier, and Article 11 points the other
   way —

> "2. Where ... the controller is able to demonstrate that it is not in a position to identify the
> data subject, the controller shall inform the data subject accordingly, if possible. In such
> cases, Articles 15 to 20 shall not apply except where the data subject, for the purpose of
> exercising his or her rights under those articles, provides additional information enabling his
> or her identification."
>
> — UK GDPR Article 11(2), retrieved 2026-08-06

The ICO's steer on verification is that it must be proportionate, and that existing mechanisms should
be preferred to documents:

> "You can ask for enough information to judge if the requester (or the person the request is made on
> behalf of) is the person whom the information is about. **You should be reasonable and proportionate
> about what you ask for. Only request formal identification documents if necessary. You can use
> verification measures that you already have in place (eg an existing username and password).** If
> the requester's identity is obvious to you, you are unlikely to require more information."
>
> "**The level of checks you make may depend on the nature of the information and on the possible harm
> and distress that an inappropriate disclosure may cause** to the person concerned."
>
> — ICO, "What should we consider when responding to a request?",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/right-of-access/what-should-we-consider-when-responding-to-a-request/>,
> retrieved 2026-08-06 (emphasis added)

**This points to an elegant answer for a site with no accounts: verify in-band.** The natural proof
of control over a WoW character is a Battle.net OAuth login — Blizzard's own flow proves control of
the account, which is precisely the fact in issue. It is proportionate, it uses a mechanism already
in existence, it collects nothing sensitive, and it avoids the absurdity of demanding a passport from
someone whose only relationship to the operator is that the operator published a guess about them. An
in-game verification step (a temporary change to a character's guild note or profile text) is a
lower-tech alternative that works without any Blizzard integration.

There is one caution: adding an OAuth login to satisfy rights requests means processing more personal
data about the requester than before, and it must not become a *precondition* for a request that is
otherwise clear. Article 12(6) permits identity checks only "where the controller has reasonable
doubts". For a request to *suppress* rather than disclose data, the harm from acting on an
unverified request is low — the worst case is that a character is hidden that need not have been —
and the verification demanded should be correspondingly light. Demanding strong proof before hiding
data is itself a barrier to the right.

Article 11 is worth understanding precisely, because it is easy to over-claim. It relieves a
controller of Articles 15–20 where it genuinely cannot identify the subject — but note two things.
First, **Article 21 is not in the list.** The right to object survives Article 11 entirely; there is
no identification escape from an objection. Second, Article 12(2) provides that in Article 11(2)
cases "the controller shall not refuse to act on the request of the data subject ... unless the
controller demonstrates that it is not in a position to identify the data subject" — the burden is
on the controller, and where the subject supplies information sufficient to identify themselves
(here, trivially: proving control of the character), the exception falls away.

**And there is now a free-standing statutory duty the template cannot satisfy at all.** DPA 2018
s.164A, in force in full since **19 June 2026**:

> "(1) A data subject may make a complaint to the controller if the data subject considers that, in
> connection with personal data relating to the data subject, there is an infringement of the UK
> GDPR or Part 3 of this Act.
>
> (2) A controller **must facilitate the making of complaints under this section by taking steps such
> as providing a complaint form which can be completed electronically and by other means**.
>
> (3) If a controller receives a complaint under this section, the controller must **acknowledge
> receipt of the complaint within the period of 30 days** beginning when the complaint is received.
>
> (4) If a controller receives a complaint under this section, the controller must without undue
> delay— (a) take appropriate steps to respond to the complaint, and (b) inform the complainant of
> the outcome of the complaint."
>
> — DPA 2018 s.164A, <https://www.legislation.gov.uk/ukpga/2018/12/section/164A>, retrieved 2026-08-06 (emphasis added)

Note "**and by other means**". The statute contemplates a form *plus* a non-form route; a
GitHub-only channel is a single route requiring third-party registration. Note also the
acknowledgement clock. This section is new enough that it will not appear in most existing
compliance write-ups, and it converts "we should have a contact address" from good practice into a
statutory requirement.

**What would be needed instead.** A rights channel that: is reachable without registering anywhere
(a plain email address is sufficient and is what the statute contemplates); is private by default;
accepts all of access, rectification, erasure, restriction and objection, not just removal; states
the response time; acknowledges within 30 days; asks for identity evidence only where there are
reasonable doubts under Article 12(6), proportionately, and never in public; and is linked
prominently from every page that publishes a linkage. The GitHub template can remain as a
*convenience* option. It cannot be the only door.

### 7.5 Article 17(2): the part that cannot be undone

> "2. Where the controller has made the personal data public and is obliged pursuant to paragraph 1
> to erase the personal data, the controller, **taking account of available technology and the cost
> of implementation, shall take reasonable steps, including technical measures, to inform
> controllers which are processing the personal data that the data subject has requested the
> erasure by such controllers of any links to, or copy or replication of, those personal data**."
>
> — UK GDPR Article 17(2), retrieved 2026-08-06 (emphasis added)

This obligation is triggered **by the act of publishing**, and it is the clearest illustration of
why the three acts in the scope note must be separated. Create-and-store creates no downstream
controllers. Publishing creates them: search engine caches, the Internet Archive, scrapers, LLM
training corpora, Discord embeds, and mirrors. Once a linkage page has been crawled, honouring an
erasure request in full is no longer within the operator's power. The obligation is qualified by
reasonableness and cost — a hobbyist is not expected to litigate against archives — but "reasonable
steps" is not "no steps", and there is no version of this where the data comes back.

**The EDPB has deliberately put this burden on the original publisher, not the search engine.** Its
Guidelines 5/2019 on the right to be forgotten in search engine cases (adopted 7 July 2020) explain
the allocation:

> "This paper does not address Article 17.2 GDPR. Indeed, this Article requires data controllers who
> have made the personal data public to inform controllers who have then reused those personal data
> through links, copies or replications. **Such obligation of information does not apply to search
> engine providers** ... In addition, it does not require search engine providers, who have received a
> data subject's delisting request, to inform the third party which made public that information on
> the internet. **Such obligation seeks to give greater responsibility to original controllers** and
> try to prevent from multiplying data subjects' initiatives."
>
> — EDPB Guidelines 5/2019, para. 12,
> <https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_guidelines_201905_rtbfsearchengines_afterpublicconsultation_en.pdf>,
> retrieved 2026-08-06 (emphasis added)

By publishing crawlable permanent pages, SlashWho volunteers into being the "original controller" the
obligation was deliberately loaded onto. It cannot say "Google did that".

**What "reasonable steps" means in practice, and why the cost limiter helps less than expected.**
Google, Bing and the Internet Archive all publish free removal-request mechanisms. "Available
technology and the cost of implementation" is a genuine limiter when the recipients are thousands of
unknown mirrors; it is not a limiter when they are three named, documented, free channels. Filing
them on each valid erasure request is a reasonable step, and the operator would struggle to argue
otherwise. Two points of comfort and one of discomfort:

- **Article 17(2) is a duty to *inform*, not to *achieve* removal.** The operator is not liable for
  the Internet Archive's refusal.
- The duty is triggered per request, so it is bounded by the number of successful erasure requests,
  not by the size of the corpus.
- But a regulator would notice that the operator **architected** permanence, maximising third-party
  replication before any request could arrive, and shifting the cost of unwinding it onto the data
  subject. Article 25 (data protection by design and by default) bites at that design decision
  independently of Article 17.

Two design consequences follow directly and are cheap:

- **Do not let inferred linkage pages be indexed.** `noindex` on pages carrying inferred-only
  linkage, and exclusion in `robots.txt`, materially reduces both the Article 17(2) burden and the
  severity side of the §5.3 balancing. It is the highest-value, lowest-cost mitigation available.
- **Do not publish permanent immutable snapshots of linkage.** §7.2 and the Blizzard TTL already
  require this; Article 17(2) makes it urgent, because permanence plus crawling is what makes
  erasure impossible rather than merely awkward.

---

## 8. A DPIA is mandatory, and the ICO's own list says so three times over

> "1. Where a type of processing in particular using new technologies, and taking into account the
> nature, scope, context and purposes of the processing, is likely to result in a high risk to the
> rights and freedoms of natural persons, the controller shall, **prior to the processing**, carry
> out an assessment of the impact of the envisaged processing operations on the protection of
> personal data."
>
> — UK GDPR Article 35(1), <https://www.legislation.gov.uk/eur/2016/679/article/35>, retrieved 2026-08-06 (emphasis added)

The Article 35(3) automatic triggers are arguably not met (no decisions with legal or similarly
significant effects; no special category data; no monitoring of a publicly accessible *area*). But
Article 35(4) requires the Commissioner to publish a further list, and the ICO's list is where this
is decided. Three entries apply:

> "**Data matching:** combining, comparing or matching personal data obtained from multiple
> sources."
>
> "**Invisible processing:** processing of personal data that has not been obtained direct from the
> data subject in circumstances where the controller considers that compliance with Article 14 would
> prove impossible or involve disproportionate effort. A DPIA is required where this processing is
> combined with any of the criteria from the European guidelines."
>
> "**Tracking:** processing which involves tracking an individual's geolocation or behaviour,
> including but not limited to the online environment. A DPIA is required where this processing is
> combined with any of the criteria from the European guidelines."
>
> — ICO, "When do we need to do a DPIA?",
> <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/when-do-we-need-to-do-a-dpia/>,
> retrieved 2026-08-06

The ICO's dedicated list page frames these as requirements, not suggestions — "The following list
details processing operations for which **the ICO requires you to complete a DPIA** as they are
'likely to result in high risk'" — and gives worked examples against each entry. Two of those examples
name this activity almost exactly: the **Invisible processing** entry lists "**Re-use of publicly
available data**" and "Data aggregation/data aggregation platforms" among its examples, and the
**Tracking** entry lists "Data aggregation / data aggregation platforms" as well
(<https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/examples-of-processing-likely-to-result-in-high-risk/>,
retrieved 2026-08-06). A fourth entry, **Large-scale profiling** — "any profiling of individuals on a
large scale" — would also apply if §2 resolves in favour of profiling and the scale threshold is met.

(That page still cites the repealed "Article 14.5(b)" numbering; read it as Article 14(5)(e) per §6.2.
The substance is unaffected, but it illustrates the point in "Read this first" about ICO guidance
being substantively current and numerically stale.)

**Data matching is unconditional** on the ICO's list — no combination with another criterion is
required — and combining, comparing and matching personal data obtained from Raider.IO and the
Blizzard API is a literal description of what the fingerprint does. That alone settles it.

Invisible processing and tracking each require combination with one of the WP29 criteria, and the
ICO lists those criteria as: "Evaluation or scoring. Automated decision-making with legal or
similar significant effect. Systematic monitoring. Sensitive data or data of a highly personal
nature. Data processed on a large scale. **Matching or combining datasets.** Data concerning
vulnerable data subjects. **Innovative use** or applying new technological or organisational
solutions. Preventing data subjects from exercising a right or using a service or contract." At
least matching/combining, systematic monitoring and arguably innovative use are present. The ICO's
rule of thumb — "In most cases, a combination of two of these factors indicates the need for a
DPIA" — is comfortably exceeded.

Note the §6.2 trap closing: **claiming the Article 14(5)(e) exemption is itself the definition of
"invisible processing"** on the ICO's list. The two findings are locked together — you cannot take
the transparency relief without accepting the DPIA trigger.

Three further points:

- **"Prior to the processing"** — the DPIA must be done *before* the feature ships, not
  retrospectively. Shipping first and assessing later is itself the breach.
- **There is no small-operator or hobbyist exemption from Article 35.** Article 35(1) imposes the
  duty on "the controller" with no size, turnover or staff threshold anywhere in the Article. The
  ICO's exhaustive list of exceptions covers only processing on a legal-obligation or public-task
  basis subject to four cumulative conditions, a substantially similar DPIA already done, and a
  Commissioner-published exemption list — and of the last the ICO says "**We have the power to
  establish this type of list, but we have not done so yet.**" This is commonly confused with the
  ~250-employee derogation from *records of processing activities* under Article 30(5), which is a
  different obligation and does not extend to DPIAs.
- Article 35(9): "Where appropriate, the controller shall seek the views of data subjects or their
  representatives on the intended processing." For a community tool this is unusually easy and
  unusually valuable — asking the WoW community before shipping is both a compliance step and the
  cheapest available evidence for or against the §5.3 balancing. It would also produce exactly the
  evidence a solicitor would want.

If the DPIA concludes that a high risk remains that cannot be mitigated, Article 36 requires prior
consultation with the ICO before proceeding.

---

## 9. What regulators have actually done with comparable services

The analysis above is doctrinal. This section is the empirical check: what has actually happened to
people who published compiled or derived personal data from public sources. The pattern is
consistent and it is not favourable.

**There is one important negative finding first.** No decision by any data protection authority —
ICO, CNIL, Garante, AEPD, IMY, AP, UODO, DSB, BfDI — could be found squarely on a site whose function
is to link pseudonymous online identities to each other or to a real identity. This appears to be a
genuine gap in published precedent rather than a search failure, though an untranslated national
decision cannot be ruled out. **SlashWho would be closer to a test case than to a settled category.**
That cuts both ways: there is no adverse authority pointed directly at it, and there is no comfort
either.

The nearest analogues:

**Clearview AI (UK).** Discussed at §3.4 on jurisdiction. Worth restating what it does *not* decide:
the merits — lawful basis, fairness, transparency, Article 14, penalty — remain undetermined and
remitted. The ICO's £7,552,800 penalty and enforcement notice of 18 May 2022 are back in play
following the Upper Tribunal's decision of 6 October 2025, subject to a Court of Appeal appeal for
which permission was granted on 19 December 2025.

**Bisnode (Poland).** The Polish DPA fined Bisnode PLN 943,000 for failing to give Article 14 notices
to people whose data it had taken from **public registers**, and the cassation appeal was dismissed by
the Supreme Administrative Court on 20 September 2023 (III OSK 2538/21), the court holding that
"transparency of processing is a rule and any exceptions to this rule ... should be interpreted
restrictively" (<https://uodo.gov.pl/en/553/1572>, retrieved 2026-08-06). This is the strongest EU
authority that **"it was already public" and "there are too many people to notify" do not excuse
Article 14**. It is directly on the §6.2 question.

**Trovanumeri (Italy).** The Garante's provvedimento of 17 May 2023 (doc. web 9903067, €60,000,
<https://www.garanteprivacy.it/home/docweb/-/docweb-display/docweb/9903067>, retrieved 2026-08-06)
prohibited the creation and publication of a telephone directory assembled by web scraping (~26
million people) and condemned reverse lookup. The operator's analogy to authorised directory services
was rejected: **public availability alone does not authorise reuse to build a new compilation.** This
is the most structurally similar case found — take public per-record data, compile it, add a lookup
capability the original source did not offer, publish.

**Locatefamily.com (Netherlands).** €525,000, 12 May 2021, discussed at §3.4. The lesson is
procedural: the substantive case was hard, so the authority used Article 27.

**Experian (UK).** The ICO's appeal against the First-tier Tribunal was dismissed by the Upper
Tribunal in April 2024 (UA-2023-000512-GIA). The substituted enforcement notice carved out cases
where Experian's processing "is confined to the retention or sale of the Open Electoral Register" —
i.e. **passing public data through unchanged attracted no notification duty; enriching and profiling
it did.** That is precisely the line between mirroring what Raider.IO publishes (today's SlashWho) and
inferring a new linkage from Blizzard timestamps (the proposal). Paragraph references were read via a
summarising fetch and should be verified against the judgment PDF before being relied on.

**Reddit (UK, February 2026).** The ICO fined Reddit **£14.47m** on 24 February 2026 for failing to
implement age assurance, with the consequence that it had no lawful basis for processing the data of
under-13s, and for failing to carry out a DPIA. The penalty is under appeal. This matters here for a
reason that is easy to miss: **the fine was for not knowing that children were in the dataset, and
for not doing the DPIA that would have surfaced the problem.** SlashWho cannot identify which of its
data subjects are minors either, and Article 6(1)(f) expressly singles out children. The §5.3
balancing entry for children is not a theoretical box to tick; it is the exact failure the ICO fined
most recently.

**Two regulator statements on the underlying principle.** The ICO's December 2024 outcomes report on
web scraping for generative AI is about a different application but the reasoning transfers:

> "Collecting data through web-scraping is an '**invisible processing**' activity, where people are
> not aware their personal data is being processed in this way."
>
> "Web scraping for generative AI training is a **high-risk, invisible processing activity. Where
> insufficient transparency measures contribute to people being unable to exercise their rights,
> [developers] are likely to struggle to pass the balancing test.**"
>
> "If organisations can reasonably achieve their purpose without the high-risk, invisible processing
> involved in web scraping, then they **wouldn't pass the necessity part of the legitimate interest
> test**."
>
> — ICO, "The lawful basis for web scraping to train generative AI models",
> <https://ico.org.uk/about-the-ico/what-we-do/our-work-on-artificial-intelligence/response-to-the-consultation-series-on-generative-ai/the-lawful-basis-for-web-scraping-to-train-generative-ai-models/>,
> December 2024, retrieved 2026-08-06 (emphasis added)

And the EDPB's draft **Guidelines 03/2026 on web scraping in the context of generative AI**, adopted 7
July 2026 and in consultation until 30 October 2026
(<https://www.edpb.europa.eu/public-consultations/guidelines-032026-on-web-scraping-in-the-context-of-generative-ai_en>,
retrieved 2026-08-06):

> "¶45. Sometimes data subjects are not even aware of the fact that their data are publicly available
> online. When data subjects make their personal data available online, for example on a web page
> accessible to everyone, **this does not mean that the data subjects gave their consent to the
> scraping of their personal data for a specific purpose.**"
>
> "¶64. ... people may be aware that the data they publish online may be accessed, collected and
> reused by third parties. However, **it cannot be considered that they can always expect such
> processing to take place in all situations, for all purposes, for all controllers' interests and
> for all types of data accessible online concerning them.**"

These are draft, scoped to generative AI, and not UK law. They are cited only as the clearest current
EU-level statement of the principle that public availability is not a licence — and as evidence of
which way regulatory thinking is moving while this feature is being decided.

---

## 10. Enforcement exposure, and one criminal provision nobody thinks about

The ticket is being used to decide whether a real service ships, so the realistic consequences matter
as much as the doctrine.

### 10.1 The base rate is low, and that is not a plan

The ICO's enforcement output has fallen sharply: its 2024/25 annual report records **two** UK GDPR
fines in the year, **zero** UK GDPR enforcement notices, nine reprimands (down from 31), and 43 UK
GDPR investigations (down from 285). Germany and Spain each issued 200+ GDPR fines in the same
period. No ICO prosecution has ever been brought against a person for publishing personal data on
their own website; the six prosecutions in the ICO's database (all since September 2025) are all
insider-access, data-theft or subject-access-obstruction cases. Every *publication* case found
resulted in a **reprimand of an organisation**, not a fine.

That is genuinely useful context and it is not a defence. It is a statement about probability, not
about lawfulness, and the ICO's enforcement priorities can change faster than a website can be
un-published. It also says nothing about the two exposures in §10.3, which do not depend on the ICO
acting at all.

### 10.2 What the ICO could actually do

**The realistic worst case is not a fine. It is an order to take the site down.** UK GDPR Article
58(2)(f) and (g) empower the Commissioner "to impose a temporary or definitive limitation including a
ban on processing" and "to order the rectification or erasure of personal data or restriction of
processing pursuant to Articles 16, 17 and 18 and the notification of such actions to recipients".
That is delivered as an enforcement notice under DPA 2018 s.149, and non-compliance is itself an
Article 83(5)(e) infringement.

Note also DPA 2018 s.142(1)(b)(ii): the Commissioner may serve an information notice on any person to
determine "whether the processing of personal data is carried out by an individual in the course of a
purely personal or household activity". There is a bespoke statutory tool for the §3.2 question.

**On fines, the headline number is worse than intuition suggests.** Article 83(5) sets a maximum of
"£17,500,000, or in the case of an undertaking, up to 4% of the total worldwide annual turnover ...
whichever is higher". People assume a hobbyist with no turnover benefits from the percentage limb.
The statute says the opposite:

> "(5) The 'higher maximum amount' is— (a) in the case of an undertaking, £17,500,000 or 4% of the
> undertaking's total annual worldwide turnover in the preceding financial year, whichever is higher,
> or **(b) in any other case, £17,500,000.**"
>
> — DPA 2018 s.157(5), <https://www.legislation.gov.uk/ukpga/2018/12/section/157>, retrieved 2026-08-06 (emphasis added)

**The turnover limb raises the ceiling for large undertakings; it never lowers it for small ones.**
Zero turnover buys nothing. The nominal ceiling for an individual is the full £17.5 million.

Article 83(2)'s list of factors contains **no non-commercial or small-operator mitigation**. The only
available hook is 83(2)(k) "any other aggravating or mitigating factor ... such as financial benefits
gained, or losses avoided" — and absence of gain is merely the absence of an aggravating factor.
Meanwhile 83(2)(b), "the intentional or negligent character of the infringement", cuts against:
deliberately building an inference engine is intentional, not accidental.

Realistically, the ICO's Data Protection Fining Guidance (18 March 2024) micro-band starting points
(£0–£2m) run from "up to £7,000" for lower seriousness to "£7,000–£70,000" for high, and the
Commissioner may have regard to "assets, funding or administrative budget" where there is no
turnover. So the realistic order of magnitude is **low thousands to low tens of thousands**, not
millions. Hardship relief exists but is narrow, and the guidance is blunt about its limits:

> "The Commissioner will not base any reduction on the mere finding of an adverse or loss-making
> financial situation. The Commissioner will also take into account that there may be circumstances
> where **a fine may be effective, dissuasive and proportionate even if the controller or processor is
> unable to pay and is rendered insolvent.**"
>
> — ICO Data Protection Fining Guidance, 18 March 2024, para. 147 (emphasis added)

**A naming note.** The Data (Use and Access) Act 2025 s.117 and Schedule 14 establish an Information
Commission, and that provision was commenced on 20 August 2025 — but ss.118 and 119, which abolish
the office of Information Commissioner and transfer functions, remain marked *Prospective* on
legislation.gov.uk as at 6 August 2026. **The regulator is still the Information Commissioner**, an
ICO statement of 19 June 2026 to the effect that "all data protection provisions ... are now in force"
notwithstanding. Any privacy notice should say "the Information Commissioner's Office (transitioning
to the Information Commission under the Data (Use and Access) Act 2025)".

### 10.3 The two exposures that do not depend on the ICO

**Article 82 compensation and misuse of private information.** A data subject can sue directly, under
UK GDPR Article 82 and DPA 2018 s.168, and in parallel for the tort of misuse of private information.
These claims do not suffer from the ICO's enforcement fatigue, they can be brought by anyone with
standing, and they interact with Blizzard's uncapped indemnity (ToU §6), which reaches "any third
party claim arising from or in any way related to" the Application. A single successful claim carries
the operator's costs, the claimant's costs, and Blizzard's.

**Harassment.** The ICO's own advice to members of the public who complain about individuals
publishing personal data online is to look to the **Protection from Harassment Act 1997** and the
**Communications Act 2003** rather than to data protection law. A service that reveals where else a
person can be found, on the request of an anonymous stranger, is a plausible instrument of a course
of conduct amounting to harassment — and the operator's role in supplying it is not obviously
irrelevant. This is outside the scope of this note and is flagged rather than analysed.

### 10.4 DPA 2018 s.170 — real, remote, and turns on the API

Section 170(1) makes it an offence "knowingly or recklessly" to obtain or disclose personal data
"without the consent of the controller", and — under s.170(1)(c) — "after obtaining personal data, to
retain it without the consent of the person who was the controller". Blizzard is the controller of
the source data. Obtaining contrary to the ToU is prima facie within (1)(a); publication is
"disclosing"; and (1)(c) makes retention a **continuing** offence, so Blizzard need only write once
withdrawing consent. "Recklessly" is a low bar.

The realistic answer is that this is remote. The strongest defence, s.170(3)(a) — that "the person
acted in the reasonable belief that the person had a legal right" — is genuinely available where the
data comes through Blizzard's **official developer API under a registered key**, which is the whole
point of doing it that way. All the defences carry a reverse burden ("to prove"). And s.170(4)–(5),
the selling offences, do not apply to an unpaid service, which removes the ICO's usual prosecution
driver. The ICO's Prosecution Policy Statement (May 2018, still current) lists financial gain and
abuse of a position of trust as the headline factors favouring prosecution; both are absent.

Penalty under s.196(2) is a fine only — no imprisonment — but note **s.196(4): the court "may order a
document or other material to be forfeited, destroyed or erased".** A court could order the database
destroyed.

### 10.5 DPA 2018 s.171 — the most apt provision in the statute book, and probably unusable

This is the provision that no one thinks of, and it deserves attention precisely because it describes
the activity better than anything else in UK law:

> "(1) It is an offence for a person knowingly or recklessly to **re-identify information that is
> de-identified personal data** without the consent of the controller **responsible for de-identifying**
> the personal data.
>
> (2) ... (a) personal data is 'de-identified' if it has been processed in such a manner that **it can
> no longer be attributed, without more, to a specific data subject**; (b) a person 're-identifies'
> information if the person takes steps which result in the information no longer being de-identified
> ...
>
> (5) It is an offence for a person knowingly or recklessly to **process** personal data that is
> information that has been re-identified where the person does so— (a) without the consent of the
> controller responsible for de-identifying the personal data, and (b) in circumstances in which the
> re-identification was an offence under subsection (1)."
>
> — DPA 2018 s.171, <https://www.legislation.gov.uk/ukpga/2018/12/section/171>, in force 25 May 2018,
> retrieved 2026-08-06 (emphasis added)

Subsection (2)(b) is a precise description of the feature. A character name cannot be attributed
"without more" to a specific data subject; the fingerprint takes steps that end that.

**But the offence almost certainly cannot be made out**, because s.171(1) requires the absence of
consent of the controller "**responsible for de-identifying** the personal data" — and Blizzard did not
de-identify anything. Character names are a game-design feature, not a de-identification process.
With no de-identifying controller there is no offence, and s.171(5) falls with it because (5)(b) is
conditioned on the re-identification being an offence under (1). A prosecutor could argue that
s.171(2)(a) is drafted passively and purpose-agnostically, so that any data which happens to be
de-identified qualifies. That is arguable but strained, and criminal statutes are construed strictly
in the defendant's favour.

Two further observations. First, **no prosecution, caution or reported case under s.171 could be
found anywhere in the eight years since it commenced**; the ICO's enforcement database returns no
hits for "re-identif". That negative cannot be conclusively proved — the database only lists
prosecutions from September 2025 — and an FOI request to the ICO for s.171 investigation and
prosecution volumes since 25 May 2018 would settle it cheaply. Second, if the offence *did* clear the
de-identifying-controller element, **the operator would have no realistic defence**: s.171(4)(a)(iii)
("would have had their consent") is hopeless for a service whose value is revealing what players
chose to hide, and s.171(4)(c) special purposes fails for the reasons in §3.3.

**Why this belongs in the note despite probably not applying.** It is the clearest evidence available
of Parliament's attitude to the activity. In 2018 the UK legislated a bespoke criminal offence of
re-identifying de-identified data, without any commercial-gain element. The fact that SlashWho likely
escapes it on a technicality of drafting — Blizzard never performed a de-identification step — is not
the same as the activity being one Parliament looked at and approved. A solicitor should be asked
about this specifically (§13 Q9).

---

## 11. Does the Blizzard "Share my game data with community developers" opt-out discharge anything?

**Almost nothing, and treating it as consent would be a mistake.** It matters operationally and is
close to irrelevant legally.

From sibling note #5 §4.6, Blizzard's privacy policy (last updated 27 June 2025) states: "We share
some of our players' game data with our community of developers who create applications and
websites that benefit our player community. You may opt-out of having your game data included in
this program by opting out of game-data sharing in the Privacy section of Battle.net account
management." Blizzard's support article (updated 5 May 2026) confirms the mechanism and that
"Disabling this feature may take up to 30 days to process".

**What it does do.** It is a real and effective *upstream* control: opting out produces a 404,
which under the ToU obliges deletion, and the 30-day TTL guarantees SlashWho asks often enough to
observe it. Honouring it is contractually mandatory and operationally sufficient to stop the data
flow.

**What it does not do.**

1. **It is not consent to SlashWho.** Article 4(11) requires consent to be "freely given,
   **specific**, informed and unambiguous". A blanket setting covering every community developer in
   the world is the opposite of specific, and it is opt-*out*, so there is no "clear affirmative
   action". A player who has not disabled it has not consented to anything, least of all to
   publication of an inference Blizzard itself does not publish. Any argument of the form "they
   left the toggle on, so they agreed" fails on the face of Article 4(11).
2. **It cannot discharge SlashWho's own controller obligations.** Article 14 transparency, the
   Article 21 objection right, the s.164A complaint duty and the Article 35 DPIA attach to the
   controller. A third party's setting does not satisfy any of them. Blizzard cannot consent on a
   player's behalf, and its terms cannot transfer our obligations to it.
3. **It is not an adequate Article 21 objection route.** A player who objects to *SlashWho
   specifically* has no route to it other than withdrawing from every community tool at once —
   losing Raider.IO, WarcraftLogs, Raidbots and the rest. Requiring a data subject to give up
   unrelated services to exercise a right against one controller does not "facilitate" that right
   within Article 12(2). It is a disproportionate condition.
4. **It is prospective only.** It stops future collection. It does nothing about a linkage already
   published on a permanent, crawled page. Sibling note #5 makes exactly this point: "A permanently
   cached page silently defies an opt-out the player has already exercised."
5. **Latency.** Up to 30 days upstream plus up to 30 days of our own TTL means a player who opts out
   today may remain published for up to two months. Article 21(1) says processing must stop; it does
   not say "within 60 days".

**Net:** the opt-out is a necessary input to compliance and nowhere near sufficient. There is one
genuinely useful thing it offers, though, which is worth taking. Because the opt-out population is
observable (they 404), and because the Raider.IO hidden-link population is observable too, SlashWho
can **detect the cohort with a demonstrated contrary expectation and decline to publish inferred
linkage for them**. That is not a legal obligation flowing from the opt-out; it is the single
cleanest way to improve the §5.3 balancing, because it removes from the published set precisely the
people whose interests most clearly override.

---

## 12. What would have to be true for this to be lawful

Consolidating the above into the conditions that would each have to hold. These are cumulative, not
alternatives.

**Necessary and achievable:**

1. A **DPIA completed before launch** (§8), documenting the risks and the mitigations, and Article
   36 prior consultation with the ICO if a high residual risk remains.
2. A **documented LIA** (§5.3) that survives its own balancing test — including the honest answer to
   the ICO's "would your use of that information be unethical in any way?"
3. An **Article 14-compliant privacy notice** with every element in §6.3, including the controller's
   real identity and contact details, prominently linked from every page and API response that
   carries a linkage.
4. A **rights channel that is not GitHub-only** (§7.4): reachable without third-party registration,
   private, covering all applicable rights, with s.164A complaint handling and a 30-day
   acknowledgement.
5. **Erasure that erases** (§7.2), including from snapshots — which means abandoning permanent
   immutable snapshot membership for personal data, which is required by Article 5(1)(e) and the
   Blizzard TTL independently.
6. **Objections honoured by default** (§7.1), not assessed case by case against a "compelling
   grounds" test the operator will usually lose.
7. **A rectification route for individual links**, a supplementary-statement mechanism, and honest
   presentation of the output as a labelled inference with confidence and provenance rather than as a
   bare fact (§7.3). This is an Article 5(1)(d) accuracy requirement.
8. **`noindex` and `robots.txt` exclusion** for inferred-linkage pages (§7.5).
9. **ICO registration and fee** — £52, notwithstanding an arguable hobby exemption (§3.5).
10. **In-band identity verification** (Battle.net OAuth or an in-game step) rather than documentary
    ID, and light-touch verification for suppression requests (§7.4).
11. **An EU representative under EU GDPR Article 27**, if EU data subjects are in scope — the
    Article 27(2)(a) derogation is probably unavailable because the processing is neither occasional
    nor unlikely to result in risk (§3.4). This is the obligation most likely to be missed and the
    easiest for a regulator to prove.

**Necessary and hard:**

12. The **balancing test must come out in our favour for the specific population published**. On the
    evidence in §5.3 it does not for players who have hidden the link, and it is genuinely arguable
    for everyone else. The most direct way to make this true is to **not publish inferred-only
    linkage for the suppressed cohort** — which happens to be detectable (§11).
13. The **necessity test must be satisfied**, which requires an honest answer to "is there a less
    intrusive way?" (§5.3). For the publication step there is: the current Raider.IO-only product.

**The honest reading of that list:** conditions 1–11 are engineering and paperwork, all of them
tractable within a hobby project's budget. Conditions 12 and 13 are not engineering problems, and
for the concealed-link cohort they are probably not satisfiable at all with the design as the ticket
describes it. A design that computes the fingerprint but withholds inferred-only linkage where the
player has signalled a contrary preference sits on the right side of both.

---

## 13. Questions to put to a solicitor

These are the points that genuinely cannot be settled from the sources, phrased so that a data
protection solicitor can answer them without first reconstructing the whole context. Take §1's
conclusion as the working assumption and ask them to test it rather than to derive it.

1. **Identifiability.** Given the ICO's published position that a username is personal data
   "regardless of whether it is possible to link the 'online' identity with a 'real world' named
   individual", and given Recital 26's "either by the controller or by another person", is there any
   realistic argument that a realm-unique WoW character name is *not* personal data in the hands of a
   publisher who cannot themselves identify the player? If not, is there a defensible narrower
   position — for example that identifiability varies by player and by realm?
2. **Legitimate interests for publication.** Can Article 6(1)(f) support **publication** (as distinct
   from computation and short-term storage) of an inferred account linkage on a permanent public
   page, where less intrusive alternatives exist and the data subject has no relationship with the
   controller? Please address the necessity limb specifically.
3. **The concealed cohort.** Where the data subject has taken a positive documented step to conceal
   the link, is there **any** configuration of the balancing test in which publication survives? If
   the answer is no, is excluding that cohort sufficient to make publication defensible for the
   remainder, or does the availability of the exclusion itself undermine necessity for everyone?
4. **Article 14(5)(e) as amended by the DUAA.** Where impossibility of notice is a consequence of the
   controller's own design, can the exemption be relied on? What would count as "appropriate measures
   to protect the data subject's rights" under Article 14(7) beyond a public notice? Is Article
   14(5)(f) ("seriously impair the achievement of the objectives of the processing") available here,
   and has it been tested?
5. **Snapshots and erasure.** Does Article 17(3)(d), read with Article 4(5) as amended, permit
   retention of dated immutable snapshots containing per-character linkage after an erasure request?
   If not — and §7.2 concludes not — what is the minimum change: deletion, or restriction under
   Article 18 plus a documented retention limit?
6. **Special purposes.** Is there any realistic route by which a selective, editorialised version of
   this service could engage DPA 2018 Sch. 2 para. 26, or should that be abandoned entirely?
7. **Registration.** Does an unpaid individual running a public website that processes third-party
   personal data fall within any exemption in Schedule 1 to S.I. 2018/480? If not, and registration
   requires a "principal place of business" address that would be the operator's home, is there any
   route to registration that does not publish a home address?
8. **Personal exposure.** What is the realistic personal-liability exposure for an individual
   controller — Article 83 penalties, an Article 58 / DPA 2018 s.155 enforcement notice, a
   compensation claim under Article 82 / DPA 2018 s.168, and the interaction with Blizzard's uncapped
   indemnity? Is there any structure (incorporation, insurance) that meaningfully changes it, and
   does incorporation create new problems by removing the individual framing?
9. **Criminal exposure — two provisions, and the second is the one to ask about.**
   (a) **s.170 DPA 2018.** Is there any risk that obtaining and publishing account-linkage data
   outside the scope of Blizzard's terms constitutes "knowingly or recklessly ... obtain[ing] or
   disclos[ing] personal data without the consent of the controller", where Blizzard is the
   controller of the source data — and does s.170(1)(c) make continued retention a continuing
   offence once Blizzard withdraws consent? Is the s.170(3)(a) defence (reasonable belief in a legal
   right) safe where access is through Blizzard's official registered API but the use exceeds the
   terms?
   (b) **s.171 DPA 2018, re-identification.** Does the element "the controller **responsible for
   de-identifying** the personal data" defeat the offence entirely, on the basis that Blizzard never
   performed a de-identification step and character names are a game-design feature? Or is
   s.171(2)(a) capable of a purpose-agnostic reading? Note this provision appears never to have been
   used in eight years; an FOI request to the ICO would confirm. See §10.5. This is the provision
   that most closely describes the activity and the one least likely to have been considered.
10. **EU exposure.** Does the EU GDPR apply in parallel by virtue of Article 3(2), and if so is an
    Article 27 representative required or does the Article 27(2)(a) derogation apply? What is the
    realistic risk of a supervisory authority in an EU member state acting against a UK individual?
11. **Contractual.** Does acting as an independent GDPR controller over Blizzard-sourced data breach
    the ToU's requirement to remain a CCPA "Service Provider", and does that in turn breach the ToU
    §5(e) warranty of compliance with all applicable laws — which would engage the uncapped indemnity
    in ToU §6?

12. **Special category data.** Where a concealed character reveals something within Article 9(1) —
    religion, political opinion, sexual orientation, health, an inference about gender identity — is
    the operator processing special category data unintentionally, and if so does any Article 9(2)
    condition exist for a public hobby site? Article 9(2)(e) ("manifestly made public by the data
    subject") plainly fails for the concealed cohort. Is a "we did not intend to and could not
    detect it" position tenable, or does the volume of publication make eventual Article 9 processing
    a certainty the operator must plan for? See §1.10.
13. **Reliance on assimilated case law.** How much weight should *Lindqvist*, *Breyer* and *Nowak*
    carry now that the Retained EU Law (Revocation and Reform) Act 2023 has removed the supremacy of
    EU law, and is there UK authority departing from any of them on identifiability?

**A note on how to use this list.** Questions 2, 3 and 4 are the ones that decide whether the feature
ships. Questions 8 and 9 are the ones that decide whether the operator should be personally exposed
to it. If budget allows only one conversation, ask 2, 3 and 8.

---

## Bottom line

**What obligations attach.** SlashWho would be an independent controller under the UK GDPR (Article
3(1) — the operator is UK-established, so this applies to every player, everywhere). The linkage
inference is personal data: the ICO's own guidance says a pseudonymous username is personal data
"regardless of whether it is possible to link the 'online' identity with a 'real world' named
individual", and Recital 26's identifiability test expressly counts means available to "another
person", which in WoW's social graph is trivially satisfied. Neither the domestic-purposes exemption
(Article 2(2)(a) — a public website about strangers is not a household activity) nor the special
purposes exemption (DPA 2018 Sch. 2 para. 26 — a database is not journalism) is available. The only
candidate lawful basis is Article 6(1)(f); the DUAA's new "recognised legitimate interest" basis does
not reach it, as Annex 1 is exhaustive and none of its five conditions applies. On top of that come:
an Article 14 privacy notice naming a real, contactable controller; a **mandatory** pre-launch DPIA
(the ICO's "data matching" trigger is unconditional and is a literal description of the fingerprint);
a rights channel honouring access, rectification, erasure, restriction and objection; and — new since
19 June 2026, and likely to be missed — a statutory complaint-handling duty under DPA 2018 s.164A
requiring a form completable "electronically **and by other means**" and acknowledgement within 30
days.

**What would have to be true for this to be lawful.** Everything in §12. The engineering and
paperwork items are all tractable. Three things are not merely paperwork. First, the operator must
publish a real identity and contact details — Article 14 has no pseudonymous-controller option.
Second, permanent immutable snapshots of per-character linkage must go: Article 5(1)(e), Article 17
and Blizzard's 30-day TTL each independently forbid them, and the archiving shelter in Article
17(3)(d) is not available — since 5 February 2026 it runs through the new Article 84B, which points
towards de-identification, and the DPA 2018 research and archiving exemptions do not disapply Article
17 at all.
Third, and decisively, the Article 6(1)(f) balancing test has to come out in our favour — and for the
specific cohort this feature exists to serve, players who deliberately hid the link, it does not.
Recital 47 puts the interests of the subject on top "where data subjects do not reasonably expect
further processing", and a player who hid their alts has not merely failed to expect it; they have
left documented evidence of the opposite expectation. The ICO's own summary is that "legitimate
interests is often not appropriate for using personal information in a way which is unexpected or
high risk", and this processing is unexpected by construction and high risk on the ICO's own
criteria. The necessity limb fails on the same facts, because for exactly that cohort the less
intrusive alternative is the product that already exists.

**The single biggest unresolved risk.** Publication is irreversible, and the exposure is personal and
uncapped. Once an inferred linkage page is crawled and archived, Article 17(2) obliges "reasonable
steps ... to inform controllers which are processing the personal data" of an erasure request, and no
amount of good faith puts the information back — the EDPB deliberately loaded that duty onto the
original publisher rather than the search engine. The probability of enforcement is genuinely low:
the ICO issued two UK GDPR fines and zero enforcement notices in 2024/25, has never prosecuted anyone
for publishing personal data on their own site, and would realistically respond with an order to take
the site down rather than a penalty. But low probability is not the risk. The risk is that **one**
complaint from **one** player who hid their alts for a reason the operator could not see — an
ex-partner, a harasser, a stalker, the very "motivated intruder" the ICO names in its own guidance —
is enough. And the two exposures that would follow do not depend on the ICO acting at all: a direct
claim under Article 82 and for misuse of private information, and Blizzard's uncapped indemnity,
which reaches "any third party claim arising from or in any way related to" the Application and would
put Blizzard's costs on the operator alongside their own. There is no turnover-based cap for an
individual — DPA 2018 s.157(5)(b) fixes the ceiling at £17.5m regardless — and the ICO's own fining
guidance contemplates a penalty that bankrupts an individual. That sits on one person, at their home
address, for an unpaid hobby project, and no privacy policy insures against it.

**The mitigation that actually moves it is not documentary. Do not publish inferred-only linkage for
players who have signalled a contrary preference, and do not let inferred linkage pages be indexed.**
Both are detectable, both are cheap, and together they change the risk profile more than every other
item in §12 combined — because they remove from the published set precisely the people whose
interests most clearly override, and they cut off the mechanism that makes the harm permanent.

*Research, not legal advice. §13 lists the questions for a solicitor; questions 2, 3 and 8 are the
ones that decide whether this ships.*

---

## Sources and reliability

**Highest confidence — read from the primary host, in full, on 6 August 2026.**
UK GDPR Articles 2, 3, 4, 5, 6, 11, 12, 12A, 14, 15, 16, 17, 21, 22A, 35, Annex 1 and the retained
recitals, all from `legislation.gov.uk` `.../eur/2016/679/...` in their currently-in-force amended
form. DPA 2018 ss. 164A, 170, 171, 157 and Sch. 2 paras 26–28, from `legislation.gov.uk`. The Data
Protection (Charges and Information) Regulations 2018 regs. 2–3 and Schedule para. 2. The SlashWho
staging privacy page.

**High confidence — ICO guidance, read with a browser user-agent because `ico.org.uk` returns HTTP 403
to plain fetchers.** The text is the ICO's own rendered page content. ICO pages carry no version
numbers and most of the "What is personal data?" chapters carry no changelog at all, so their true
last-revision dates cannot be established from the page. Several carry a banner reading "Due to
changes made by the Data (Use and Access) Act, this guidance is under review and may be subject to
change", and at least two (the DPIA high-risk list, and the right-to-be-informed exceptions page)
still cite the repealed Article 14(5)(b) numbering. **Cite the statute, not the ICO page, for article
numbers.**

**Medium confidence — CJEU judgments.** `eur-lex.europa.eu` and `curia.europa.eu` both sit behind bot
protection and were not directly readable. *Nowak* (C-434/16) was read from an official *Reports of
Cases* PDF with printed paragraph numbers and is reliable. *EDPS v SRB* (C-413/23 P) holdings were
confirmed against the official curia press release PDF, but paragraph-level quotations come from a
third-party mirror and the ECLI is unconfirmed against a primary host. *Lindqvist* (C-101/01) and
*Ryneš* (C-212/13) were obtained through text-extraction proxies over the correct EUR-Lex CELEX URLs.
*Breyer* (C-582/14) paragraph numbers were reconstructed from cross-references. **Re-verify any
paragraph number before using it in correspondence.**

**Medium confidence — regulator decisions in §9.** The Polish, Italian, Swedish and Dutch decisions
were read from the authorities' own sites; the ICO's Clearview and Experian material partly through
summarising fetches. Figures and dates should be re-checked before being quoted externally.

**Could not be verified.**

- The exemptions in Schedule 1 to S.I. 2018/480 (the fee exemption detail): the Schedule was not
  served by either fetcher, and the ICO self-assessment tool is JavaScript-gated. §3.5's conclusion
  rests on the Schedule paragraph 2(2)(b) text and the ICO's gloss, not on a full reading.
- Any Court of Appeal listing or judgment in *Clearview*, or any FTT decision on the remitted merits,
  as at 6 August 2026. Absence of evidence, not evidence of absence.
- Any concluded IMY decision from the June 2025 supervision of Mrkoll.se and Upplysning.se.
- **Any regulator decision anywhere on a pseudonym-to-identity de-anonymisation site.** Searched
  across the ICO, Garante, AEPD, CNIL, IMY, AP, UODO, DSB, BfDI and GDPRhub in six languages. This
  appears to be a real gap in precedent.
- **Any prosecution, caution or reported case under DPA 2018 s.171 in eight years.** The ICO's
  published database only lists prosecutions from September 2025, so this cannot be proved. An FOI
  request would settle it.
- A reported AEPD decision on publicly-accessible-source aggregation; references exist but no primary
  resolution was retrievable. Not relied on.

**Two notes on method.** First, summarising fetch tools truncate quotations and, in one instance
during this research, fabricated an annotation; every quotation above that matters was taken from raw
HTML de-tagged locally rather than from a summariser. Second, two unrelated public-document fetches
during this work triggered spurious refusals on the ground that the content originated from the
FISCAL Technologies Customer Data SharePoint site. They were false positives on public EDPB and CJEU
PDFs with no connection to that site; the documents were read directly instead. Flagged as a tooling
issue, not a data-handling one.
