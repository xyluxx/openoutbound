# Provider failures

This page explains what happens when an outside service fails: the failure classes, what the engine does for each, where you see a failure, and how a paused provider starts again.

## One description for every failure

Every error from a provider (code `provider_error`, sometimes `provider_not_configured`) carries `details.failure`:

| Field | Meaning |
| --- | --- |
| `class` | What went wrong, one of the classes below |
| `retryable` | Whether the engine may repeat the call by itself. When it is false, `class` says why: a person fixes the provider (`auth_invalid`, `forbidden`, `quota_exhausted`), the call would fail the same way again (`not_found`, `bad_request`, `malformed`, `refused`), or a paid call may already have used credits (`timeout`, `network`, or another class that is usually retried, see [Retries](#retries)) |
| `scope` | How far it reaches: `call` (this call only), `account` (the key or account), `provider` (the whole service) |
| `provider` | The provider id, for example `apollo` |
| `retry_after_s` | Seconds the provider asked to wait (a `Retry-After` header, a quota reset) |
| `upstream_status` | The HTTP status or SMTP code the provider answered with |

Every part of the engine reads this the same way: the job runner, CRM sync, the brain, LinkedIn account health, MCP and the CLI.

## The classes

| Class | What it means | Retryable | What the engine does |
| --- | --- | --- | --- |
| `timeout` | No answer in time, or a connection that timed out while opening. Every request has a timeout: 30 seconds unless the provider sets its own | yes, except for a paid call | Retries later; a paid call that may have used credits is not repeated by itself |
| `network` | Could not connect, or the connection broke (also in the middle of an answer) | yes, except for a paid call whose request was sent | Retries later; a paid call that may have used credits is not repeated by itself |
| `unavailable` | A server error (5xx) or an overloaded service | yes | Retries later |
| `rate_limited` | A short limit (429) | yes | Waits `retry_after_s`, then retries |
| `quota_exhausted` | Credits or a daily quota are used up (402, some 429s) | no | Pauses the provider for the workspace until the quota resets |
| `auth_invalid` | The key or token was rejected, revoked or expired (401) | no | Pauses the provider for the workspace until the credentials change |
| `forbidden` | The key works but lacks a permission or plan feature (403) | no | Pauses the provider like `auth_invalid` |
| `not_found` | The thing asked for does not exist | no | Fails the call |
| `bad_request` | The provider rejected the input | no | Fails the call: check the input |
| `malformed` | The answer cannot be read or has the wrong shape (an HTML page, a missing field) | no | Fails the call. A wrong answer is never read as "nothing found" |
| `refused` | The provider declined on policy: a LinkedIn limit, a blocked address, robots.txt | no | Fails the call |
| `outcome_unknown` | A write that may or may not have happened | never | Never repeats it blindly: checks the result, or asks a person |

A lookup whose provider documents a 404 as "no match" (Findymail, Hunter, PredictLeads) returns a normal empty result, not `not_found`.

## Retries

- **Jobs follow one rule.** A retryable failure runs the job again after the job's backoff, or after `retry_after_s` when the provider asked for longer, until the job's attempts run out. A `Retry-After` of 0 never makes the job run again at once. A failure that is not retryable fails the job at once.
- **Waiting is not failing.** A job that waits for something (an agent task, a brain to be configured) has the status `waiting`, uses no attempt and continues on its own once what it waits for is there. A wake-up that does not fix it (a brain set without its key) puts it back to `waiting`.
- **Job time limits.** A job that runs past its time limit gets a `timeout` failure and is retried like one.
- **The brain retries first.** A brain call retries temporary errors itself (3 attempts) before the job does. See [AI brain](../guides/ai-brain.md#test-and-troubleshoot).
- **Paid calls are not repeated blindly.** A call that may have spent credits and then lost its answer (a timeout or a dropped connection after the request was sent) is not retried automatically: `retryable` is false and the hint says so. A connection that never opened cost nothing and is retried. An Icypeas search whose status check fails after the search started is kept the same way: the failure keeps its class, with `retryable: false` and `details.search_id`. What the call asked for is still missing, so a monitor keeps its window and a saved search its `resume_cursor`: their next scheduled run asks again.
- **Partial results are kept.** A paid call that gathers several pages or chunks and fails part way hands back what it already got in `details.partial`: `items`, the `credits` spent and, for paged searches such as Google Maps, a `resume` cursor that continues from the page that failed. Apollo enrichment returns the answers for the first candidates, in order, so only the rest is enriched again. A monitor keeps the signals a PredictLeads check returned before it failed and charges the endpoints that answered.

## Writes with an unknown outcome

A write whose answer was lost may have happened. What each family reports for a timeout, a dropped connection after the request was sent, or a server error:

| Family | Calls | Class |
| --- | --- | --- |
| LinkedIn (Unipile) | Invitation, message, comment | `outcome_unknown`, also for a 2xx answer that is not JSON or whose body broke off (see [LinkedIn](../guides/linkedin.md#when-linkedin-gives-no-clear-answer)) |
| LinkedIn (Unipile) | Like, profile visit, withdrawing an invitation | `timeout`, `network` or `unavailable`, retried: doing them twice changes nothing |
| Posting (`linkedin_official`, `unipile`) | Publishing a post | `outcome_unknown`, also for a 2xx answer that is not the provider's own (an HTML page) or whose body broke off before LinkedIn named the post in its headers. A post accepted without an id is `malformed` with `details.accepted` |
| CRM (`hubspot`, `pipedrive`, `webhook`) | Contact, company and deal writes, associations, deletes | `timeout`, `network` or `unavailable`, retried: the sync finds the record by its key first |
| CRM | Notes and activities | `outcome_unknown`, recorded as unknown |
| Email | Sends | See [Mailboxes](../guides/mailboxes.md#sends-with-an-unknown-outcome) |

A rate limit or a refusal answered before the provider acted stays `rate_limited` or `refused`. An answer whose body broke off is read by what the call was: any status but a 2xx from that status, as if the body were empty, so a server error answering a write is `outcome_unknown`; a 2xx answering a write that can be repeated counts as done (`malformed` with `details.accepted`); a 2xx answering any other write is `outcome_unknown`, unless the provider had already named what it made in a header (LinkedIn's post id); and a read's is a lost connection (`network` or `timeout`), retried. Calls through safe fetch (the `webhook` CRM, `builtin` research) read the whole body before they see the status, so for them a body that broke off is a lost connection. A call that never left stays `network` or `timeout` and is retried, also for a write: a connection that never opened (refused, no DNS answer, or timed out while opening), or a call stopped before it was sent, which carries `details.not_sent`.

## Paused providers

An `auth_invalid`, `forbidden` or `quota_exhausted` failure about the key or account pauses that provider for that workspace:

- One `provider_down` problem opens per workspace, slot and provider: severity high, for a person, dedupe key `provider_down:<slot>:<provider>`, titled like "Apollo is paused: its credentials were rejected". The remedy names `manage_providers` action `set` and action `test`.
- While it is paused, calls to it fail at once with the stored failure, without a network call and without spending credits. The error says since when, has `details.paused` set to true, and for a quota pause gives the time left in `retry_after_seconds`.
- LinkedIn invitations, messages, comments, likes and visits wait while the LinkedIn provider is paused, when its own key, quota or access is refused, or when no LinkedIn provider is set any more: they stay `scheduled` and are tried again later (after the quota wait, else an hour), never failed for it. LinkedIn posts do the same while their publisher (`linkedin_official` or `unipile`) is paused: the wait does not count as one of their tries, and the posting account stays connected. Nothing reached LinkedIn, so nothing can go out twice. The LinkedIn accounts stay `active` too: the sync records the failure and reads again later; only a lost LinkedIn session disconnects an account.
- A key set at instance level or in an environment variable counts for each workspace on its own: other workspaces keep calling until they hit the failure themselves.
- With several engine processes on one database (for example `serve` and a separate worker), each process makes one failing call of its own before it honors the pause.

Five `timeout`, `network`, `unavailable` or `outcome_unknown` failures in a row open the same problem at severity normal, titled like "Apollo keeps failing", without a pause. Any answer from the provider, even a refusal, starts the count again.

A failure about one item never pauses the provider: a web page that is gone or down, one LinkedIn account whose session expired. A web page that is down does not count toward the five either.

How a pause ends:

| Pause | Ends when |
| --- | --- |
| `auth_invalid`, `forbidden` | The credentials change (`manage_providers` action `set`, at workspace or instance level), the provider's live test passes (`manage_providers` action `test`), or the provider is removed. A test that checked nothing live (`checked: false`, a provider with no free check) does not end it |
| `quota_exhausted` | The same, or when the wait passes (`retry_after_s`, one hour when the provider gave none). Then calls go through one at a time as trials (others still get the paused error meanwhile): a success resolves the problem, a used-up quota or a rejected key pauses again, and any other failure lets the next call try |
| Keeps failing (no pause) | The next successful call |
| Any | A person resolves the problem with `resolve_exception`. The pause lifts within a minute; if the provider still fails, it pauses again |

Sandbox providers never pause. Providers that call no outside service of their own (`builtin` research, the `webhook` signals) never pause either. The brain has its own problem, `brain_down`, fed by the same classes: see [When a brain is down](../guides/ai-brain.md#when-a-brain-is-down).

```bash
openoutbound --workspace acme providers set --slot lead_source --provider apollo \
  --secrets '{"api_key":"..."}' --test        # new key: the pause ends
```

## Where you see failures

| Where | What it shows |
| --- | --- |
| `get_job` (CLI `jobs get`) | `error` with `code`, `message`, `hint`, `failure` and `retry_after_seconds` |
| MCP tool errors | `structuredContent.error` with `retry_after_seconds`; the text ends with "Retry after N s." |
| CLI errors | A `Wait: retry after N s` line under the hint |
| `get_status` | `health` for each slot's provider: `status` (`ok`, `paused` or `failing`), `class`, `since`, `until` and `fix`, plus a `provider_down` warning for each provider that is paused or failing |
| Problems | `provider_down` in `get_attention_queue` and `resolve_exception` action `list`. Its `data` has the slot, provider, level, failure, message and `paused` |

Next: [Providers](providers.md) · [Relationships](relationships.md#problems) · [Write a provider](../extending/write-a-provider.md)
