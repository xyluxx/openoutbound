# CRM and notifications

This guide covers the CRM side of outbound (the engine's own sync to HubSpot, Pipedrive or your endpoint, an AI agent syncing any CRM, facts flowing back from the CRM, forgotten people), notifications in Slack, by email or by webhook, and how to verify signed webhooks.

## CRM

OpenOutbound keeps its own pipeline (see [Inbox](../concepts/inbox.md#opportunities-and-meetings)); the CRM is where your sales team works. Three things connect them:

- **Sync out**: people, companies, deals and, if you want, notes go from the engine to the CRM.
- **Facts back**: the CRM tells the engine who is a customer, who has an open deal, who owns an account and who must never be contacted. Outreach reacts at once.
- **Forget**: when a person is erased here, their CRM records are deleted or flagged for deletion.

### Two ways to run it

`crm.mode` decides who writes to the CRM.

| Mode | Who writes | Use it when |
| --- | --- | --- |
| `built_in` (default) | The engine, through the configured `crm` provider: HubSpot, Pipedrive or your own endpoint | You use HubSpot or Pipedrive, or can receive signed webhooks |
| `agent` | Your AI agent, with its own CRM tools, following the preferences below | Any other CRM, or you want the agent to decide how records look |
| `off` | Nobody | You have no CRM |

In `agent` and `off` mode the engine never pushes anything, and `crm sync` is refused with an error that names the mode and the setting. Facts back and forget handling work in every mode.

```bash
openoutbound --workspace acme workspaces update --settings '{"crm":{"mode":"agent"}}'
openoutbound --workspace acme crm status    # mode, preferences, providers, problems, next steps
```

MCP: `manage_crm` with actions `status`, `record_facts`, `link`, `webhook` and `sync`. In agent mode the agent follows the CRM playbook of the Agent Skill: it reads the preferences, reads the change feed with `event_feed` (consumer `crm`), writes to the CRM with its own tools, reports the ids it created with `manage_crm` action `link`, and acknowledges the feed.

### Preferences

All live under `crm` in the workspace settings (see [Configuration](../reference/configuration.md)).

| Setting | Default | In plain words |
| --- | --- | --- |
| `crm.sync_from` | `interested` | When a person first goes to the CRM. `interested`: with their deal, after an interested reply or a booked meeting. `replied`: on their first human reply (bounces, automatic replies, unsubscribes and privacy requests do not count). `contacted`: on the first email, reply, LinkedIn invite or message the engine sends them (mail someone wrote outside the engine does not count). |
| `crm.log` | `deals` | What is written: see [What gets copied where](#what-gets-copied-where). |
| `crm.timing` | `live` | `live`: as things happen. `daily`: once a day, see [Live or daily](#live-or-daily). |
| `crm.stage_owner` | `engine` | `crm`: once a deal exists in the CRM, the engine never changes its stage again (HubSpot: stage, pipeline and close date; Pipedrive: stage, status and lost reason). Your sales team moves deals; amount and description still update. |
| `crm.on_forget` | `task` | What happens in the CRM when a person is forgotten: see [Forgotten people](#forgotten-people). |
| `crm.skip_owned_accounts` | `false` | `true`: never contact companies the CRM says a sales rep owns. |
| `crm.allow_outreach_with_open_deal` | `false` | `true`: keep contacting companies with an open deal in the CRM. |
| `crm.notes` | empty | Free instructions for whoever syncs, for example "add everyone to the Outbound Q4 list" or which pipeline and stages to use. Your agent reads them; the built-in providers do not. |

### What gets copied where

| `crm.log` | Written to the CRM |
| --- | --- |
| `deals` | The contact (name, email, title, phone, city, country), the company (name, domain, website, city, country, phone) and the deal (stage, amount, close date, and a description with the notes, meeting time, lost reason and the signals behind it). No notes. |
| `key_moments` | Also a note per human reply with its category and one-line summary, never the reply's text, and a note per meeting booked, moved, cancelled, missed or held. |
| `everything` | Also a note per email the engine sends and per reply received, with the subject and the body (a reply's own words, without the quoted history), cut to 2000 characters. |

**`crm.log: everything` copies email content into your CRM.** The text of every email the engine sends and every reply it receives is stored there, where everyone with CRM access can read it and your CRM's own retention rules apply. Notes on deals or companies can outlive a deleted contact. Choose it only if you want email content in the CRM and your privacy notice covers it. With `deals` and `key_moments`, no email text leaves the engine.

Nothing about a privacy request is ever written to a CRM, not even a note. Bounces, automatic replies and unsubscribes never create a contact.

| Provider | A note is |
| --- | --- |
| `hubspot` | A HubSpot note associated with the contact, the deal and the company |
| `pipedrive` | A Pipedrive note on the person, the deal and the organization |
| `webhook` | A `crm.activity` event (see [Your own endpoint](#your-own-endpoint)) |

Each note starts with a headline such as "Email sent: Quick question" or "Meeting: booked for 2026-10-08 13:00 UTC". Every note is written once per event: retries and a switch between live and daily never write it twice. The one exception is a write whose answer was lost (the CRM saved the note, but a timeout hid that), which the retry can write again ([Delivery guarantees](../concepts/delivery-guarantees.md#at-least-once-by-design)).

### Providers

| Provider | Secret (env var) | Pushes |
| --- | --- | --- |
| `hubspot` | Private app token (`HUBSPOT_ACCESS_TOKEN`) | Contacts matched by email, companies matched by domain (or created), deals found on the contact by title before one is created, notes, contact deletes |
| `pipedrive` | Personal API token (`PIPEDRIVE_API_TOKEN`) | Persons matched by email, organizations matched by name, deals found on the person by title before one is created (open, won or lost with the lost reason), notes, person deletes |
| `webhook` | Optional signing secret (`CRM_WEBHOOK_SIGNING_SECRET`) | Signed JSON POSTs to your https endpoint |

Deals are named `<company> (OpenOutbound <ref>)`, or after the person when there is no company; the ref is the end of the opportunity id, so each opportunity has its own deal: a new opportunity for someone never reopens their earlier won or lost deal, and a deal another opportunity links to is never reused. When an opportunity is created or changes (as it happens, or in the daily run with `crm.timing: daily`), the job `inbox.crm_sync` pushes the person, the company and the deal (6 attempts, backoff from 1 minute to 1 hour). Creating a person's contact and an opportunity's deal happens one job at a time per record, so a deal sync and a meeting note running together never create the same contact twice.

#### HubSpot

1. In HubSpot, create a private app (Settings, Integrations, Private apps) with read and write scopes for contacts, companies and deals.
2. Configure it:

   ```bash
   openoutbound --workspace acme providers set --slot crm --provider hubspot \
     --secrets '{"access_token":"pat-..."}' --test
   ```

| Config | Default | Meaning |
| --- | --- | --- |
| `pipeline` | `default` | Deal pipeline id |
| `stage_map` | `interested` to `qualifiedtobuy`, `meeting_booked` to `presentationscheduled`, `won` to `closedwon`, `lost` to `closedlost` | OpenOutbound stage to HubSpot deal stage id |
| `send_currency` | `false` | Set the deal currency (only for portals with several currencies) |
| `base_url` | `https://api.hubapi.com` | |

With `crm.on_forget: delete`, a forgotten person's contact is removed with HubSpot's GDPR delete.

Finding an existing deal on a contact uses HubSpot's search by associated contact, which has not been verified against a live portal yet: test with one opportunity (`crm sync --opportunity-id ...`) first.

#### Pipedrive

```bash
openoutbound --workspace acme providers set --slot crm --provider pipedrive \
  --secrets '{"api_token":"..."}' \
  --config '{"base_url":"https://yourcompany.pipedrive.com","pipeline_id":1,"stage_map":{"interested":1,"meeting_booked":3}}' --test
```

Find the token under Settings, Personal preferences, API. Set `base_url` to your company's Pipedrive address: the general `https://api.pipedrive.com` address has not been verified with personal tokens. Without a `stage_map`, open deals go to the pipeline's first stage. Notes use Pipedrive's notes API (version 1), and whether it takes the same token header as version 2 has not been verified; neither has the deals filter by person. Test with `--test` and one opportunity (`crm sync --opportunity-id ...`) first.

#### Your own endpoint

```bash
openoutbound --workspace acme providers set --slot crm --provider webhook \
  --config '{"url":"https://crm-bridge.example.com/openoutbound"}' --secrets '{"signing_secret":"..."}' --test
```

Each push is a POST with a JSON body `{ id, type, occurred_at, workspace_id, data }` and, when a secret is set, the `OpenOutbound-Signature` header (the same format as event webhooks, below). 10 second timeout, redirects are not followed.

| `type` | Sent when | `data` |
| --- | --- | --- |
| `crm.contact.upsert` | A person (and their company) is created or updated | `person`, `company`, `existing` (`contact_id`, `company_id` you returned before) |
| `crm.deal.upsert` | A deal is created or updated | `opportunity`, `links` (`contact_id`, `company_id`, `deal_id`), `title`, `keep_stage` (true: leave the stage as your CRM has it) |
| `crm.activity` | A note, under `crm.log` `key_moments` or `everything` | `activity`: `kind` (`email_sent`, `email_received`, `reply`, `meeting`, `note`), `contact_id`, `deal_id`, `company_id`, `subject`, `body` (plain text, at most 2000 characters), `occurred_at` |
| `crm.contact.delete` | A forgotten person's contact, with `crm.on_forget: delete` | `contact_id` |
| `crm.test` | `--test` | `message` |

Answer with `{ "contact_id": "...", "company_id": "..." }`, `{ "deal_id": "..." }` or `{ "activity_id": "..." }` so the engine stores your ids and sends them back next time; answer `{ "deleted": false }` when a contact to delete was already gone. The engine cannot search your endpoint, so make it upsert: use the ids in `existing` and `links`, and the deal `title`.

#### Sync by hand

```bash
openoutbound --workspace acme crm sync --dry-run                          # what would be pushed
openoutbound --workspace acme crm sync --opportunity-id opp_...
openoutbound --workspace acme crm sync --limit 200                        # open opportunities, up to 500
```

MCP: `manage_crm` action `sync` (also `manage_pipeline` action `sync_crm`). Use it after connecting a CRM or fixing its credentials; everything else syncs by itself.

### Live or daily

| `crm.timing` | How it works |
| --- | --- |
| `live` | Each event (a pipeline change, a reply, a send, a meeting) is written as it happens, by durable handlers that retry. |
| `daily` | Nothing is written during the day. At 02:40 UTC the job `inbox.crm_daily` replays the day's events from the event log in order, through the same rules. Its position is stored as the consumer `crm.builtin`; the first run starts 24 hours back, and more than 5000 events continue in a follow-up run. When the CRM fails, the position stays at the failed event and the job retries. |

The event log is pruned by `system.maintenance`, so with `daily` the engine must run at least once a day. Switching back to `live` forgets the daily position. Facts back and forget handling never wait for the daily run.

### When a sync fails

A provider that rejects a write for good (bad token, missing pipeline or stage) or keeps failing through every retry opens one `crm_sync_failed` problem per provider: severity high, owner person, with the error and the fix. It resolves by itself after the next successful write to that provider. A rejected token or a used-up quota also pauses the provider for the workspace with a `provider_down` problem, until the credentials change or `providers test` passes; see [Provider failures](../concepts/provider-failures.md#paused-providers).

A note or an activity whose answer was lost (a timeout, a broken connection, a server error) may already be in the CRM, so it is not written again blindly: its link is recorded as unknown. Contacts, companies and deals are found by their key before each write, so those are simply retried.

```bash
openoutbound --workspace acme providers test --slot crm      # find the cause
openoutbound --workspace acme crm sync                        # push again once fixed
```

### CRM facts: tell the engine what your CRM knows

The facts door takes 1 to 500 facts per call and acts on each at once. Operation `crm.facts`, CLI `crm facts`, REST `POST /v1/crm/facts`, MCP `manage_crm` action `record_facts`, and the [CRM facts webhook](#crm-facts-webhook) for CRMs and automation tools.

| Fact | Effect |
| --- | --- |
| `customer` | The company's status becomes `customer` (the person's, when they have no company) and every sequence in progress at the company stops (reason `crm_customer`). A company marked do not contact or competitor keeps that status. |
| `not_customer` | Undoes `customer` (back to `active`); never lifts do not contact. With `domain` or `company_id` it lifts the company; with only an `email` or `person_id` it changes that person alone (a company that is a customer stays one, with a warning). |
| `open_deal` | The company is flagged `crm_open_deal` and, unless `crm.allow_outreach_with_open_deal`, its sequences stop (reason `crm_open_deal`). Pass `owner` to say whose deal it is. |
| `no_open_deal` | The flag is cleared, when the fact names the company (`domain` or `company_id`); about one contact, the flag stays, with a warning. |
| `closed_lost` | Recorded in the company file. One deal was lost, but another may still be open, so the flag stays: send `no_open_deal` when the account has none left. |
| `owned_by` | The account owner is stored (`owner` null or empty clears it); with `crm.skip_owned_accounts`, the company's sequences stop (reason `crm_owned`). |
| `do_not_contact` | A person (by `email` or `person_id`): status `do_not_contact`, an email suppression (source `crm`) and their sequences stop. A company (by `domain` or `company_id` only): status `do_not_contact`, a company suppression and every sequence there stops. An address or domain the engine has never seen is still suppressed, except a free mail domain such as gmail.com: that fact gets an error (send the person's email instead). |

How a fact finds its record: a person by `person_id` or `email`; a company by `company_id`, by `domain` (a website address works too), else the person's company, else, for account facts, the domain of the email unless it is a free mail provider. A fact that matches nothing changes nothing (except `do_not_contact`, which still suppresses) and says so in its result.

Blocks go on from a fact about one person (their whole company is blocked, to be safe), but a block on a whole company only comes off with a fact that names the company: one contact who is not a customer, or one lost deal, says nothing about the account.

Every matched fact is also stored in the lead or company file (source `crm`, for example "Customer in HubSpot" or "Open deal in Pipedrive, owned by Sam Park"), where it replaces the earlier CRM fact on the same subject; `external_id` is linked to the record; the company's `crm_updated_at` is stamped; and `crm.fact_recorded` fires when something changed. Repeating a fact changes nothing, so a daily full export is safe. A bad fact gets an error in its own result and never stops the others.

```bash
openoutbound --workspace acme crm facts --dry-run --input '{"crm":"hubspot","facts":[
  {"fact":"customer","domain":"harbor-dental.example.com","external_id":"8462427879"},
  {"fact":"owned_by","domain":"northwind.example.com","owner":"Sam Park"},
  {"fact":"do_not_contact","email":"dana@bluefield.example.org"}]}'
```

Each result names the fact's position, what it matched (`person_id`, `company_id`, `matched_by`, or `unmatched_reason`), the `effects` in plain words (for example "stopped 2 enrollments (crm_customer)"), `warnings` and `error`, plus a summary of changed, unchanged, unmatched and failed facts.

### CRM facts webhook

A secret URL per workspace where a CRM workflow, Zapier or n8n sends the same JSON as the facts door, without an API key.

```bash
openoutbound --workspace acme crm create-webhook             # shows the URL once
openoutbound --workspace acme crm create-webhook --rotate    # new URL; the old one stops working
```

MCP: `manage_crm` action `webhook`. The URL looks like `https://outbound.example.com/hooks/crm/crmh_...`; only a hash of it is stored.

```bash
curl -X POST "https://outbound.example.com/hooks/crm/crmh_..." \
  -H 'content-type: application/json' \
  -d '{"crm":"hubspot","facts":[{"fact":"customer","domain":"harbor-dental.example.com","external_id":"8462427879"}]}'
```

| Answer | When |
| --- | --- |
| `200` `{ ok, dry_run, crm, results, summary }` | The facts were applied; add `"dry_run": true` to the body to preview without changes |
| `400` `invalid_json` or `invalid_body` | The body is not JSON, or not `{ crm, facts }` with 1 to 500 facts (the message names the first problems) |
| `404` | Unknown or rotated URL |
| `413` | The body is larger than 512 KB |
| `500` | Something failed on our side; send it again (repeating facts is safe) |

The URL is the secret: anyone who has it can mark companies as customers (which stops outreach there) or suppress addresses. Keep it in your CRM's or automation tool's secret storage and rotate it if it leaks. Every call is audited as `crm.webhook`.

The examples below are generic: menus and field names depend on your plan and version, so check a sample delivery first. They all end with the same JSON.

**HubSpot workflow.** Create a deal-based workflow that enrolls deals when the deal stage is Closed won. Add a step that sends JSON to the URL: a custom code action, or a webhook action that lets you set the body, depending on your plan. Send the associated company's domain and the deal or company id:

```json
{ "crm": "hubspot", "facts": [{ "fact": "customer", "domain": "harbor-dental.example.com", "external_id": "8462427879" }] }
```

A second workflow for new open deals created by sales can send `open_deal` with `owner`, and one on a contact property such as "Do not contact" can send `do_not_contact` with the email.

**Pipedrive webhooks.** Pipedrive sends its own JSON, so put a small mapping step in between (a Zapier or n8n step, or a few lines of code in a function you host). Subscribe it to deal updates, look up the organization's website or the person's email, and turn the deal's status into one fact:

| Pipedrive deal | Fact |
| --- | --- |
| Status `won` | `customer` |
| Status `open`, created by sales | `open_deal`, with `owner` set to the deal owner's name |
| Status `lost` | `closed_lost`, and `no_open_deal` when the organization has no open deal left |
| Deleted | `no_open_deal` when the organization has no open deal left |

```json
{ "crm": "pipedrive", "facts": [{ "fact": "closed_lost", "domain": "northwind.example.com", "external_id": "1234", "note": "Went with another vendor" }] }
```

**Zapier.** Trigger on the CRM event (a deal won, an owner changed). Action: Webhooks by Zapier, Custom Request, method POST, the secret URL, header `Content-Type: application/json`, and as data the JSON above with the domain, email, owner and id mapped from the trigger.

**n8n.** Start with a trigger node for your CRM (or a Schedule node plus a CRM node that lists customers every night). Add an HTTP Request node: method POST, the secret URL, body type JSON, and a body such as `{ "crm": "hubspot", "facts": [{ "fact": "customer", "domain": "{{ $json.domain }}" }] }`. A nightly job can send up to 500 facts per call.

### Links

`crm_links` remembers which CRM record matches each person, company and deal, per CRM. The built-in providers store their own ids. In agent mode the agent reports them:

```bash
openoutbound --workspace acme crm link --provider salesforce --entity-type person \
  --entity-id pe_01k6a3v0q8x3m2n4p5r6s7t8v9 --external-id 0035g00000XyZabAAB
```

MCP: `manage_crm` action `link`. Linking again with another id moves the link; a linked deal also shows in the opportunity's `crm_refs`. The engine never calls your CRM when you link. Links are how `crm status` counts records per CRM and how a forgotten person's CRM records are found.

### Forgotten people

When a person is forgotten (erased for privacy), the event `lead.forgotten` carries only their CRM links (their contact and the deals of their opportunities) and a SHA-256 of their email. `crm.on_forget` decides what happens in the CRM, right away whatever `crm.timing` says:

| `crm.on_forget` | What happens |
| --- | --- |
| `task` (default) | One `crm_forget` problem per record that held them: "Delete contact 8462 in HubSpot", and "Check a deal in HubSpot" for each linked deal (it may carry their name or notes). Owner person for the engine's providers, agent for CRMs the agent reported with `link`. With no known record, one problem asks to find the contact by the email hash and delete it: the agent in agent mode, a person in `built_in` mode when a CRM provider is configured. |
| `delete` | While `crm.mode` is `built_in`, contacts in HubSpot, Pipedrive or your endpoint are deleted by the job `inbox.crm_forget_delete` (6 attempts); a final failure opens the task instead. Deals and CRMs the engine cannot reach get the task. |
| `nothing` | The CRM is left alone. |

Problems carry CRM ids and the email hash only, never a name or address; the remedy names the hash, so no other lookup is needed. Resolve a task with `resolve_exception` once it is done. Company records are left alone.

### Status

`crm status` (MCP `manage_crm` action `status`) shows the mode and every preference, each configured provider with what it supports (notes, finding records, deleting contacts), how many people, companies, deals and notes are linked per CRM and when each last synced, the daily position, open CRM problems, whether the facts webhook exists and when it was last used, and the next steps in plain words.

## Notifications

Notification channels tell humans what happened. Each workspace can have several.

| Type | Config | Notes |
| --- | --- | --- |
| `slack_webhook` | `--url` of a Slack incoming webhook | The URL is stored encrypted |
| `email` | `--to` (1 to 20 addresses), optional `--mailbox-id` | Sent from that mailbox (default: an active one) as plain text; does not count toward sending limits |
| `webhook` | `--url` (https) | Signed JSON POST; the signing secret is shown once |

```bash
openoutbound --workspace acme notifications create --type slack_webhook --name "Sales alerts" --url https://hooks.slack.com/services/...
openoutbound --workspace acme notifications test --channel-id ntf_...
```

MCP: `manage_notifications` (toolset `admin`).

**What a channel receives.** A channel without `--events` gets the curated notifications:

- Hot replies (interested, meeting requests), negative replies and replies that need a human
- Possible prompt injection, and prospects asking whether they talk to a bot
- Privacy requests, with reminders when the deadline is close or has passed
- Meetings booked, rescheduled, cancelled or missed, and bookings by someone who is not a lead ([Meetings](meetings.md))
- Paused or failing mailboxes, failed daily DNS checks, restricted or disconnected LinkedIn accounts, bounce warnings
- Workspace paused or resumed, and scheduled reports

A channel with `--events reply.classified,opportunity.updated` (or `*`) gets one short message per matching event instead: a title and up to 8 fields. Severity is critical for `linkedin.account_restricted`; warning for `mailbox.paused`, `mailbox.error`, `message.failed`, `message.bounced` and `thread.needs_attention`; info for the rest.

Slack messages show a bold title, the lines, an icon for warnings and a link back when `OPENOUTBOUND_BASE_URL` is public. Webhook channels receive:

```json
{ "type": "notification", "title": "Hot reply from ...", "lines": ["..."], "url": null, "severity": "info", "event": "reply.classified", "sent_at": "2026-09-27T10:20:36.986Z" }
```

Delivery is retried up to 4 times (1 to 30 minutes apart) when the failure is temporary (a timeout, a rate limit, a server error); Slack's `Retry-After` is honored. A failure that sending again cannot fix (the URL answers 404 or 410, a rejected login, a missing secret, an email channel without recipients) is not retried.

### When a channel fails

Every failed delivery counts on the channel, retries and `notifications test` included. `notifications list` shows the count (`consecutive_failures`), the last error (`last_error`) and its class (`last_failure`).

| When | What happens |
| --- | --- |
| 5 failed deliveries in a row | The channel is `failing` (since `failing_since`) and one problem opens: kind `custom`, severity high, owner person, titled like "Notification channel "Sales alerts" is failing", with the fix. The channel stays enabled, so it recovers by itself once fixed |
| A delivery or test that works | The count goes back to 0, `failing` turns false and the problem is resolved |
| `notifications delete` | The problem is resolved |

To fix a failing channel, run `notifications test --channel-id ntf_...` to see the error. A Slack webhook that answers 404 or 410 was removed in Slack: create a channel with the new URL and delete the old one.

## Event webhooks

For systems rather than people, subscribe a URL to events:

```bash
openoutbound --workspace acme webhooks create --url https://hooks.example.com/openoutbound --events reply.classified,opportunity.updated
openoutbound --workspace acme webhooks test --webhook-id whk_...
```

The body is `{ id, type, occurred_at, workspace_id, subject, data }`. Payloads carry ids, never message bodies. Failed deliveries retry for about 2 days. The [events reference](../reference/events.md) lists every event with its payload and the delivery rules.

## Verify a signature

Event webhooks, webhook notification channels, the CRM webhook, signal automation webhooks and campaign webhook steps all sign the same way:

```text
OpenOutbound-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>
```

Verify it against the raw body, before parsing the JSON, and reject old timestamps:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.trim().split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), "hex");
  const given = Buffer.from(parts.v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

A complete version is in [examples/webhooks/verify-signature.mjs](../../examples/webhooks/verify-signature.mjs). The library also exports `verifyWebhookSignature` for TypeScript receivers.

Next: [Events](../reference/events.md) · [Inbox](../concepts/inbox.md) · [Reports](../concepts/reports.md) · [Security](security.md)
