# Events

This page lists every event the engine emits, with its payload fields and when it fires. Use it to build webhook receivers, automations and integrations.

## How events reach you

| Consumer | How |
| --- | --- |
| Your own URL | `openoutbound webhooks create --url https://... --events reply.classified,opportunity.updated` (or `["*"]` for all). Signed POST per event. |
| Slack, email or a webhook for humans | Notification channels with `events` set send one short message per matching event. See [CRM and notifications](../guides/crm-and-notifications.md). |
| Agents and scripts that catch up | The change feed: `event_feed` action `list` (MCP), `openoutbound events list` (CLI) or `GET /v1/events` (REST), with a named consumer whose position the engine keeps. See [Change feed](../getting-started/connect-your-agent.md#change-feed). |
| Engine modules | Durable in-process handlers that run as jobs and retry on failure |

Events are stored for 90 days, then pruned by the daily maintenance job. `leads.forget` replaces the forgotten person's email address and LinkedIn URL with `[erased]` in stored events, so webhook deliveries retried after that carry `[erased]` too.

### Webhook delivery format

```http
POST /your/endpoint HTTP/1.1
Content-Type: application/json
OpenOutbound-Signature: t=1790000000,v1=5f2b...
OpenOutbound-Event: reply.classified
OpenOutbound-Delivery: whd_...

{
  "id": "evt_...",
  "type": "reply.classified",
  "occurred_at": "2026-09-27T10:20:36.986Z",
  "workspace_id": "ws_...",
  "subject": { "type": "message", "id": "msg_..." },
  "data": { "message_id": "msg_...", "thread_id": "thr_...", "person_id": "pe_...", "category": "interested", "confidence": 0.92 }
}
```

- The signature is `v1 = hex(HMAC-SHA256(secret, t + "." + raw body))`. Verify it against the raw body and reject old timestamps; [examples/webhooks/verify-signature.mjs](../../examples/webhooks/verify-signature.mjs) does both. The secret is shown once, when the webhook is created.
- Any 2xx response counts as delivered. Redirects are not followed. The request times out after 10 seconds.
- Failed deliveries retry after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours and 24 hours (8 attempts in total, about two days). A `Retry-After` header can push a retry later.
- Deliveries are at least once: one can arrive more than once (a retry after an answer that got lost) and out of order. Deduplicate by the body's `id`, the event id, which is the same for every endpoint and every retry; the `OpenOutbound-Delivery` header (`whd_...`) is the same for every retry of one delivery to one endpoint. Order by `occurred_at`. See [Delivery guarantees](../concepts/delivery-guarantees.md#at-least-once-by-design).
- Payloads hold ids, never message bodies or secrets. Fetch details through the API (`GET /v1/threads/{thread_id}`, `GET /v1/messages/{message_id}`, and so on).
- Endpoints must be `https://` and public. Private and local addresses need `OPENOUTBOUND_ALLOW_PRIVATE_NETWORK=true`.

`openoutbound webhooks test --webhook-id whk_...` sends a signed test delivery now.

## Event list

Payload fields are snake_case. `null` means "not known" or "not applicable".

### Leads and data

| Event | Fires when | Payload |
| --- | --- | --- |
| `lead.created` | A person or company is created: import, find, API, a referral, or a signal about an unknown company | `kind` (`person` or `company`), `id`, `source`, `import_id` |
| `lead.updated` | A person or company changes (for example a campaign end action adds a tag) | `kind`, `id`, `changes` (changed field names) |
| `import.completed` | A lead import (a file, rows, or an import from a find preview) finishes | `import_id`, `source`, `status` (`completed`, or `partial` when a paid source failed part way and only what it returned was imported; `failed` is reserved and not sent yet), `list_id`, `stats` (`created`, `updated` including merged, `skipped`, `failed`) |
| `enrichment.completed` | The enrichment job finished one person, including people it skipped | `person_id`, `email`, `email_status`, `provider` (the finder or `website` that found a new address, else null), `status` (`found`, `verified`, `kept`, `not_found`, `skipped`, or `provider_failed` when a finder or the verifier failed and nothing usable was found), `credits_used` |
| `research.completed` | A research brief is ready, partial or failed | `brief_id`, `company_id`, `person_id`, `status` (`ready`, `partial` when a source failed and the brief lists the gaps, or `failed`), `confidence` (`low`, `medium`, `high` or null) |
| `signal.detected` | A new signal is stored with a score of at least 1 | `signal_id`, `definition_key`, `company_id`, `person_id`, `title`, `evidence_url`, `strength`, `score` |
| `automation.enroll_requested` | A signal automation with an enroll action fires without requiring approval | `rule_id`, `campaign_id`, `person_ids`, `signal_id` |
| `knowledge.gap_opened` | A prospect asked something the knowledge base cannot answer | `gap_id`, `question`, `thread_id` |
| `lead.fact_recorded` | A fact was added to a lead file or a company file (from a reply, a note, an agent, a CRM or research) | `fact_id`, `person_id`, `company_id`, `kind` (`fact`, `timing`, `preference`, `objection`, `relationship`, `note`), `source` (`reply`, `manual`, `agent`, `crm`, `research`) |
| `lead.forgotten` | A person or an address was forgotten (`leads.forget`, GDPR erasure). Carries no readable personal data | `person_id` (null for an address with no record), `email_sha256` (SHA-256 hex of the lowercased, trimmed email, or null), `crm_links` (the person's CRM records: their contacts and the deals of their opportunities, each `provider`, `entity_type` `person` or `opportunity`, `external_id`) |
| `company.hold_changed` | A hold on a whole company was set, changed or lifted | `company_id`, `hold_until` (ISO 8601, null when lifted), `reason` |
| `crm.fact_recorded` | A CRM, or an agent reading one, reported a fact about a person or company | `fact` (`customer`, `not_customer`, `open_deal`, `no_open_deal`, `closed_lost`, `owned_by`, `do_not_contact`), `person_id`, `company_id`, `crm` (the CRM name) |
| `privacy.requested` | A prospect asked to delete their data, to see it, or where it came from | `person_id`, `message_id`, `kind` (`delete`, `access`, `source`), `due_at` (the answer deadline, ISO 8601) |

### Campaigns and messages

| Event | Fires when | Payload |
| --- | --- | --- |
| `campaign.launched` | A campaign is launched | `campaign_id`, `name` |
| `campaign.paused` | A campaign is paused | `campaign_id`, `reason` |
| `campaign.completed` | A campaign is stopped, or its last enrollment finishes | `campaign_id` |
| `enrollment.stopped` | A person's enrollment stops before the end | `enrollment_id`, `campaign_id`, `person_id`, `reason` (for example `replied`, `company_replied`, `meeting_booked`, `unsubscribed`, `bounced`, `manual`) |
| `message.drafted` | A campaign message or a reply draft is written | `message_id`, `person_id`, `campaign_id`, `channel` (`email` or `linkedin`), `action`, `status` |
| `message.approved` | A message is approved, by a human or because its review level did not require review. A reply to someone who opted out, was suppressed or erased while it waited is cancelled instead, without this event | `message_id`, `approval_id` (null without review) |
| `message.sent` | An email or LinkedIn action of the engine went out (also when a send with an unknown outcome is confirmed later; emails a person writes from the mailbox itself do not fire it) | `message_id`, `thread_id`, `person_id`, `campaign_id`, `channel`, `action` (`email`, `reply`, `invite`, `message`, `comment`, `like`, `visit`), `sent_at` |
| `message.failed` | Sending failed | `message_id`, `error`, `retryable` |
| `message.unknown` | A send may or may not have gone out (a timeout or a crash while sending). It is checked before any retry and never resent blindly | `message_id`, `channel`, `reason` |
| `message.duplicate` | A message went out twice: the late answer of an earlier attempt said it went out after a newer attempt had sent it again. A `duplicate_send` problem opens with it, and the campaign report counts it in `duplicates`. See [Delivery guarantees](../concepts/delivery-guarantees.md#duplicates) | `message_id`, `attempts` (both attempt numbers, oldest first), `channel`, `campaign_id`, `person_id` |
| `message.bounced` | A bounce notice arrived for a sent email | `message_id`, `person_id`, `email`, `bounce_type` (`hard` or `soft`), `reason` |
| `unsubscribe.received` | Someone unsubscribed | `person_id`, `email`, `source` (`link`, `one_click`, `reply` or `manual`), `message_id` |

### Replies, pipeline and approvals

| Event | Fires when | Payload |
| --- | --- | --- |
| `reply.received` | An inbound email or LinkedIn message matched a thread | `message_id`, `thread_id`, `person_id`, `campaign_id`, `channel` |
| `reply.classified` | The inbox classified a reply | `message_id`, `thread_id`, `person_id`, `category`, `confidence` |
| `thread.needs_attention` | A thread needs a human (hot reply, question not in knowledge, negative reply, failed draft) | `thread_id`, `reason`, `category` |
| `thread.taken_over` | A person answered in a thread themselves (a reply found in the mailbox's Sent folder, or `take_over` by hand), so the engine stepped back from it. Fires again for every later email the person writes in the thread | `thread_id`, `person_id`, `message_id` (the person's message, or null) |
| `thread.released` | A thread a person took over was handed back to the engine | `thread_id` |
| `meeting.booked` | A meeting was booked, through a booking tool webhook or recorded by a person or agent | `meeting_id`, `person_id`, `opportunity_id`, `source` (`calendly`, `cal_com`, `generic`, `manual`), `start_at`, `matched_by` (`ref`, `email`, `manual`) |
| `meeting.rescheduled` | A booked meeting moved to another time (it stays scheduled) | `meeting_id`, `person_id`, `opportunity_id`, `start_at`, `previous_start_at` |
| `meeting.cancelled` | A booked meeting was cancelled. No old sequence restarts | `meeting_id`, `person_id`, `opportunity_id` |
| `meeting.no_show` | The prospect did not show up to a meeting | `meeting_id`, `person_id`, `opportunity_id` |
| `meeting.held` | A meeting took place: marked held, or assumed held after `booking.assume_held_after_hours` | `meeting_id`, `person_id`, `opportunity_id`, `qualified` (true, false or null when not judged) |
| `opportunity.updated` | An opportunity is created or changes stage | `opportunity_id`, `stage` (`interested`, `meeting_booked`, `won`, `lost`), `previous_stage`, `person_id`, `company_id` |
| `approval.requested` | Work is held for a human | `approval_id`, `kind`, `title`, `target_type`, `target_id` |
| `approval.decided` | Someone approved, rejected or edited an approval | `approval_id`, `kind`, `decision` (`approve`, `reject` or `edit`), `status` |

### Senders, content and reports

| Event | Fires when | Payload |
| --- | --- | --- |
| `mailbox.paused` | A mailbox was paused by its health check | `mailbox_id`, `email`, `reason` |
| `mailbox.error` | A mailbox failed to send or sync | `mailbox_id`, `email`, `error` |
| `mailbox.dns_failed` | The daily DNS check found a record that stopped passing (green before, or red now). One event per sending mailbox of the domain; the mailbox is not paused | `mailbox_id`, `domain`, `failed` (the checks that changed: `mx`, `spf`, `dkim`, `dmarc`) |
| `linkedin.connected` | A prospect accepted a connection invite | `account_id`, `person_id`, `connected_at` |
| `linkedin.account_restricted` | LinkedIn restricted one of your accounts; its actions stop | `account_id`, `reason` |
| `post.published` | A LinkedIn post was published (also when a post whose publish got no clear answer is confirmed later, by a late answer or with `manage_posts` action `resolve_unknown`) | `post_id`, `url` and `external_id` (null when LinkedIn sent none back) |
| `report.ready` | A scheduled report was produced | `report_id`, `type` |

### Problems and changes

| Event | Fires when | Payload |
| --- | --- | --- |
| `problem.opened` | A new problem item needs someone. An open item with the same key is updated instead, without this event | `problem_id`, `kind`, `severity` (`urgent`, `high`, `normal`, `low`), `subject_type`, `subject_id` |
| `problem.resolved` | A problem item was resolved (once, on the first resolve) | `problem_id`, `kind`, `resolution` |
| `change.recorded` | A change to workspace settings, an offer, an ICP or a campaign was recorded with a new workspace version | `change_id`, `version`, `area` (`settings`, `offer`, `icp`, `campaign`), `target_id`, `proposal_id` |
| `proposal.reviewed` | An applied proposal got its before and after numbers | `proposal_id`, `verdict` (`better`, `worse`, `flat`, `unclear`) |

Reply categories are `interested`, `meeting_request`, `question`, `objection`, `not_now`, `referral`, `wrong_person`, `out_of_office`, `unsubscribe`, `privacy_request`, `bounce`, `negative`, `auto_reply_other` and `other`. See [Inbox](../concepts/inbox.md).

Approval kinds are `message`, `reply`, `campaign_launch`, `lead_import`, `enrollment`, `post`, `comment`, `spend`, `referral`, `mailbox_limits`, `change` and `custom`. See [Safety and approvals](../concepts/safety-and-approvals.md#approvals).

## Compatibility

Fields are only added, never renamed or removed, within a major version. Ignore fields you do not know.

Next: [CRM and notifications](../guides/crm-and-notifications.md) · [REST API](rest-api.md) · [Configuration](configuration.md)
