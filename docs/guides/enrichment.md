# Enrichment

This guide shows how OpenOutbound finds and verifies email addresses: the waterfall, the website crawler, the finders and verifiers you can plug in with their costs, and the catch-all policy.

## The short version

1. Configure one verifier and one or two finders (or none: the free website crawler still runs).
2. Run `enrichment enrich --dry-run` on a list, read the counts, then run it for real.
3. Send only to `valid` addresses (the default). Catch-all addresses are skipped unless you allow them.

## The waterfall

`enrichment enrich` (MCP: `enrich_leads` action `enrich`) runs these steps for each person, in the background:

| Step | What happens | Cost |
| --- | --- | --- |
| 1. Contactability | People we may never email are skipped: suppressed, `do_not_contact`, unsubscribed, customers, people at competitor or customer companies, excluded and consent-required countries, possible UK sole traders | Free |
| 2. Existing address | Verified (when `data.enrichment.verify_existing` is on, the default), unless it was checked in the last 30 days with a clear result. A `valid` or `catch_all` result ends here. A `risky` or `unknown` address checked in the last 30 days also ends here (kept, reason `checked_recently`): the finders are not paid again until the check is older than 30 days, unless you pass `--force`. A system address such as noreply@ counts as no address. | 1 verifier credit |
| 3. Website | The company website is crawled for the person's own published address | Free |
| 4. Finders | Each finder in order until one returns an address that the verifier does not reject. A finder that answers "no match" is not asked again for that person for 30 days. When every finder asked answered "no match" and no step failed, the time is stored on the person (`email_not_found_at`) and the next runs skip the finders for 30 days (not found, reason `not_found_recently`), unless you pass `--force` | Credits per found address |
| 5. Pattern guessing | Off by default. Tries first.last@, first@, flast@ and firstlast@ with the verifier; accepts only `valid` | Up to 4 verifier credits |
| 6. Role address | Only with `--allow-role-addresses`: a published shared inbox such as info@ on the company domain, verified `valid` | 1 verifier credit |

A finder's own `valid` is trusted without a second check. A candidate the verifier calls `invalid` moves on to the next finder; `catch_all`, `risky` or `unknown` ends the search with that result. A finder or verifier call that fails (no credits, bad key, rate limit, timeout) is recorded as a failed step and the next finder runs; see [When a provider fails](#when-a-provider-fails).

Every address found is screened before it is verified or stored. System addresses (noreply@, postmaster@, abuse@ and similar) are passed over. A suppressed address or domain, including an address erased with `forget`, ends the search for that person, who is skipped with `suppressed_email` or `suppressed_domain`.

The result is stored on the person: `email`, `email_status`, `email_source` (the page URL, the finder id or `pattern_guess`) and when it was checked. The person's `enrichment` field (in `get_lead`) keeps the last run: its `status`, the finders that answered "no match" and when (`no_match`), the steps that failed (`failed`) and when the engine retries them (`retry_at`). `enrichment.completed` fires once per person, including skipped ones, with the same `status`.

Each person ends a run with one status:

| Status | Meaning |
| --- | --- |
| `found` | A new address was found (and verified when a verifier is configured) |
| `verified` | The address on file was checked |
| `kept` | The address on file stays as it was, for example because it was checked recently |
| `not_found` | No usable address and no step failed; the reason says more, for example `not_found_recently` |
| `skipped` | Not looked up: the person may not be emailed, the address is suppressed, or the budget ran out |
| `provider_failed` | Nothing usable was found and at least one finder or the verifier failed. The reason is the failure class, for example `rate_limited`. Never counted as not found |

| Command | Use |
| --- | --- |
| `enrichment enrich --list-id ls_... --dry-run` | Counts: people, with email, to verify, to find, kept because they were checked recently, skipped because the finders found nothing in the last 30 days, blocked by reason, finder order, verifier, and an estimate of credits |
| `enrichment enrich --list-id ls_...` | Runs the waterfall as a background job (up to 1,000 people per call; batches of 25) |
| `enrichment enrich --person-ids ... --mode verify_only` | Only checks existing addresses |
| `enrichment verify --person-ids ...` | Checks up to 25 people's current addresses right away |
| `enrichment find-contacts --company-ids ...` | Finds the people and published addresses on company websites (below) |

All of them need the `spend` scope and count against `settings.data.monthly_credit_budget`: each finder or verifier call needs at least 1 credit left, and once less is left the remaining people are skipped with `budget_exceeded`, so a run never ends above the budget. The dry run shows `budget` (monthly, used and left this month) and warns when its estimate is more than what is left. Treat the dry run's credit number as a rough guide, not a ceiling: invalid results let the next finder charge again, and pattern guesses are not counted.

## When a provider fails

A provider call can fail: a timeout, a rate limit, a server error, a rejected key or no credits left. The engine never stores a failure as "nothing found".

| What you see | Meaning |
| --- | --- |
| A step `<provider>:provider_failed` in the person's `steps` (job result) | That call failed. `failed` lists it with the failure: its class, whether the engine repeats the call by itself (`retryable`) and whether it concerns the call, the account or the whole provider (`scope`) |
| Status `provider_failed` | Nothing usable was found and a step failed |
| Status `kept` with a failure class as reason | The check of the address on file failed; the address and its status stay as they were |
| `failures` in the job result | Failed calls counted by provider and class |
| `retry` in the job result | The follow-up run the engine scheduled: its job id, when, and for how many people. Null when there is none |

What the engine does by itself:

- A failed call costs no credits.
- After a failure of a provider's account or of the whole provider (bad key, no credits, rate limit, server trouble), the run stops calling that provider. The people after that get the same failed step without a call.
- When a failure the engine may repeat (`retryable`: a rate limit, a server error, a call that never reached the provider) left people without a `valid` or `catch_all` address, the job schedules one follow-up run for just those people, 15 minutes later (later when the provider asked for a longer wait). At most 2 follow-up runs; none once the data budget is used up. A run stopped by the data budget stores `skipped` in the `enrichment` of every person it did not reach, with their earlier failures and no `retry_at`, so nobody waits for a follow-up that will not come.
- A paid finder or verifier call that timed out, or whose connection broke after the request was sent, is not followed up: it may already have used credits. That person stays `provider_failed` with class `timeout` or `network` and `retryable: false`, although the key is fine. Enrich them again by hand when you need the address.
- The same holds for an Icypeas search whose status check failed after the search started (a rate limit, a server error, a timeout): the failure keeps its class, with `retryable: false`, since the search may still find and charge for the address.
- A follow-up run that another step's failure brings does not ask such a step again either: it shows `<provider>:not_repeated` and its failure stays in `failed`. Only a run you start asks it again.
- The next run, scheduled or yours, asks only what failed: the finders that answered "no match" are skipped, and so is the finder whose address is on file while that address was checked in the last 30 days (step `<finder>:found_recently`; the person is `kept` with reason `found_recently`, nothing is paid twice). A recent check or a recent "nothing found" does not hold the failed finder back. `email_not_found_at` is not set while a step failed.

What you do: read `failed[].failure.retryable`. When it is `false`, the engine does not repeat that call by itself, and the class says why:

- `auth_invalid`, `forbidden` or `quota_exhausted` (a rejected key, a missing permission, no credits): fix the provider first (`manage_providers` action `test`, then a new key or more credits), then run `enrichment enrich` again for those people.
- `timeout` or `network`, or a class that is usually retried such as `rate_limited` or `unavailable` (an Icypeas search whose status check failed): the paid call may already have used credits. Nothing to fix; run `enrichment enrich` again for those people when you need their address.

Do not run it again in a loop: the failed steps repeat until the cause is fixed.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `data.enrichment.finders` | `[]` | Finder ids in order, for example `["icypeas","findymail"]`. Empty means every configured finder, by priority. Add `website` to move the crawler. |
| `data.enrichment.verifier` | `null` | The verifier id; empty means the first configured one |
| `data.enrichment.verify_existing` | `true` | Verify addresses people already have |
| `data.enrichment.pattern_guessing` | `false` | Guess and verify common patterns. Off by default: guessed addresses carry extra legal risk. |
| `data.enrichment.website_crawler` | `true` | Look for published addresses on the company website |
| `data.enrichment.crawler_excluded_countries` | `[]` | Never crawl for companies in these countries. Empty by default: the crawler records the page that publishes each address, the evidence Canada and Australia need |
| `sending.require_verified_email` | `true` | Only email `valid` addresses |
| `sending.catch_all` | `skip` | `skip` catch-all addresses, or `allow` them (treated like valid ones) |

```bash
openoutbound --workspace acme workspaces update --settings '{"data":{"enrichment":{"finders":["icypeas","findymail"],"verifier":"millionverifier"}}}'
```

Without a verifier, found addresses keep the finder's status (website finds stay `unknown` and are not sent while `require_verified_email` is on), and pattern guessing and role addresses are off.

## Finders and verifiers

Configure them with `providers set --slot email_finder` or `--slot email_verifier` (see [Providers](../concepts/providers.md#configure-a-provider)), or with their env vars.

| Finder | Env var | Looks up by | Credits in OpenOutbound | Price per 1,000 found (as of September 2026) |
| --- | --- | --- | --- | --- |
| `icypeas` | `ICYPEAS_API_KEY` | Name and domain | 1 per found address | $19, down to $4.99 at volume |
| `findymail` | `FINDYMAIL_API_KEY` | LinkedIn URL first, else name and domain | 1 per found address | $19.80; refunds if over 5% bounce |
| `hunter` | `HUNTER_API_KEY` | Name and domain, else LinkedIn handle | 1 per found address | $24.50, down to $11.96 |
| `prospeo` | `PROSPEO_API_KEY` | Person details; verified addresses only | 1 per found address (free enrichments cost 0) | not in our research |

| Verifier | Env var | Config | Credits | Price per 1,000 (as of September 2026) |
| --- | --- | --- | --- | --- |
| `millionverifier` | `MILLIONVERIFIER_API_KEY` | `timeout_seconds` (20) | 1 for valid or invalid; catch-all and unknown are free | $1.78, down to $0.45 |
| `reoon` | `REOON_API_KEY` | `mode`: `power` (default) or `quick` | 1, except unknown results | about $1 |

Accuracy: in a live test published by Dropcontact (itself a vendor, so read it with care), hard bounce rates were 1.0% for Icypeas, 1.1% for Findymail, 10.6% for LeadMagic and 11.2% for Hunter. Prospeo was not tested. Verify addresses from Apollo again before sending.

How statuses map:

| Provider says | Stored as |
| --- | --- |
| Hunter valid; Icypeas ultra sure or very sure; Findymail any hit; Prospeo verified; MillionVerifier ok; Reoon safe or role account | `valid` |
| Hunter invalid or disposable; MillionVerifier invalid or disposable; Reoon invalid, disabled, disposable or spam trap | `invalid` |
| Hunter accept all; MillionVerifier catch-all; Reoon catch-all | `catch_all` |
| Hunter webmail; Icypeas sure or probable; Reoon inbox full | `risky` |
| Anything else (and a Reoon quick-mode valid) | `unknown` |

## Catch-all domains

A catch-all domain accepts mail for any address, so a verifier cannot tell whether a person's address exists. By default (`sending.catch_all: skip`) those people are not emailed; their enrollment is skipped with `not_contactable:catch_all_skipped`. Set `allow` only if you accept a higher bounce risk, and watch the mailbox bounce rate ([Mailboxes](mailboxes.md#health-and-automatic-pauses)).

## The website crawler

The crawler is free and runs first. It reads the company's own site: the home page, then the contact, imprint, team and about pages linked from it (or `/contact`, `/impressum`, `/team`, `/about`), 5 pages at most.

- Each fetch: 10 seconds, 1.5 MB, HTML only, robots.txt respected, identified as `OpenOutboundBot`.
- It reads `mailto:` links, plain text and common obfuscations (`[at]`, `(dot)`, HTML entities).
- It keeps addresses on the company's domain or a free-mail domain, and ignores `noreply`, `privacy`, `jobs`, `press`, billing and similar inboxes.
- An address is matched to a person by patterns of their name (first.last, flast, last, first, with accents normalized). Shared inboxes (info, contact, office, sales) are used only with `--allow-role-addresses`.
- It never runs in sandbox workspaces or for companies in `crawler_excluded_countries`.

### Find the people at a company

`enrichment find-contacts --company-ids ...` (MCP: `enrich_leads` action `find_contacts`) is for companies without people, such as local businesses imported from Google Maps:

1. Crawls the site and fills the company's empty name, address and phone.
2. One AI call (`enrichment.extract_team`, tier `fast`) lists the people named on the site, up to 15. The model is told never to guess addresses.
3. Keeps up to `--max-people` (default 3), decision makers first, with their published address when the site shows one.
4. Verifies the addresses and creates the people (source `website`, tag `decision_maker`), unless `--no-create-people`. A person whose published address is suppressed or erased is not created; a system address such as noreply@ is dropped and the person is created without it.

Up to 50 companies per call; more than 3 run as a background job. Its dry run crawls but makes no AI call and writes nothing.

The background job needs a brain to list the people. Without one it waits before crawling anything (see [No brain yet](ai-brain.md#no-brain-yet)). When a run stops to wait (the agent brain answering a company's team extraction) or is retried, the next run continues after the last company it finished, so addresses it already verified are not verified, and paid for, again.

## Legal notes

- Addresses come from your imports, from providers, or from pages that publish them. Guessing is off unless you turn it on.
- `compliance.publication_evidence_countries` (default Canada and Australia) require evidence of where an address was published: in those countries only the crawler (which records the page) can supply an address. It also looks for a stored address (from an import or Apollo) on the company website and records the page when it finds it there; a stored address that no page publishes is kept with reason `publication_evidence_missing` and is not emailed cold.
- Consent-required countries (default DE, AT, IT, ES, NL, DK, PL, BE) are skipped unless `person.custom.consent` is true.

See [Security](security.md#data-protection-and-gdpr) and the compliance settings in the [configuration reference](../reference/configuration.md#workspace-settings).

## Sandbox

Sandbox workspaces use a fake finder (finds about 80% of people, always the same answer for the same person, 1 credit per call) and a fake verifier (about 70% valid, 15% invalid, 10% risky, 5% catch-all). Nothing is crawled.

Next: [Lead sources](lead-sources.md) · [Mailboxes](mailboxes.md) · [Providers](../concepts/providers.md) · [Security](security.md)
