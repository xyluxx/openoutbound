# Research and signals

This guide shows how to set up research (sourced briefs about leads and companies) and signal collection: which providers exist, what they cost, what works for free, and how to push signals from your own systems.

## What works without paying anyone

| Feature | Free path | Paid providers add |
| --- | --- | --- |
| Research briefs | The company's own website (up to 4 pages), its signals and the lead record | Web search: recent news, hiring pages, mentions of the person |
| Signals | Website changes, public job boards, GDELT news, RSS feeds, technology detection, your own data | PredictLeads (jobs, financing, technology, news events), Crustdata (headcount growth, funding, hiring, news, job-change watchers) |
| Web search (`research search`) | Not available | Search results with dates |

Briefs, website-change checks and news classification use your AI brain, so they count against the AI budget. Paid providers count against the data budget (`settings.data.monthly_credit_budget`): a web search or a paid signal check starts only when what is left covers its credits. A brief skips the searches that do not fit and says so in the job's warnings; a monitor stops its paid calls for that run (`stopped: budget_data`) and the free collectors go on. The dry runs of `research run`, `research search` and `signals monitors run` show what is left. See [Safety and approvals](../concepts/safety-and-approvals.md#budgets).

## Research providers

Configure one with `providers set --slot research` (see [Providers](../concepts/providers.md#configure-a-provider)) or its env var. The highest-priority configured provider serves research; `research search --provider <id>` picks one for a single search.

| Provider | Env var | Config | Credits per search | Pricing notes (as of September 2026) |
| --- | --- | --- | --- | --- |
| `parallel` | `PARALLEL_API_KEY` | `mode`: `turbo`, `fast`, `basic` (default), `advanced` | 1 | Search $1 to $5 per 1,000 requests; $5 a month free. Citations and a confidence per field. |
| `exa` | `EXA_API_KEY` | `search_type`: `auto` (default), `fast`, `instant`, `deep-lite`, `deep`, `deep-reasoning` | 1 | Search $7 per 1,000, contents $1 per 1,000; $10 a month free |
| `tavily` | `TAVILY_API_KEY` | `search_depth`: `basic` (default) or `advanced` | 1 (2 for `advanced`) | Credit based, see tavily.com |
| `firecrawl` | `FIRECRAWL_API_KEY` | `base_url` for a self-hosted Firecrawl | 2 | Credit based; can be self-hosted (AGPL) |
| `builtin` | none | none | 0 | Free. Reads public pages, cannot search. |

Credits here are the engine's own accounting unit for the data budget. Each provider bills you in its own way; check its pricing page.

Not sure which to pick? Our research in September 2026 favored Parallel (citations and a confidence per field, a free monthly allowance), with Exa as the runner-up.

## Research briefs

```bash
openoutbound --workspace acme research run --person-ids pe_... --dry-run
openoutbound --workspace acme research run --person-ids pe_...
openoutbound --workspace acme research get --person-id pe_...
```

MCP: `research_lead` with the actions `run`, `get` and `search`.

A company brief reads the company's website (home plus about, blog and careers pages, at most 4, robots.txt respected), runs two web searches when a research provider is configured (news from the last 180 days, hiring from the last 90) and adds the company's 3 strongest signals. A person brief adds the LinkedIn URL and title from the lead record and one web search for the person with the company name.

One brain call (`research.brief`, tier `standard`) turns the sources into a brief:

| Part | Content |
| --- | --- |
| `who` | Who the person is |
| `company` | What the company does |
| `now` | What is happening now: each fact with its source URL and date |
| `pains` | Likely problems, with evidence URLs |
| `angles` | Outreach angles tied to your active offers |
| `recommended_angle`, `confidence` | The best angle, and `low`, `medium` or `high` |

Every fact must cite a URL that was among the gathered sources; facts that do not are dropped. Ready briefs stay fresh for 30 days: running research again within that time returns the cached brief unless you pass `--force`. People at the same company reuse its brief. A brief built while a source failed is `partial`, see [When a provider fails](#when-a-provider-fails).

Research pays for nothing it cannot use:

- Before its first web search, the job checks that the workspace has an AI brain. Without one it waits (`get_job` shows `waiting` on `brain:configured:<workspace id>`, no attempt used, a `brain_down` problem says why) and checks again every hour, without paying for any search. Setting a brain (`providers set --slot brain`) wakes it.
- When the AI budget is used up, the job fails the briefs before any web search.
- The searches a job paid for stay on the pending brief until the brief is written. When the job runs again after a wait (the agent brain answering the brief task) or after a brain error, it reuses them instead of paying again.

New leads with a fit score of at least `settings.data.auto_research_min_fit` (default 70) are researched automatically, one job per company, a minute after they are created.

Campaign writing uses the latest brief if there is one; it does not start research by itself. Research the leads you care about before previewing or launching.

## Signal providers

| Provider | Env vars | Signals | Credits | Pricing notes (as of September 2026) |
| --- | --- | --- | --- | --- |
| `predictleads` | `PREDICTLEADS_API_KEY` and `PREDICTLEADS_API_TOKEN` | Job openings, financing, technology detections, news events | 4 per company check | 100 free credits a month, then from $40 a month |
| `crustdata` | `CRUSTDATA_API_KEY` | Headcount growth (20% in 6 months), funding, hiring, news; Watcher webhooks for people changing jobs | 1 per company check | Paid per credit |

Add a provider to a monitor by listing its id in `--collectors`, next to the free collectors. Set `budget.max_credits_per_month` on monitors that use paid providers. See [Monitors](../concepts/signals.md#monitors).

## Free collectors in detail

| Collector | Reads | Good for | Notes |
| --- | --- | --- | --- |
| `website_changes` | Home, pricing, careers, locations and team pages, plus pages your custom signals name | New leaders, new locations, events, meaningful changes | Keeps the previous text of each page and asks the brain once per company which changes matter |
| `job_boards` | The company's Greenhouse, Lever or Ashby board, found from links on its site | Hiring for roles you support, competitor names in job titles | Public board APIs, no key |
| `news_gdelt` | GDELT news articles about the company | Funding, expansion, news | GDELT throttles hard; the collector spaces calls and pauses a minute on a 429 |
| `rss` | The company's RSS, Atom or JSON feeds | Leadership posts, announcements | Only feeds the home page links to |
| `tech_detect` | Scripts, meta tags, headers and cookies on the home page; MX and TXT records | Tools adopted or dropped, competitors | A removal counts after two checks at least 7 days apart |
| `first_party` | Your own bounces, automatic replies and inbound messages | Contacts who left their company (`job_change`) | Runs on events, no fetching |

## When a provider fails

A paid call can fail: a timeout, a rate limit, a server error, a rejected key or no credits left. The engine never reads a failure as "nothing there".

### Research briefs

A search that fails becomes a gap, and the brief is `partial` instead of `ready`.

| What you see | Meaning |
| --- | --- |
| `status: partial` | The brief is usable, but it was written without the failed sources |
| `gaps` | Each failed source: `source` (`search`, or `website` in sandbox workspaces), `target` (the query or the page) and the `failure` (its class, and `retryable`: whether the engine repeats the call by itself) |
| A gap with `company_brief_id` | The gap is in the company brief this person brief builds on |
| `briefs[].gaps` in the job result | The same, per brief |

- A failed search costs no credits. A search whose answer the engine could not read (`malformed`) is charged, because the provider did the work.
- After a failure of the provider's account or of the whole provider (bad key, no credits, rate limit, server trouble), the job stops asking it: the searches left become gaps without a call.
- A partial brief is never returned from the cache. The next `research run` for the same lead, with or without `--force`, asks only the failed searches again and reuses the results of the searches that answered, without paying for them twice. A company brief left partial by an earlier job is completed first. A job that runs again after a wait for the brain or a brain error reuses its own paid searches the same way.
- The engine does not retry research by itself. Run it again later. When a gap's `failure.retryable` is `false`, the class says why: after `auth_invalid`, `forbidden` or `quota_exhausted`, fix the provider first (`manage_providers` action `test`); after `timeout` or `network` the search may already have used credits, and the next run asks it again.

Website pages that cannot be read stay warnings in the job result, as before: they cost nothing and the brief is still `ready`.

### Monitors

A paid signal check that fails is listed in the run's `failures`: the provider, the failure and the number of companies it did not check. The run's `status` says how it went:

| `status` | Meaning |
| --- | --- |
| `ok` | Every paid check answered |
| `partial` | Some paid checks failed |
| `failed` | Every paid check failed and the monitor has no free collector |

- A failed check costs no credits, unless the provider answered in a shape the engine could not read.
- A check that failed part way (PredictLeads asks up to four endpoints per company) keeps the signals the endpoints that answered returned, and is charged their credits (`credits_used`, the monitor's month and the data budget). Its failure still holds the window, so the next run asks that company again; signals it already stored count as duplicates.
- After a failure of a provider's account or service, the run stops asking it for the companies left (`stopped` includes `provider_failed`).
- `last_run_at`, the start of the window the next run looks at, moves only when the run was not cancelled and no failure a later run could fix is left (`window_moved`). The next run then looks at the same window again (`since`), so no signal is missed. A paid check that timed out or lost its connection holds the window too: the run does not ask it again (`retryable: false`, it may already have used credits), the next run does. A failure that only concerns one check and would repeat (not found, an unreadable answer) does not hold the window back.
- Built-in collectors that fail (a page that cannot be read, a GDELT error) stay notes, as before.

When a failure's `retryable` is `false`, the engine does not repeat that call by itself, and the class says why. After `auth_invalid`, `forbidden` or `quota_exhausted`, fix the provider (`manage_providers` action `test`) before the next run. After `timeout` or `network` the call may already have used credits; nothing to fix, the next scheduled run looks at the same window again. Other failures a later run can fix are tried again by the next scheduled run by itself.

## Push signals from your own systems

For a one-off batch (your research, a CRM export, an intent tool), call `signals ingest` with up to 100 signals. For continuous pushes, create a webhook token:

```bash
openoutbound --workspace acme signals webhook-tokens create --name "CRM workflow"
```

The answer holds a secret URL, `<OPENOUTBOUND_BASE_URL>/hooks/signals/<token>`, shown once. POST signals to it:

```json
{
  "signals": [
    {
      "key": "funding_round",
      "title": "Series B announced",
      "evidence_url": "https://news.example.com/brightwave-series-b",
      "company": { "domain": "brightwave.example.com" },
      "person": { "email": "ops.lead@brightwave.example.com" }
    }
  ]
}
```

- 1 to 100 signals per request, up to 512 KB, 60 requests a minute per token.
- Companies are matched by domain and created when unknown; people by email or LinkedIn URL.
- Duplicates (same key, subject and evidence) are skipped.
- For a Crustdata Watcher, point it at the same URL with `?provider=crustdata`; the engine reads Crustdata's own format.
- `signals webhook-tokens revoke --token-id swt_...` turns a token off (requests then get 401).

Token management is CLI and REST only (it needs `admin`).

Next: [Custom signals](custom-signals.md) · [Signals](../concepts/signals.md) · [Lead sources](lead-sources.md) · [Enrichment](enrichment.md)
