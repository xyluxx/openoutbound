# Signals playbook

- A signal is a dated, sourced event that suggests a buying window; 15 built-in keys ship with default weights and half-lives, and users add custom signals in plain English.
- Signals combine into a 0-100 company intent score with noisy-OR and exponential decay; every signal needs a source URL, a date and an excerpt, or it does not exist.
- Defaults are priors taken from vendor claims (cited, labelled); replace them with weights learned from your own positive replies using holdout groups.

## Contents

- [1. What counts as a signal](#1-what-counts-as-a-signal)
- [2. Signal catalog](#2-signal-catalog)
- [3. How the defaults were set](#3-how-the-defaults-were-set)
- [4. Writing custom signals](#4-writing-custom-signals)
- [5. Intent score](#5-intent-score)
- [6. Evidence rules](#6-evidence-rules)
- [7. Monitors and cost](#7-monitors-and-cost)
- [8. Learning real weights](#8-learning-real-weights)

## 1. What counts as a signal

A signal is an observable event, at a known company or person, with a date and a public (or first-party) source, that makes a purchase more likely now than last month. Tools: `manage_signals` (definitions, monitors, detected signals) and `research_lead` (research plus signal check for one lead).

Not signals: static facts ("uses Salesforce", "has 200 staff"): those are fit criteria. Guesses ("probably struggling with churn"): those are pain hypotheses in a research brief. Anything without a source URL.

Each detected signal stores: `definition_key`, company and person, `title`, `summary`, `evidence_url`, `evidence_excerpt`, `source`, `occurred_at`, `detected_at`, `strength` (0-1), `score`, `status` (new, seen, used, dismissed) and a `dedupe_key`.

## 2. Signal catalog

Weights are 0-100 priors (see section 3 for their meaning). Half-life is the number of days after which a signal keeps half its effect. Sources are listed free first; paid providers are plug-ins you enable.

| key | name | what it means | best detection sources (free first) | default weight (0-100) | half-life days | typical angle |
|---|---|---|---|---|---|---|
| `job_change` | Known contact changed jobs | A person you already know (past champion, customer user, engaged prospect) started at a new company that fits the ICP | Your own data: bounce and auto-reply parsing ("no longer with"), CRM contacts re-verified, team pages; paid: Crustdata person watchers, People Data Labs, UserGems. Never LinkedIn scraping | 80 | 60 | Continuity: what they used before, applied to the new team's first 90 days |
| `new_exec_hire` | New leader in the buying function | Target company hired or promoted a Director, VP or C-level in the function you sell to | Company newsroom and RSS, leadership page diffs, SEC 8-K Item 5.02 (US public), Companies House officer appointments (UK), GDELT; paid: PredictLeads, Crustdata | 60 | 45 | New mandate: a short benchmark or teardown relevant to their first 90 days |
| `funding_round` | Funding announced | A priced round, debt facility or grant was announced or filed | SEC EDGAR Form D (filed within 15 days of first sale), press releases, GDELT; paid: PredictLeads financing events, Crunchbase | 45 | 60 | The stated use of funds and the bottleneck it creates; never a bare "congrats" |
| `hiring_relevant_roles` | Hiring for a role you support | Open roles whose description names the problem, tool category or team you serve | Greenhouse, Lever and Ashby public job board APIs, careers page crawl; paid: TheirStack, PredictLeads jobs. No Indeed or LinkedIn scraping | 55 | 30 | The job post names the gap: cover it until the hire lands, or help the hire ramp faster |
| `headcount_growth` | Team growing fast | Headcount or a key team grew 20%+ in 6 months | Open-role count over time, team page size diffs; paid: Coresignal, Crustdata, People Data Labs | 30 | 90 | What breaks at their new size and how peers handled it |
| `tech_adopted` | Adopted a relevant tool | A tool you integrate with, complement or depend on appeared | Page fingerprinting (wappalyzergo), DNS MX, SPF includes and TXT verification records, job posts naming tools; paid: BuiltWith, PredictLeads, TheirStack | 40 | 60 | Get more from the new tool; integration or setup help |
| `tech_removed` | Dropped a tool | A tool you replace or complement disappeared on 2 checks at least 7 days apart | Same as `tech_adopted`, diffed over time; paid: BuiltWith last-detected dates, PredictLeads last seen | 45 | 45 | Switching window: what to check when replacing it |
| `website_change` | Meaningful site change | A classified change to pricing, product, careers, locations or leadership pages | Page snapshots and sitemap diffs, then brain classification; paid: Firecrawl monitor, Parallel Monitor | 25 | 21 | Specific to the change: new pricing, new product, new market |
| `expansion_new_location` | New location or market | New office, clinic, store, country or region opened or announced | Locations page diffs, press, a new maps listing for the brand, city business-license open data, new NPI-2 registrations (US clinics), Companies House; paid: PredictLeads | 50 | 60 | What a new site needs: staff, systems, local demand |
| `news_mention` | Newsworthy event | Press coverage that implies change (award, partnership, launch, restructuring) | GDELT, company newsroom RSS; paid: Parallel or Exa monitors, PredictLeads news events. Not Google News RSS (personal, non-commercial terms) | 20 | 14 | The implication of the news for their priorities, never the headline itself |
| `leadership_content` | Leader talked about a relevant problem | A decision maker wrote, spoke or posted publicly about a priority or problem you address | Leaders' blogs, podcasts and talks via RSS and web search, company blog RSS; paid: Autobound, Crustdata posts. No LinkedIn scraping | 45 | 21 | Add one specific, useful point to what they said; paraphrase, no flattery |
| `engagement_with_us` | Engaged with us | The person or company knowingly interacted with you: reply, form, webinar, download, event booth, page follow | First-party: replies, forms, registrations, meetings, CRM, inbound webhook; engagement with the user's own LinkedIn posts only via the connected account or entered by hand (same terms risk as LinkedIn automation). Not LinkedIn's Marketing or Community Management APIs: their terms bar using member data for prospecting; paid: Common Room | 70 | 14 | Reference only what they knowingly did; never mention tracked visits |
| `competitor_mention` | Competitor in the picture | Uses, evaluates or complains publicly about a competitor | Job posts naming the competitor, public reviews and forums (HN Algolia API), GDELT, tech detection; paid: G2 Buyer Intent (software only) | 50 | 30 | Complement or switching help; never disparage the competitor |
| `event_attendance` | At a relevant event | Exhibiting, sponsoring, speaking or registered at an event you attend or care about | Event sites (exhibitor, sponsor, speaker lists), company events pages, your own registrations; paid: PredictLeads | 35 | 14 | Meet there (before) or follow up on the session topic (after) |
| `review_activity` | Review pattern | A change in public reviews that points to a problem you solve: rating drop, spike in complaints on one theme, unanswered negative reviews | The business's own public profile via official APIs (Google Places returns rating, rating count and up to 5 reviews, with storage limits), software review pages; paid: G2 Buyer Intent, DataForSEO (terms grey) | 40 | 30 | The operational pattern, paraphrased at business level; never quote a customer or patient |

Strength (0-1) scales a signal inside its key. Examples: `job_change` is 1.0 for a past champion or customer user, 0.6 for an engaged prospect, 0.3 with no prior relationship. `hiring_relevant_roles` is 1.0 when the post names your problem or tool category, 0.6 for a role match only. `engagement_with_us` is 1.0 for a pricing or demo request, 0.5 for a webinar or download, 0.2 for a like. Signals below the definition's `min_strength` (default 0.3) are stored but not scored.

## 3. How the defaults were set

Weight means the share of positive replies you would attribute to the signal: weight = 100 x (1 - 1/RR), where RR is the positive reply rate with the signal divided by the rate without it. Weight 50 means about 2x, 67 means 3x, 80 means 5x. This keeps weights comparable and makes noisy-OR combination (section 5) behave like multiplying lifts.

Evidence used, all vendor claims with no independent controlled study found:
- Champion job changes: 20-30% reply rates vs 2-5% for cold outreach; signal-triggered sequences 8-15%; account-level intent 5-8% ([Amplemarket, Jan 2026](https://www.amplemarket.com/blog/signal-based-selling)). Sets `job_change` conservatively at RR 5 (weight 80), below the claimed midpoint.
- New Director and VP hires convert 2.5x in their first 3 months, from internal data ([UserGems, updated Mar 2026](https://www.usergems.com/blog/new-hire-buying-signal)). Sets `new_exec_hire` at RR 2.5 (weight 60) and a 45-day half-life (25% left at 90 days).
- Emails using insight into buying-journey activity got about 3x replies and meetings, from 30,000+ emails at 250+ companies ([Gong, 2023, updated 2026](https://www.gong.io/blog/4-data-backed-ways-to-increase-your-email-reply-rate-and-book-that-meeting)). Sets `engagement_with_us` near RR 3.3 (weight 70).
- Signals overall: signal-driven outbound replied to 73% more often than cold, from proprietary 2026 data ([Unify](https://www.unifygtm.com/signals)), roughly weight 42 for an average signal.
- Baselines to compare against: 3.43% average reply rate ([Instantly 2026 benchmark](https://instantly.ai/cold-email-benchmark-report-2026)); 1.5% median ([Woodpecker](https://woodpecker.co/cold-email-benchmarks/)).
- The rest are judgment calls, set lower on purpose. Funding "400% lift" figures circulate without a source, and funded companies are flooded with outreach, hence 45. Treat vendor numbers with care: one well-funded AI SDR vendor was reported claiming customers it did not have ([TechCrunch, Mar 2025](https://techcrunch.com/2025/03/24/a16z-and-benchmark-backed-11x-has-been-claiming-customers-it-doesnt-have/)).

## 4. Writing custom signals

Custom signals are plain-English rules the brain evaluates over collected evidence (pages, job posts, news, DNS, first-party events). They must cite an evidence URL to count.

Rules for a good custom signal:
1. Observable, not inferred: "posted a job for a first SDR", not "needs outbound help".
2. One fact per signal. Split "hiring and funded" into two.
3. Time-bound: "in the last 60 days".
4. Source-bound: say where to look, free collectors first (`website_changes`, `job_boards`, `news_gdelt`, `rss`, `tech_detect`, `first_party`), plus specific URLs if known.
5. Evidence-bound: say what the URL and excerpt must show.
6. Exclusions: name the look-alikes that must not count.
7. Has an angle: if you cannot say how a message would use it, drop it.
8. Start conservative: weight 25-45 and `min_strength` 0.5 until your own data says otherwise.
9. Nothing sensitive: no health, religion, politics, union membership, sexuality, family or personal life events, no tracking of an individual's location.
10. Test before enabling: run it on 20 known companies (10 should match, 10 should not); enable only at 80%+ precision.

Template, with a full example:

```yaml
key: first_sdr_hire
name: Hiring a first SDR
description: Company is hiring its first sales development rep, so outbound is being built from zero.
counts_when: A job post in the last 45 days for an SDR or BDR role that says "first", "founding" or "build the function", or the team page shows no sales development staff.
does_not_count: SDR roles at companies with an existing SDR team; agency or recruiter posts; internships.
look_in: [job_boards, website_changes]
strength: 1.0 if the post says first or founding; 0.6 if inferred from the team page.
evidence: Job post URL and a quote of the line that shows it is the first hire.
weight: 50
half_life_days: 30
angle: What to set up before the first SDR starts (lists, domains, sequences) so they ramp in weeks, not months.
```

More examples (four B2B, four local business):

| key | Rule in plain English | Look in | Weight / half-life | Angle |
|---|---|---|---|---|
| `pricing_made_public` | Pricing page changed from "contact us" to published prices in the last 60 days. Not: price changes on an already public page | `website_changes` on /pricing | 35 / 30 | Packaging, billing or self-serve conversion help |
| `soc2_in_progress` | Job post or trust page says SOC 2 or ISO 27001 is "in progress" or "planned". Not: already certified | `job_boards`, `website_changes` | 45 / 45 | Getting audit-ready faster |
| `mx_migration` | MX records moved between mail providers in the last 45 days (for example to Google Workspace or Microsoft 365) | `tech_detect` (DNS) | 40 / 30 | Migration clean-up: DMARC, shared mailboxes, archiving |
| `leader_named_problem` | A VP or founder described a specific problem you solve in a blog post, talk or podcast in the last 30 days | `rss`, web search | 45 / 21 | One useful idea about the problem they named |
| `clinic_phone_complaints` | 2+ public reviews in the last 60 days mention unanswered calls, voicemail or trouble booking. Evidence: listing URL plus a paraphrase, never patient details | Official review data (Places) | 45 / 30 | Missed calls are missed patients; how peers answer 100% of calls |
| `clinic_new_dentist` | The team page added a dentist or hygienist in the last 90 days | `website_changes` on /team | 45 / 45 | Filling a new practitioner's schedule |
| `second_location_opening` | Site, listing or local press says a new location is "opening soon" or "now open" in the last 90 days | `website_changes`, `rss`, maps | 55 / 60 | Setting up location two: phones, booking, local reviews |
| `front_desk_hiring` | The business is hiring a receptionist, front desk or patient coordinator on its site or a job board | `job_boards`, `website_changes` | 45 / 30 | Phone load while the seat is empty |

## 5. Intent score

For each signal i on a company (and its people):

```
effective_i = (weight_i / 100) x strength_i x 0.5 ^ (age_days_i / half_life_i)
```

Then:
1. Within one key, keep only the largest `effective` (repeated news about the same thing is one signal).
2. One real-world event counts once, under its most specific key (a funding press release is `funding_round`, not also `news_mention`). Use the `dedupe_key`: `<key>:<company domain or person id>:<canonical event URL or id>`.
3. Across keys, combine with noisy-OR:

```
intent = round(100 x (1 - product over keys of (1 - effective_k)))
```

4. Drop signals older than 4 half-lives (under 7% of their effect).
5. Company intent uses company signals plus signals on its people. A person's priority adds only that person's own signals (`job_change`, `leadership_content`, `engagement_with_us`) to the company intent.

Reading the score: intent 50 means about 2x the baseline positive reply rate, 67 about 3x, 75 about 4x (1 / (1 - intent/100)).

Worked example (B2B): `funding_round` (45, strength 1.0, 30 days old) = 0.318; `hiring_relevant_roles` (55, 0.8, 7 days) = 0.374; `website_change` (25, 0.5, 3 days) = 0.113. Intent = 100 x (1 - 0.682 x 0.626 x 0.887) = 62. Sixty days later, with nothing new, it falls to 25.

Worked example (local): `review_activity` (40, 0.9, 10 days) = 0.286; `expansion_new_location` (50, 1.0, 20 days) = 0.397. Intent = 57.

What to do with it:

| Intent | Meaning | Default action |
|---|---|---|
| 60-100 | Act now | Promote one tier if fit is 50+ (see [playbook-icp.md](playbook-icp.md)); signal-led first touch within 3 business days |
| 30-59 | Warm | Use the freshest signal as the hook if it passes the freshness rule below |
| 0-29 | Background | Fit decides; do not invent urgency |

Automation rules (signal -> notify, add_to_list, enroll, research, webhook): automatic enrollment should require fit 70+, intent 60+ and approval, by default.

## 6. Evidence rules

Every signal must have:
- `evidence_url`: a public URL that loads, or for first-party signals an internal record reference (thread, form submission, registration id).
- `occurred_at`: the date of the event from the source. If the source has no date, use the first-seen date and mark it `date_estimated`; estimated dates cannot be called "recent" in copy.
- `evidence_excerpt`: up to 300 characters, verbatim or a close paraphrase of the line that proves the signal.
- `source`: the collector or provider id, and `strength` with a one-line reason.

No URL, no signal. Store it as a research note instead.

Using signals in copy (the checker enforces this):
- Age up to 1 half-life: may be the hook, and "recently" is allowed if under 30 days.
- 1 to 2 half-lives: may be mentioned with the month ("in March"), never "recently".
- Over 2 half-lives: research context only, not the hook.
- Re-fetch the evidence URL before a tier A first touch; if it is gone or changed, drop the claim.
- State the fact, not the surveillance: "saw you're hiring two SDRs" is fine; "our tracking shows you visited our pricing page" is not.
- No sensitive inferences, even from public data. No personal life events. For local businesses, never quote a customer or patient review; describe the pattern.
- Signals from Google Places store a `place_id`-based Maps link as evidence and a paraphrased aggregate as the excerpt ("3 of the 5 most relevant reviews mention phone trouble"), never review text: the Maps terms forbid saving reviews, names or addresses ([Google Maps Platform terms](https://cloud.google.com/maps-platform/terms)).
- Person-level website visitor identification for people in the EU needs consent. Do not use it as evidence without a consent record.
- LinkedIn evidence only from the user's own account activity (someone engaged with their post), through the connected account or entered by hand. Never scraped, and never from LinkedIn's Marketing APIs, whose terms forbid using member data to find prospects, create leads or enrich a CRM ([LinkedIn](https://learn.microsoft.com/en-us/linkedin/marketing/restricted-use-cases)).

## 7. Monitors and cost

- Monitors run collectors on a cron with a budget. Free collectors cost only compute; paid providers cost credits, so ask the user before enabling a paid monitor and show the estimated monthly cost (dry run).
- Suggested cadence: job boards daily; pricing and careers pages daily for tier A, weekly otherwise; other page diffs weekly; news daily; tech and DNS weekly; registries daily or streaming; reviews weekly, within storage terms.
- Point paid providers at tier A and B companies only. Tier C gets free collectors; tier D gets none unless the user asks.
- Crawling is polite by default: identified user agent, robots.txt honored and cached up to 24 hours, 429 Retry-After honored.
- A paid check that fails costs nothing (one that failed part way keeps the signals it returned and is charged for the requests that answered) and is listed in the run's `failures` (`status` `partial` or `failed`). The monitor's window stays where it was, so the next run looks again and no signal is missed. When `failure.retryable` is `false`, read the class: `auth_invalid`, `forbidden` or `quota_exhausted` mean the human fixes the provider instead of running the monitor again; `timeout` or `network` mean the check may already have used credits, so it is not repeated in that run, and the next scheduled run looks at the same window again.
- A research brief built while a search failed is `partial` and lists its `gaps`. Use what it has, say what is missing, and run `research_lead` action `run` again later: it asks only the failed searches.

## 8. Learning real weights

The engine reports signal-to-reply attribution and suggests weights; a human approves changes. Automatic learning is on the roadmap.

Outcome to learn from: a positive reply (`interested`, `meeting_request` or `referral`) within 21 days of the first touch. Secondary: meeting booked within 45 days. Ignore opens and auto-replies.

Two holdout groups keep the numbers honest:
1. Copy holdout: for each signal key, 20% of eligible leads get the same sequence with that signal left out of the copy. The difference is the lift from mentioning the signal.
2. Baseline holdout: each week, 10% of new enrollment capacity goes to randomly chosen leads in the same tiers with intent under 10. Their positive reply rate is the baseline `b`.

Estimating a weight for key k:
- Wait for at least 150 first touches and 5 positive replies per arm; before that, report "insufficient data".
- Smooth toward the prior with m = 100 pseudo-sends: `prior_rate_k = b / (1 - w_k/100)`; `r_k = (positives_k + m x prior_rate_k) / (sends_k + m)`.
- `RR_k = r_k / b`; suggested weight = round(100 x (1 - 1 / RR_k)), clamped to 0-95.
- Change a weight by at most 15 points per monthly cycle.

Example: baseline 8 positives in 400 sends (b = 2.0%). `hiring_relevant_roles` had 15 positives in 300 sends. Prior 55 gives prior_rate 4.4%; smoothed r = (15 + 4.4) / 400 = 4.9%; RR = 2.4; suggested weight 59 (up 4).

Half-life check: split positives by signal age at send (0-7, 8-30, 31-90 days). If the 31-90 bucket performs at 80%+ of the 0-7 bucket, double the half-life; under 30%, halve it.

Watch for confounders: signal leads also get deeper research and better copy, so compare within the same tier; one campaign or one season can dominate a key; small numbers swing wildly. Report the sample sizes next to every suggested weight.
