# ICP and personas playbook

- Defines who to contact: company fit, personas, disqualifiers and triggers, stored with `manage_icp` and scored 0-100 with visible reasons.
- Gives the agent a 7-question interview, pre-filled from the user's website, so setup takes minutes and every criterion has a reason.
- Maps fit tiers to research depth and spend caps, with a local-business variant (dental clinics) that uses maps, website and registry data.

## Contents

- [1. The model](#1-the-model)
- [2. Start from evidence](#2-start-from-evidence)
- [3. The interview](#3-the-interview)
- [4. Personas](#4-personas)
- [5. Disqualifiers](#5-disqualifiers)
- [6. Fit scoring rubric](#6-fit-scoring-rubric)
- [7. Tiers and research depth](#7-tiers-and-research-depth)
- [8. Local-business variant](#8-local-business-variant)
- [9. Keep the ICP honest](#9-keep-the-icp-honest)
- [10. Illustrative ICP definition](#10-illustrative-icp-definition)

## 1. The model

An ICP in OpenOutbound has four parts. Keep them separate; mixing them is the most common setup mistake.

| Part | Question it answers | Where it lives |
|---|---|---|
| Company fit | Which companies can buy and succeed with the offer? | `manage_icp` criteria + scoring; `companies.fit_score` |
| Personas | Who inside them signs, champions, uses or blocks? | `manage_icp` personas; `manage_knowledge` items of kind `persona` (the writer reads them) |
| Disqualifiers | Who must never be contacted? | ICP excludes, company status (`customer`, `competitor`, `do_not_contact`), suppressions |
| Triggers | What opens a buying window right now? | `signal_keys` on the ICP, see [playbook-signals.md](playbook-signals.md) |

Rules:
- Fit says "could buy". Intent (signals) says "might buy now". Never let intent rescue a bad fit.
- One ICP per motion. If the buyer, the offer or the deal size differs (for example SMB clinics vs a dental group HQ), create two ICPs and two campaigns.
- Every criterion carries a reason ("4 of our 6 best customers run HubSpot"). A criterion without a reason is a hypothesis: test it in a separate campaign, do not put it in the default ICP.

## 2. Start from evidence

Use evidence in this order, strongest first:
1. Best current customers (top 5-10 by revenue, retention and speed to close): what do they share that non-customers lack?
2. Recent wins: what happened at the customer in the 90 days before they bought? Those events become signals.
3. Closed-lost and churned accounts: shared traits become disqualifiers or penalties.
4. The website: `manage_knowledge` bootstrap from website suggests offers, an ICP and signals. Treat it as a draft, never as truth. Each `icp_suggestions` entry is already `manage_icp` action `create` input (exclusions in `criteria.exclude`): change what the user corrects, then pass it as is.
5. Market intuition: weakest. Label it as a hypothesis.

Lookalike traits: pick the 3-5 traits your best customers share (for example "sells to mid-market", "has an SDR team", "Series A to C"). They feed criterion C5 below.

## 3. The interview

Before asking anything, run the website bootstrap and read what it suggests. Then send one message with numbered questions, each with your pre-filled guess, so the user can answer "1 yes, 2 yes, 3 change to ...". Ask only what the website did not answer.

| # | Ask | Feeds |
|---|---|---|
| 1 | "What do you sell, to whom, and what result can you prove? My draft: ..." | Offer, proof items in knowledge |
| 2 | "Name 3-10 of your best customers (domains are enough) and why each bought." | Lookalike traits, triggers, proof |
| 3 | "Who signs, who champions, who uses, who can block? Titles are fine." | Personas |
| 4 | "Which industries, company sizes, countries and languages do you serve? Anything you cannot serve?" | Criteria C1-C3, excluded countries |
| 5 | "Who must never be contacted: customers, open deals, partners, competitors, regions? Can you share a CRM export?" | Disqualifiers, suppressions |
| 6 | "What usually happens right before someone buys: hiring, a new leader, funding, a new location, a tool change, a complaint?" | Signal keys, custom signals |
| 7 | "Typical deal size, sales cycle, and what counts as success (reply, meeting, trial)? Monthly budget for data and AI?" | Tier spend caps, campaign goal, budgets |

Ask only if relevant: public proof you may cite (logos, numbers), tone and language, sending capacity (mailboxes, LinkedIn accounts), and whether they target Germany or Austria (consent rules, see [playbook-compliance.md](playbook-compliance.md)).

If the user does not know an answer, propose a default, mark it `hypothesis` and move on. Do not block setup on perfect answers. Before writing with `manage_icp`, show a summary of 15 lines or fewer and get a yes. Put the user's words in `reason`.

## 4. Personas

Roles to map for every ICP:
- Economic buyer: owns the budget and signs.
- Champion: feels the pain daily and sells internally. Usually the best first contact in mid-market.
- User: works with the product; good for proof, rarely signs.
- Blocker or evaluator: security, IT, procurement, legal. Do not cold email them first.
- In small businesses the owner often holds all four roles.

Persona card (store one knowledge item per persona):

| Field | Example (RevOps champion) |
|---|---|
| Functions and title variants | Revenue Operations, Sales Operations, GTM Operations; "RevOps Manager", "Head of Sales Ops" |
| Seniority | Manager to Director |
| Exclude titles | Intern, Assistant, Recruiter, Account Executive |
| Measured on | Forecast accuracy, pipeline hygiene, tool cost |
| Top pains in their words | "Reps skip CRM updates", "Our data is stale", "Too many tools" |
| Triggers that matter | New CRO hire, CRM migration, SDR team growth |
| Proof that lands | Peer company of similar size, time saved per rep per week |
| Likely objections | "We just renewed", "No bandwidth this quarter" |
| Never say | Anything implying their current work is poor |

Rules:
- Match on function plus seniority, not exact title strings. Keep include and exclude lists.
- Contact order: champion first in mid-market; economic buyer first in SMB or when the offer is strategic.
- At most `contact_cap_per_company` active enrollments per company (default 3). Stagger people at the same company by at least 3 business days and give each a different angle. Never send the same text to two people at one company.

## 5. Disqualifiers

Hard disqualifiers set the score to 0, block enrollment and log the reason:
- Existing customer, open opportunity, partner or competitor.
- Any suppression: unsubscribed, bounced, complaint, manual, `do_not_contact`, `gdpr_erasure`.
- Excluded country, or a consent-required country without recorded consent (engine default `DE`, `AT`, `IT`, `ES`, `NL`, `DK`, `PL`, `BE`; see [playbook-compliance.md](playbook-compliance.md) section 4).
- Company size or type you cannot serve (hard minimum and maximum).
- Company closed or dormant: dissolved in a registry, dead website, maps listing closed.
- Currently enrolled elsewhere, or contacted within `rest_days_after_campaign` (default 30 days).
- Sectors the user excludes (common: gambling, adult, weapons, political campaigns).
- Personal mailbox domains (gmail.com, outlook.com and similar) in a B2B motion. The SMB variant may allow owner addresses if the user confirms.

Soft penalties (lower the score, do not exclude): unknown size or industry, generic inbox only (info@), catch-all email, data older than 180 days, no website.

AI refinement may never score around a hard disqualifier.

## 6. Fit scoring rubric

Deterministic rules first, then optional AI refinement. Each criterion writes a reason line into `fit_reasons`, for example `industry: core (B2B software) +20`.

Company criteria (65 points):

| ID | Criterion | Weight | Full points | Partial | Zero |
|---|---|---|---|---|---|
| C1 | Industry or vertical | 20 | In the core list | Adjacent list: 10 | Other: 0 |
| C2 | Size (employees, revenue or locations) | 15 | Inside the sweet spot | One band outside: 7 | Beyond hard limits: disqualify |
| C3 | Geography and language | 10 | Core market, language you write in | Secondary market: 5 | Not served: disqualify |
| C4 | Model and stack fit | 10 | Has the setup the offer needs (sells B2B, runs a sales team, uses a stack you integrate with) | Partly: 5 | Incompatible: 0 |
| C5 | Lookalike of best customers | 10 | Shares 3+ lookalike traits | 1-2 traits: 5 | None: 0 |

Person criteria (25 points) and reachability (10 points):

| ID | Criterion | Weight | Full points | Partial | Zero |
|---|---|---|---|---|---|
| P1 | Function and persona | 15 | Economic buyer or champion persona | User or influencer: 8 | Other: 0 |
| P2 | Seniority | 10 | The level that decides for this offer | One level off: 5 | Two or more off: 0 |
| R1 | Contactability | 5 | Verified email or accepted LinkedIn connection | Catch-all or LinkedIn only: 2 | None: 0 |
| R2 | Data confidence | 5 | Core fields confirmed by 2 sources or refreshed within 90 days | One source or 90-180 days old: 2 | Older or conflicting: 0 |

Scores:
- Unknown values score 40% of the criterion weight (unknown industry = 8) and add a reason such as `industry unknown`. Unknowns rank below known matches but are not buried; enrichment can fix them.
- `companies.fit_score` = round(100 x (C1 + C2 + C3 + C4 + C5) / 65).
- `people.fit_score` = C1..C5 + P1 + P2 + R1 + R2, from 0 to 100.
- AI refinement (optional): may move a score by at most 10 points, must cite an evidence URL (for example "site shows they are an agency, not a software company"), is logged, and never overrides a disqualifier.

Worked example: core industry 20, sweet-spot size 15, core market 10, partial stack 5, two lookalike traits 5 = 55 company points (company fit 85). Champion persona 15, one level off 5, verified email 5, fresh data 5 = person fit 85, tier A.

## 7. Tiers and research depth

Research depth, spend and review follow the tier. Tier thresholds line up with the default `auto_research_min_fit` of 70, so tiers A and B get automatic research.

| Tier | Person fit | Research depth | Paid spend cap per lead | Copy | Review level | Channels |
|---|---|---|---|---|---|---|
| A | 80-100 | Deep: company and person brief, 3+ dated facts with URLs, all enabled signal collectors and providers, recommended angle | 5% of expected value per lead | Signal-led, custom opener | `every` for the first 20 messages, then `first` | Email + LinkedIn |
| B | 70-79 | Standard: company brief, 1-2 dated facts, top active signal | 3% of expected value | Signal-led or segment-led | `first` | Email; LinkedIn only if already connected |
| C | 50-69 | Light: website plus cached signals, free collectors only | Verification only | Segment template plus one verified observation | `first` | Email |
| D | Under 50 | None; free monitors only | 0 | Do not enroll | - | - |

Expected value per lead = average first-year deal value x lead-to-meeting rate x meeting-to-close rate. Example: $12,000 x 2% x 25% = $60, so a tier A lead may use up to $3.00 of research and enrichment. For a $1,800 SMB deal at 1.5% and 25%, the tier A cap is about $0.34. If the user does not know the rates, assume 1.5% lead-to-meeting and 20% meeting-to-close, and say so.

Promotion and ordering:
- Intent 60 or higher promotes one tier (C to B, B to A) only when fit is 50 or higher. Tier D is never promoted by intent; re-score it if enrichment changes the data.
- Enroll in order: tier, then intent score, then fit score.
- Reuse research briefs younger than 30 days. Re-research only when a new signal fires or a tier A first touch would use a brief older than 30 days.

Fit x intent:

| | Intent 60+ | Intent under 60 |
|---|---|---|
| Fit 70+ | Act now: tier A treatment, signal-led copy | Standard sequence, or monitor and wait for a signal |
| Fit 50-69 | Promote one tier, signal-led copy | Light touch or monitor |
| Fit under 50 | Check disqualifiers; maybe a new segment worth a separate test ICP | Skip |

## 8. Local-business variant

Local businesses differ: the owner is usually the buyer, deals are small, data comes from maps listings, websites and registries rather than B2B databases, inboxes are often shared (info@), phones matter, and reviews act as signals. Research must be cheap and specific.

Interview changes for a dental-clinic offer (for example patient call answering or online booking):
- Service area: cities, postal codes or a radius.
- Practice types: general, cosmetic, orthodontic, pediatric.
- Size you serve: practitioners, chairs or locations.
- The outcome a clinic buys: new patients, fewer no-shows, answered calls, better reviews.
- Prerequisites: must the clinic have a website, a practice management system, online booking?

SMB fit rubric (100 points):

| ID | Criterion | Weight | Full points | Partial | Zero |
|---|---|---|---|---|---|
| S1 | Category (maps primary type, registry taxonomy, website) | 20 | Core type (general dentistry) | Adjacent (orthodontics, pediatric): 10 | Other: 0 |
| S2 | Service area | 15 | Inside target area | Neighboring area: 7 | Outside: disqualify |
| S3 | Size proxy | 15 | 2-10 practitioners on the team page, or 2-3 locations | Single practitioner: 7 | 11+ or a chain: route to a group ICP |
| S4 | Need evidence | 20 | 2+ observed gaps the offer fixes (no online booking, phone-only scheduling, unanswered negative reviews) | 1 gap: 10 | None seen: 0 (unknown: 8) |
| S5 | Independence | 10 | Owner-operated | Unclear: 4 | Managed by a DSO or franchisor: disqualify for the local ICP |
| S6 | Operating health | 10 | Operational, reviews within 6 months, rating 3.5+ | Some activity: 5 | Dormant: 0; closed: disqualify |
| S7 | Reachability | 10 | Named owner or manager plus verified email or direct line | Verified generic inbox: 5 | Phone only: 2 |

Disqualifiers specific to SMB: permanently closed listing; DSO- or franchise-managed (decisions sit at HQ); outside the service area; existing customer; a consent-required country (Germany, Austria, Italy, Spain, the Netherlands, Denmark, Poland, Belgium) for cold email without consent; UK sole traders and some partnerships for cold email without consent (PECR); no reachable channel at all.

Data sources, free first:
- Google Places API (New) Text Search to discover businesses: name, address, types, `businessStatus`, `googleMapsUri`. Fields such as `rating`, `userRatingCount`, `websiteUri` and `nationalPhoneNumber` bill at the Enterprise tier, so estimate cost and ask before large searches ([field list](https://developers.google.com/maps/documentation/places/web-service/data-fields)). The Maps terms forbid copying and saving business names, addresses or reviews: store only `place_id` long term, and take the name, address, phone and email you keep from the business's own website or a registry, citing that as the source (see [playbook-compliance.md](playbook-compliance.md)).
- The clinic website: team page (practitioner count, owner name), contact page, booking widget, opening hours.
- US: the free [NPPES NPI Registry API](https://npiregistry.cms.hhs.gov/api-page). Organization (NPI-2) records include an authorized official name, title and phone. Records can be years old: confirm on the website before use.
- Germany: section 5 of the Digitale-Dienste-Gesetz ([DDG section 5](https://www.gesetze-im-internet.de/ddg/__5.html)) requires business sites to publish an imprint with name, address, email and, for legal persons, the authorized representative. It gives you a name for a phone call or letter, not consent to email.
- UK: [Companies House](https://developer.company-information.service.gov.uk/) lists directors of limited practices.

Decision makers: the owner or principal dentist (economic buyer) and the practice or office manager (champion and gatekeeper, often the reader of info@). Check ownership before pitching: DSO affiliation is common and growing; in 2024 more than 1 in 4 US dentists within 10 years of graduation were DSO-affiliated ([ADA News, Nov 2025](https://adanews.ada.org/new-dentist/2025/november/hpi-more-new-dentists-affiliated-with-dsos/)).

Research depth for SMB: tier A gets two observations (website and reviews) plus one local fact; tier B gets one observation; tier C gets a template with the city and one verified fact. No person-level research beyond name and role. Never quote or describe a patient review about treatment or health; describe the business pattern instead ("several recent reviews mention trouble getting through by phone").

Useful SMB signals: `expansion_new_location`, `review_activity`, `hiring_relevant_roles` (receptionist, hygienist), `website_change` (new site, booking added or removed), `tech_adopted` and `tech_removed` (booking or chat widgets).

## 9. Keep the ICP honest

- Monthly, run `get_report` for ICP performance: positive reply rate and meetings by tier and by criterion.
- The ICP is miscalibrated if, after 300+ sends per tier, tier A does not reach at least 1.5x the positive reply rate of tier C. Adjust weights before thresholds.
- More than 10% of replies saying "wrong person": fix persona titles and seniority.
- Many "not a fit" objections: tighten C1, C2 or C4, or add a disqualifier.
- High bounces in one segment: the data source for that segment is bad; switch or re-verify.
- Change one thing at a time. Create a new ICP for a test and point a new campaign at it; do not edit the ICP of a running test.

## 10. Illustrative ICP definition

Illustrative shape only (exact fields are in `references/tools.md`). Invented company.

```yaml
icp:
  name: "Mid-market B2B software, RevOps buyer"
  reason: "5 of 7 best customers: B2B software, 50-500 staff, HubSpot or Salesforce, SDR team"
  criteria:
    industries_core: [b2b software, fintech software]
    industries_adjacent: [it services]
    employees: { sweet_spot: [50, 500], hard_min: 20, hard_max: 2000 }
    countries_core: [US, CA, GB, IE, NL]
    countries_secondary: [SE, DK, AU]
    stack_fit: [hubspot, salesforce]
    lookalike_traits: [sells to mid-market, has SDR team, series A to C]
    exclude_statuses: [customer, competitor, do_not_contact]
  personas:
    champion: { functions: [revenue operations, sales operations], seniority: [manager, head, director] }
    economic_buyer: { functions: [sales, revenue, finance], seniority: [vp, c_level] }
    exclude_titles: [intern, assistant, recruiter, account executive]
  scoring:
    weights: { C1: 20, C2: 15, C3: 10, C4: 10, C5: 10, P1: 15, P2: 10, R1: 5, R2: 5 }
    unknown_share: 0.4
    ai_refinement_max: 10
  tiers: { A: 80, B: 70, C: 50 }
  signal_keys: [hiring_relevant_roles, new_exec_hire, tech_adopted, funding_round, engagement_with_us]
```
