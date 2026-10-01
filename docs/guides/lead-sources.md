# Lead sources

This guide shows every way to get leads into a workspace: importing CSV, XLSX or JSON files, finding people with Apollo and local businesses with Google Maps, saved searches that run on a schedule, and how leads are scored, listed, suppressed and exported.

## Ways in

| Source | Command (MCP tool) | Cost |
| --- | --- | --- |
| A file or rows you have: CSV, XLSX, JSON, a public CSV URL | `leads import` (`import_leads`) | Free (one small AI call to map unknown columns) |
| Apollo: people or companies by title, seniority, industry, size, technology | `leads find` then `leads find-import` (`find_leads`) | Apollo credits for reveals |
| Google Maps: local businesses by category and place | `leads find --source google_maps` then `leads find-import` | One Places request per 20 results |
| A saved search that runs on a schedule | `saved-searches create` (`manage_saved_searches`) | As above, capped per run |
| One person or company by hand | `leads create` (`manage_leads`) | Free |
| Companies named in signals from your systems | `signals ingest` or the signal webhook | Free |

Every lead is checked against suppressions on the way in, deduplicated, and scored against your ICP.

## Import a file

```bash
openoutbound --workspace acme leads import --source csv --content "$(cat leads.csv)" --list-name "Q4 imports" --dry-run
openoutbound --workspace acme leads import --source csv --content "$(cat leads.csv)" --list-name "Q4 imports"
openoutbound --workspace acme leads import --source xlsx --content "$(base64 < leads.xlsx | tr -d '
')" --sheet "Leads"
openoutbound --workspace acme leads import --source url --url "https://docs.google.com/spreadsheets/d/.../edit"
```

(PowerShell: `--content (Get-Content -Raw leads.csv)`, and for XLSX `--content ([Convert]::ToBase64String([IO.File]::ReadAllBytes("leads.xlsx")))`.) Agents pass the same fields to `import_leads` action `import`.

| Source | Accepts |
| --- | --- |
| `csv` | Comma, semicolon, tab or pipe separated (detected, or set `--delimiter`); the first non-empty row is the header |
| `xlsx` | Base64 content; the first sheet unless you pass `--sheet` |
| `json` | An array of objects, or one under `data`, `rows`, `people`, `contacts`, `leads`, `items`, `records` or `results`; nested objects become `a.b` columns |
| `rows` | `--rows` as a JSON array of objects |
| `url` | A public CSV (or JSON, XLSX) link up to 20 MB; Google Sheets links are turned into CSV export links |

Limits: 50,000 rows and 20,000,000 characters per import. Up to 500 rows run right away; larger imports run as a background job in batches of 200 (check it with `imports get --import-id imp_...`).

**Column mapping.** Headers are matched in this order:

1. Your `--mapping` overrides, for example `{"Firma":"company.name","Notes":"ignore"}`.
2. A table of common headers in English, German, French and Spanish, plus Apollo and Sales Navigator export headers.
3. Values: a column where at least 80% of samples look like emails, LinkedIn URLs or websites.
4. One AI call (`leads.import_map_columns`, tier `fast`) for the headers still unknown, with 3 short samples each. Turn it off with `--no-ai-mapping`.
5. Anything left is kept as a custom field: `Favorite Color` becomes `custom.favorite_color`.

The dry run shows each column's mapping and how it was found (`manual`, `synonym`, `values`, `ai` or `default`), sample rows, counts by outcome, and a `mapping_to_reuse` you can pass back as `--mapping` to skip the AI call.

**What makes a valid row.** An email, a LinkedIn profile URL, or a full name plus a company. Rows with only a company create companies. A `consent` column is stored as `custom.consent`.

**What happens to each row:**

| Check | Result |
| --- | --- |
| Not a valid row | Skipped (`invalid`) |
| Recorded country in `compliance.excluded_countries` | Skipped (`excluded_country`) |
| Email in a consent-required country and no consent | Skipped (`consent_country`), unless `--include-consent-countries` (the email then stays blocked for sending). Without a recorded country, the email's country domain decides (`.de` is Germany) |
| A system address such as noreply@, postmaster@ or abuse@ | Skipped (`role_address`). Business inboxes such as info@ and sales@ are kept |
| Email, domain, company domain or LinkedIn URL suppressed | Skipped (`suppressed`) |
| Duplicate inside the file | Skipped (`duplicate`) |
| Already in the workspace | Merged by `--merge-policy`: `fill_empty` (default) fills blanks, `overwrite` replaces, `skip` leaves it |

People are matched by email, then LinkedIn URL, then full name plus company; companies by domain, then name plus city. A merge never changes a status and never takes an email, LinkedIn URL or domain that belongs to another record. The company domain comes from a domain column, the website, or the email's domain (never a free-mail domain).

Imported content is data: it is parsed, never executed, and marked untrusted when shown to agents. Each new record fires `lead.created`; the import fires `import.completed`.

## Find people with Apollo

1. Set `APOLLO_API_KEY` or `providers set --slot lead_source --provider apollo --secrets '{"api_key":"..."}'`.
2. Search. Apollo's people search is free and returns masked names without emails:

   ```bash
   openoutbound --workspace acme leads find --source apollo --titles "Head of Operations","VP Operations" \
     --industries ecommerce --employees-min 50 --employees-max 250 --countries US,CA --limit 25
   ```

   The answer is a preview (`preview_id`) with candidates `c1` to `c25`, each scored against your ICP and flagged when already in the workspace. `--cursor` gets the next page.

3. Import the ones you want. This reveals them (1 Apollo credit per matched person) and runs the import pipeline:

   ```bash
   openoutbound --workspace acme leads find-import --preview-id imp_... --top-n 10 --min-fit-score 60 --list-name "Ops leaders" --no-dry-run
   ```

`leads find-import` is a dry run unless you pass `--no-dry-run`, and needs `--candidate-ids` or `--top-n`. The dry run shows the credits and what is left of the monthly data budget, with a warning when the reveal does not fit; the real run then refuses before revealing anyone (`needs 10 credits, 8 left this month`) and says how many fit (`--top-n 8`). A reveal stores the name, LinkedIn URL and work email (marked `valid` when Apollo says it is verified). Add `--enrich` to run the [email waterfall](enrichment.md) afterwards. Apollo company searches cost 1 credit per page.

Apollo's data gets mixed reviews: verify its emails before you send (the default `sending.require_verified_email` only sends to `valid` addresses). Suppressed or known people cannot be spotted before the reveal, because the search returns no email or URL; the import skips them afterwards, but the reveal credit is spent.

## Find local businesses with Google Maps

1. Enable the Places API (New) in Google Cloud, create an API key, and set `GOOGLE_MAPS_API_KEY` (or `providers set --slot lead_source --provider google_maps`).
2. Search:

   ```bash
   openoutbound --workspace acme leads find --source google_maps --query "dental clinic" --location "Austin, TX" --min-rating 4 --limit 40
   openoutbound --workspace acme leads find-import --preview-id imp_... --top-n 20 --no-dry-run
   ```

Google Maps finds companies only. Each request returns up to 20 places; permanently closed places are dropped, and a busy area is split into smaller squares (up to `max_requests_per_search` requests, default 30).

**Cost.** Google bills each request, and a request returns up to 20 places, so filling `--limit 40` takes at least 2 credits. Closed or repeated places and split areas take more requests, up to `max_requests_per_search` per search. The dry run shows the least, with a note saying so. A search never spends more than what is left of the data budget (or of a saved search's spend cap): it stops there with fewer results and a `next_cursor` to continue once there is budget again, and it is refused only when not even one request fits (`needs at least 1 credit`). The dry run warns when what is left cannot finish the search. Lower `max_requests_per_search` to cap what one search can spend.

**Terms.** Google's terms limit what you may store from Places. OpenOutbound keeps only the place id, the website domain and the country. Places without a website are skipped. The business name, address and phone are then read from the business's own website by the [website crawler](enrichment.md#find-the-people-at-a-company), which also finds the people named there (one AI call per company; turn it off with `--no-find-people`). Places never include email addresses.

| Config (`providers set --config`) | Default |
| --- | --- |
| `language_code` | `en` |
| `region_code` | none |
| `max_split_depth` | 2 (0 to 3) |
| `max_requests_per_search` | 30 (1 to 100) |

## Saved searches

A saved search repeats a find (or a filter over your own leads) on a schedule:

```bash
openoutbound --workspace acme saved-searches create --name "New Austin clinics" --source google_maps \
  --criteria '{"query":"dental clinic","location":"Austin, TX"}' --schedule "0 8 * * 1" \
  --mode ask_first --max-results 25 --list-name "Austin clinics"
```

| Mode | What a run does |
| --- | --- |
| `manual` (default) | Keeps a preview for you to import |
| `ask_first` | Creates an approval of kind `lead_import` listing the candidates and estimated credits; approving imports them |
| `auto_import` | Imports by itself; needs `--spend-cap-credits` and stops at that cap (a Google Maps search stops there with fewer results; other searches are skipped when their price is above it) |

- Schedules are cron in the workspace timezone, at most hourly; the engine checks every 15 minutes. Runs skip paused workspaces.
- A run that the data budget or the spend cap skips, or that has nothing left to reveal people with, says why in `refusal` (also kept in `last_result`): the message, for example `Not enough data budget: needs at least 1 credit, 0 left this month (5 of 5 used).`, a hint on how to fix it, and the numbers.
- Source `leads` looks at your own people who match `--filter` and were created since the last run: `auto_import` adds them to the list, `ask_first` creates a `lead_import` approval listing them and adds them only when approved (no credits are spent), `manual` only counts them.
- `--campaign-id` is stored for later: saved searches do not enroll people yet. Enroll the list yourself, or use a [signal automation](../concepts/signals.md#automations).
- A run that fails or stops part way says so in `last_result`, see [When a provider fails](#when-a-provider-fails).

## When a provider fails

A paid search or reveal can fail part way: Apollo reveals people in chunks and Google Maps searches page by page, and a later chunk or page can hit a rate limit, a timeout or a used-up quota, or come back unreadable (billed all the same). The engine keeps what it already paid for and says what is left. A Google Maps search continued from where it stopped splits a busy area into the same squares as a search that ran in one go.

| Where | What happens |
| --- | --- |
| `leads find` | The results returned before the failure stay in the preview and are charged. `failure` says what went wrong, a warning says how many results were kept, and `next_cursor` continues after them. When nothing came back, the search fails with the error |
| `leads find-import` | The people revealed before the failure are imported, with the credits actually spent. The import is `partial` (also in `import.completed`), `failure` says why, and `remaining` holds a new preview with the candidates not reached: import it with `leads find-import --preview-id imp_...` once the cause is fixed |
| Saved search run | A run that fails is kept in `last_result` with `status: failed`, the `failure` and the `error`; `last_run_at` does not move. A run whose search failed part way keeps what came back (`partial: true`) and the next run continues from `resume_cursor`. Candidates a partial import did not reach wait in `remaining_preview_id` |

- People already revealed are never revealed again: only the candidates not reached are left.
- `resume_cursor` is kept only when asking again can help: a temporary failure (also a paid page that timed out or lost its connection), or a problem with the account that a person can fix. Changing the search's criteria clears it.
- When `failure.retryable` is `false`, the engine does not repeat the call by itself, and the class says why. After `auth_invalid`, `forbidden` or `quota_exhausted`, fix the provider first (`manage_providers` action `test`). After `timeout` or `network` the request may already have been billed: run the search again when you need the rest, and a saved search continues from `resume_cursor` on its next run.
- An approved `lead_import` that fails part way says so in the approval's result and names the preview of the candidates not reached.

## ICPs and fit scores

An ideal customer profile (ICP) scores every person and company from 0 to 100:

```bash
openoutbound --workspace acme icps create --name "DTC ops leaders" --criteria '{
  "industries":["ecommerce"],"employee_range":{"min":50,"max":250},"countries":["US","CA"],
  "titles":["operations"],"seniorities":["vp","head","director"]}'
openoutbound --workspace acme icps score --icp-id icp_... --all-people --all-companies
```

| Criterion | Default weight |
| --- | --- |
| Industry (`industries` full points, `industries_adjacent` half) | 25 |
| Title (`titles`) | 20 |
| Employees (`employee_range`; half points within half or double the range; `employee_limits` disqualify) | 15 |
| Geography (`countries` full, `countries_secondary` half, `regions`) | 10 |
| Technologies | 10 |
| Keywords | 10 |
| Seniority (one level off earns half) | 10 |
| Department | 5 |

- Only the criteria you set count: the score is the points earned out of the weights of those criteria. Unknown values earn 40% of their weight: a company with no industry on record (a CSV row, an Apollo preview) is unknown, not a miss, and its reason says `industry unknown`.
- `exclude` rules (industries, titles, countries, keywords, domains, company statuses such as customer or competitor) make the score 0.
- Scoring is rule-based and runs on imports, finds, `leads create` and `icps score`. It does not rerun when you edit a lead or the ICP: run `icps score` after changing criteria.
- `icps score` reports strong (70 to 100), medium (40 to 69), weak (0 to 39) and unscored counts. It scores in batches of 500 with no upper limit: up to 20,000 people and companies are scored right away, larger selections run as a background job that reports the same counts in its result (check it with `jobs get --job-id job_...`).
- The first ICP is the default. `ai_refinement` (off by default) lets the AI adjust find previews by up to 10 points.

New leads with a fit score of at least `settings.data.auto_research_min_fit` (default 70) get a research brief automatically; see [Research and signals](research-and-signals.md#research-briefs).

## Lists

| Kind | Members |
| --- | --- |
| `static` | The people you add (`lists add-members`, `--list-name` on imports) |
| `smart` | Everyone matching a saved filter, recomputed on every use |

Use lists to enroll people in campaigns, to target monitors and to export.

## Search and manage leads

```bash
openoutbound --workspace acme leads search --min-fit-score 70 --has-email --not-in-active-campaign
openoutbound --workspace acme leads get --person-id pe_...
```

`leads get` (MCP: `get_lead`) returns the dossier: the person and company with fit reasons, whether the person can be contacted by email and by LinkedIn (and why not), lists, research, signals, enrollments, threads, opportunities and a timeline.

People have a status: `new`, `active`, `replied`, `interested`, `meeting`, `customer`, `not_interested`, `do_not_contact`, `bounced` or `unsubscribed`. Companies: `active`, `customer`, `competitor`, `do_not_contact` or `archived`. The engine moves people along as they are contacted and reply.

## Suppressions

A suppression blocks contact for good, and survives when the person is deleted.

```bash
openoutbound --workspace acme suppressions add --type domain --value competitor.example.com --suppression-reason competitor
openoutbound --workspace acme suppressions check --email someone@example.com
```

| Type | Blocks |
| --- | --- |
| `email` | One address |
| `domain` | Every address on a domain, and imports of that company domain |
| `linkedin` | One LinkedIn profile |
| `person`, `company` | One record by id |

Reasons: `unsubscribed`, `bounced`, `complaint`, `manual` (default), `customer`, `competitor`, `do_not_contact`, and `gdpr_erasure` (set only by forget, cannot be removed). Unsubscribes, hard bounces and negative replies add suppressions by themselves. Adding one stops the running enrollments of every person it covers, a whole domain included; the result reports `people_covered` and `enrollments_stopped`. Removing one needs `write` and `approve`.

## Export

```bash
openoutbound --workspace acme leads export --list-id ls_... --format csv --fields first_name,last_name,email,title
openoutbound --workspace acme leads export --list-id ls_... --format csv --json | jq -r .content > leads.csv
```

`csv` or `json`, 30 selectable `--fields` (10 by default). Up to 5,000 rows come back directly, with the file text in the `content` field. Larger exports run in the background and write the file to `.openoutbound/exports/` on the engine machine; there is no download route yet. Cells that start like a spreadsheet formula are prefixed with an apostrophe.

Deleting people, GDPR forget and the retention sweep are in [Security](security.md#data-protection-and-gdpr).

## Tools and commands

| MCP tool | Toolset | Actions |
| --- | --- | --- |
| `find_leads` | core | `search`, `import` |
| `import_leads` | core | `import`, `list`, `get` |
| `search_leads` | core | `people`, `companies`, `export` |
| `get_lead` | core | `person`, `company` |
| `manage_icp` | core | `list`, `get`, `create`, `update`, `delete`, `score` |
| `manage_lists` | leads | `list`, `get`, `create`, `update`, `delete`, `add_members`, `remove_members` |
| `manage_saved_searches` | leads | `list`, `get`, `create`, `update`, `delete`, `run` |
| `manage_suppressions` | leads | `list`, `add`, `remove`, `check` |
| `manage_leads` | core | `create`, `update`, `tag`, `delete`, `forget`, `create_company`, `update_company`, `delete_company` |
| `enrich_leads` | leads | `enrich`, `verify`, `find_contacts` |

Next: [Enrichment](enrichment.md) · [Campaigns](../concepts/campaigns.md#enroll-people) · [Research and signals](research-and-signals.md) · [Security](security.md)
