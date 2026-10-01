# Configuration

This page lists every environment variable, every workspace setting and every campaign setting, with its default and meaning.

The settings tables are generated from the zod schemas in `src/core/settings.ts` by `pnpm exec tsx scripts/generate-settings-docs.ts`. Do not edit them by hand.

## Environment variables

The engine reads the process environment and the `.env` file in the engine home (real environment variables win). Empty values count as unset. `openoutbound init` writes the first three; everything else is optional.

### Core

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `pglite://.openoutbound/pglite` | `postgres://user:pass@host:5432/db` (Postgres), `pglite://<dir>` (embedded, on disk, relative to the engine home) or `memory://` (embedded, lost on exit) |
| `OPENOUTBOUND_SECRET_KEY` | none | 32 random bytes in base64 (`openssl rand -base64 32`). Encrypts stored secrets. Required unless `DATABASE_URL` is `memory://`. Back it up. |
| `OPENOUTBOUND_BASE_URL` | `http://localhost:<PORT>` | Public URL of this instance. Used in unsubscribe links, OAuth redirect URIs and webhook URLs. Must be reachable by recipients and providers in production. |
| `PORT` | `7331` | HTTP port for `serve` |
| `HOST` | `127.0.0.1` | Bind address for `serve`; `0.0.0.0` in containers |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. Logs are JSON lines on stderr. |
| `OPENOUTBOUND_HOME` | see [Install](../getting-started/install.md#where-your-data-lives) | Engine home (the folder with `.env` and `.openoutbound/`). Same as `--home`. |
| `OPENOUTBOUND_WORKSPACE` | none | Default workspace for CLI commands and MCP tool calls (`openoutbound mcp --workspace <slug>` binds the session instead) |
| `OPENOUTBOUND_URL` | none | Send CLI and `openoutbound mcp` calls to this running server (bridge mode) |
| `OPENOUTBOUND_API_KEY` | none | API key for bridge mode (`--api-key` comes first): the CLI uses it with `--url`, `OPENOUTBOUND_URL` or a running local server (before that server's own key); `openoutbound mcp` only with `--url` or `OPENOUTBOUND_URL`, so without them an agent session stays `local-agent` |
| `OPENOUTBOUND_MCP_TOOLSETS` | `core` | Comma list of MCP toolsets: `core`, `leads`, `campaigns`, `inbox`, `signals`, `content`, `admin`, `agent_brain`, `all` |
| `OPENOUTBOUND_AGENT_SCOPES` | `read,write,send,spend` | Scopes of the local embedded MCP agent (`read`, `write`, `send`, `spend`, `approve`, `admin`). With `approve` it decides approvals others requested, never its own |
| `OPENOUTBOUND_ALLOW_PRIVATE_NETWORK` | `false` | Allow fetches and webhooks to private, loopback and link-local addresses. Cloud metadata addresses stay blocked. |
| `OPENOUTBOUND_SECRET_KEY_VERSION` | `1` | Version number of the current secret key, for key rotation |
| `OPENOUTBOUND_PREVIOUS_SECRET_KEYS` | none | Older keys after a rotation: `1:<base64>,2:<base64>`. They read secrets not yet re-encrypted and check unsubscribe links sent before the rotation. |
| `NO_COLOR` | unset | Any value turns off colors in CLI output |

Key rotation: set a new `OPENOUTBOUND_SECRET_KEY`, raise `OPENOUTBOUND_SECRET_KEY_VERSION`, list the old key in `OPENOUTBOUND_PREVIOUS_SECRET_KEYS`, restart the engine, then run `openoutbound db reencrypt-secrets`. Keep the old keys listed afterwards for unsubscribe links. The steps are in [Security](../guides/security.md#rotate-the-secret-key).

### Integrations

| Variable | Meaning | Guide |
| --- | --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Your Google OAuth app, for connecting Google Workspace mailboxes with OAuth | [Mailboxes](../guides/mailboxes.md) |
| `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET` | Your Microsoft Entra app, for Microsoft 365 mailboxes | [Mailboxes](../guides/mailboxes.md) |
| `MICROSOFT_OAUTH_TENANT` | Entra tenant id; default `common` | [Mailboxes](../guides/mailboxes.md) |
| `MAILBOX_*` | Any variable starting with `MAILBOX_` can hold a mailbox password; pass its name as `password_env` so the password never enters a chat | [Mailboxes](../guides/mailboxes.md) |
| `UNIPILE_WEBHOOK_SECRET` | Shared secret for the Unipile webhook at `/hooks/unipile` (header `X-OpenOutbound-Secret`). Without it LinkedIn syncs by polling every 15 minutes. | [LinkedIn](../guides/linkedin.md) |
| `CRM_WEBHOOK_SIGNING_SECRET` | Signing secret for the `webhook` CRM provider | [CRM and notifications](../guides/crm-and-notifications.md) |

### Provider environment variables

Each provider falls back to these when no secret is stored for it. See [Providers](../concepts/providers.md#how-the-engine-picks-a-provider).

| Variable | Slot | Provider |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | brain | `anthropic` |
| `OPENAI_API_KEY` | brain | `openai` (also set its models) |
| `OPENROUTER_API_KEY` | brain | `openrouter` (also set its models; see [AI brain](../guides/ai-brain.md)) |
| `GEMINI_API_KEY` | brain | `gemini` (also set its models) |
| `APOLLO_API_KEY` | lead_source | `apollo` |
| `GOOGLE_MAPS_API_KEY` | lead_source | `google_maps` |
| `ICYPEAS_API_KEY` | email_finder | `icypeas` |
| `FINDYMAIL_API_KEY` | email_finder | `findymail` |
| `HUNTER_API_KEY` | email_finder | `hunter` |
| `PROSPEO_API_KEY` | email_finder | `prospeo` |
| `MILLIONVERIFIER_API_KEY` | email_verifier | `millionverifier` |
| `REOON_API_KEY` | email_verifier | `reoon` |
| `PARALLEL_API_KEY` | research | `parallel` |
| `EXA_API_KEY` | research | `exa` |
| `TAVILY_API_KEY` | research | `tavily` |
| `FIRECRAWL_API_KEY` | research | `firecrawl` |
| `PREDICTLEADS_API_KEY`, `PREDICTLEADS_API_TOKEN` | signals | `predictleads` (both needed) |
| `CRUSTDATA_API_KEY` | signals | `crustdata` |
| `UNIPILE_DSN`, `UNIPILE_API_KEY` | linkedin, social | `unipile` (both needed; the DSN looks like `api1.unipile.com:13111`) |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | social | `linkedin_official` |
| `HUBSPOT_ACCESS_TOKEN` | crm | `hubspot` |
| `PIPEDRIVE_API_TOKEN` | crm | `pipedrive` |

Slack notifications are not set in `.env`: add them per workspace as a notification channel with `openoutbound --workspace <slug> notifications create --type slack_webhook --name Slack --url https://hooks.slack.com/...` (MCP: `manage_notifications` action `create`). See [CRM and notifications](../guides/crm-and-notifications.md).

## Workspace settings

Stored per workspace, changed with `openoutbound --workspace <slug> workspaces update --settings '<json>'` (MCP: `manage_workspaces` action `update`, needs `admin`). Updates are deep-merged: objects merge, arrays and values replace, `null` clears a nullable value. Read the effective values with `workspaces get --response-format detailed`.

Country codes are ISO 3166-1 alpha-2 (`DE`, `US`). Weekdays are ISO numbers: 1 is Monday, 7 is Sunday.

<!-- generated:workspace-settings:start -->
| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `company.name` | string | `""` | Your company name: used in writing, reply drafts and the email footer. Campaign launch requires it. |
| `company.website` | string | `""` | Your website: grounds writing and is the only link reply drafts may add besides the booking link |
| `company.postal_address` | string | `""` | Printed in email footers (CAN-SPAM, GDPR) |
| `company.sender_company_line` | string | `""` | Sender line in the email footer, e.g. 'Helix Outbound on behalf of ...' (default: company.name) |
| `schedule.working_days` | list of integer (1-7) | `[1,2,3,4,5]` | ISO weekdays, 1 = Monday |
| `schedule.holidays` | list of date | `[]` | Dates (YYYY-MM-DD) when nothing is sent |
| `schedule.blackout_ranges` | list of object | `[]` | Date ranges `{ from, to }` when nothing is sent |
| `compliance.excluded_countries` | list of country code | `[]` | Never contact people in these countries |
| `compliance.consent_required_countries` | list of country code | `["DE","AT","IT","ES","NL","DK","PL","BE"]` | Countries that require prior consent even for B2B email: cold email is skipped unless person.custom.consent is true |
| `compliance.publication_evidence_countries` | list of country code | `["CA","AU"]` | Cold email only with evidence of where the address was published (person.email_source URL or person.custom.publication_url) or recorded consent |
| `compliance.uk_sole_trader_check` | boolean | `true` | UK (PECR): treat businesses without evidence of a corporate legal form as individuals and skip cold email unless consent is recorded |
| `compliance.ad_disclosure` | object | see below | Footer line identifying the email as an advertisement (CAN-SPAM) for recipients in these countries |
| `compliance.ad_disclosure.countries` | list of country code | `["US"]` | Recipient countries that get the advertisement line |
| `compliance.ad_disclosure.text` | string | `"This is a commercial message."` | The advertisement line |
| `compliance.ai_disclosure` | object | see below | Line added to replies sent automatically without human review (EU AI Act Art. 50) |
| `compliance.ai_disclosure.auto_replies` | `eu` \| `all` \| `off` | `"eu"` | Who gets the AI line on replies sent without review: eu (EU/EEA recipients, and anyone whose country is unknown), all, or off |
| `compliance.ai_disclosure.text` | string | `"This reply was written with AI assistance."` | The AI disclosure line |
| `compliance.retention_days` | integer (min 30) or null | `1095` | Delete prospects with no contact or update for this many days (never customers or people with open opportunities); null keeps data |
| `compliance.include_unsubscribe_link` | boolean | `true` | Unsubscribe line in system and notification email (reports, alerts). Campaign email always carries the unsubscribe line and List-Unsubscribe headers, whatever this says |
| `compliance.include_postal_address` | boolean | `true` | Postal address in system and notification email. Campaign email always prints company.postal_address, and launching an email campaign requires it |
| `compliance.gdpr_source_notice` | boolean | `true` | Adds one line naming the data source for EU contacts |
| `compliance.contact_cap_per_company` | integer (min 1) | `3` | Max active enrollments per company |
| `compliance.rest_days_after_campaign` | integer | `30` | Days a person rests after a campaign ends before another campaign may enroll them |
| `compliance.one_active_campaign_per_person` | boolean | `true` | A person can be in only one active campaign at a time |
| `compliance.privacy_response_days` | integer (1-90) | `30` | Days to answer a privacy request; the deadline is the earlier of this and one calendar month (GDPR) |
| `sending.require_verified_email` | boolean | `true` | Only email people whose address is verified valid |
| `sending.catch_all` | `skip` \| `allow` | `"skip"` | Catch-all addresses: skip them (default) or treat them as valid |
| `sending.tracking.opens` | boolean | `false` | Not implemented yet (no tracking pixels) |
| `sending.tracking.clicks` | boolean | `false` | Not implemented yet (no link rewriting) |
| `sending.reply_delay_minutes` | [integer, integer] | `[3,12]` | Random human-like delay [min, max] before sending a reply |
| `sending.daily_dns_check` | boolean | `true` | Re-check MX, SPF, DKIM and DMARC once a day for the domain of every active or warming mailbox; a record that stops passing (green before, yellow or red now) or turns red opens a dns_failed problem, and mailboxes keep sending |
| `ai.monthly_budget_usd` | number or null | `null` | Monthly AI spend limit in USD; brain calls fail with budget_exceeded once it is used up. Only priced calls count (Anthropic models in the price table, OpenRouter). null = no limit |
| `ai.language` | string | `"en"` | Default language for writing, replies, posts and research briefs (ISO code) |
| `ai.tone_notes` | string | `""` | Free-text tone guidance added to writing, reply and post prompts |
| `ai.task_models` | object | `{}` | Overrides keyed by prompt id or tier name, each { provider?, model?, tier? }, e.g. { "campaign.email.write": { "provider": "anthropic", "model": "claude-opus-5" } } |
| `ai.fallback_provider` | string or null | `null` | Brain provider id used when the main brain fails, or when the agent brain leaves a reply waiting longer than agent_timeout_minutes |
| `ai.agent_timeout_minutes` | integer (5-1440) | `30` | How long the agent brain may leave a reply unsorted (prompt inbox.reply.classify) before the fallback brain sorts it; other tasks keep waiting for the agent |
| `data.monthly_credit_budget` | number or null | `null` | Monthly data credit limit (searches, enrichment, research, signals); spend operations fail with budget_exceeded above it. null = no limit |
| `data.auto_research_min_fit` | integer (0-100) | `70` | New leads with a fit score at or above this get a research brief automatically |
| `data.enrichment.finders` | list of string | `[]` | email_finder provider ids, in order |
| `data.enrichment.verifier` | string or null | `null` | email_verifier provider id |
| `data.enrichment.verify_existing` | boolean | `true` | Verify addresses that leads already have before using them |
| `data.enrichment.pattern_guessing` | boolean | `false` | Guess addresses like first.last@domain and verify them. Off by default: guessed addresses carry extra legal risk |
| `data.enrichment.website_crawler` | boolean | `true` | Look for published addresses on the company website (contact, team, imprint pages) |
| `data.enrichment.crawler_excluded_countries` | list of country code | `[]` | Never crawl websites for addresses of companies in these countries. Empty by default: the crawler records the page that publishes each address, the evidence CA and AU need |
| `approvals.agent_launch_requires_approval` | boolean | `true` | Campaign launches wait for an approval unless a person holding the approve scope launches (agents, services and people without approve ask); false lets everyone launch directly |
| `approvals.default_review_level` | `every` \| `first` \| `unsure` | `"first"` | Review level for new campaigns: every, first or unsure |
| `approvals.expire_days` | integer (1-90) | `7` | Days before a pending approval expires |
| `approvals.agent_changes` | `approve` \| `auto` | `"approve"` | Whether proposed changes wait for an owner's approval when the proposer is not a person holding approve (agents, services, people without approve); auto applies them at once for everyone with the operation's scopes |
| `booking.mode` | `link` \| `handoff` \| `off` | `"link"` | link = replies share the booking link; handoff = a person or the agent books, the engine never proposes or confirms times; off = never offer meetings |
| `booking.default_url` | URL or null | `null` | Booking link used when the offer a reply uses has none (or there is no offer) |
| `booking.tag_links` | boolean | `true` | Add a hidden per-person code to Calendly and Cal.com links so a booking matches the right lead, even from another address |
| `booking.assume_held_after_hours` | integer (0-720) | `24` | Count a meeting as held this many hours after it starts unless it was cancelled or marked no-show; 0 waits for an explicit mark |
| `booking.after_no_show` | `task` \| `draft` \| `nothing` | `"task"` | task = a follow-up task for a person; draft = a short follow-up with the booking link, always reviewed; nothing |
| `booking.after_cancel` | `task` \| `draft` \| `nothing` | `"task"` | What happens after a meeting is cancelled: task, draft or nothing, as for after_no_show |
| `inbox.read_sent_folder` | boolean | `true` | Read each mailbox's Sent folder to confirm sends and to notice replies you write yourself; the engine then steps back from that thread |
| `lead_file.extract_facts` | boolean | `true` | Keep short business facts from replies, with their source, in the lead file |
| `lead_file.extract_promises` | boolean | `true` | Turn promises in sent replies, like sending a case study on Monday, into tasks |
| `lead_file.writer_context` | boolean | `true` | Give the writer a short summary of the lead file when drafting |
| `strategy.goals` | string | `""` | The client's outbound goals in plain words |
| `strategy.qualified_meeting` | string | `""` | What counts as a qualified meeting for this client |
| `strategy.agent_notes` | string | `""` | The owner's standing instructions for any connected agent |
| `crm.mode` | `built_in` \| `agent` \| `off` | `"built_in"` | built_in = the engine syncs through the configured CRM providers; agent = the connected agent syncs any CRM with its own tools, following these preferences; off |
| `crm.sync_from` | `interested` \| `replied` \| `contacted` | `"interested"` | When a person first goes to the CRM |
| `crm.log` | `deals` \| `key_moments` \| `everything` | `"deals"` | What is written: deals only; plus replies and meetings as notes; plus every email sent and received |
| `crm.timing` | `live` \| `daily` | `"live"` | live = sync as things happen; daily = sync once a day |
| `crm.stage_owner` | `engine` \| `crm` | `"engine"` | crm = after a deal exists the engine never overwrites its stage |
| `crm.on_forget` | `task` \| `delete` \| `nothing` | `"task"` | When a person is forgotten: a task to delete them in the CRM, delete them there (built-in providers), or nothing |
| `crm.skip_owned_accounts` | boolean | `false` | Never contact companies the CRM says belong to a sales rep |
| `crm.allow_outreach_with_open_deal` | boolean | `false` | Allow outreach to companies with an open deal in the CRM |
| `crm.notes` | string | `""` | Free instructions for whoever syncs the CRM, for example which list to add people to |
| `sandbox.use_real_brain` | boolean | `false` | Sandbox workspaces only: use your real AI brain instead of the fake one (costs AI budget) |
<!-- generated:workspace-settings:end -->

### Reply rules

`settings.replies.<category>` is `{ "action": ..., "locked": ... }`. Locked rules are enforced whatever is stored: unsubscribes always suppress, privacy requests always suppress the person everywhere and go to a human, bounces always mark the address invalid, negative replies always go to a human. What each action does is explained in [Inbox](../concepts/inbox.md#the-action-matrix).

<!-- generated:reply-rules:start -->
| Category | Default action | Locked |
| --- | --- | --- |
| `interested` | `opportunity_and_draft` | no |
| `meeting_request` | `opportunity_and_draft` | no |
| `question` | `draft_reply` | no |
| `objection` | `draft_reply` | no |
| `not_now` | `stop_and_follow_up` | no |
| `referral` | `approve_referral` | no |
| `wrong_person` | `stop_and_suggest` | no |
| `out_of_office` | `pause_until_return` | no |
| `unsubscribe` | `suppress` | yes |
| `privacy_request` | `privacy` | yes |
| `bounce` | `mark_invalid` | yes |
| `negative` | `notify_human` | yes |
| `auto_reply_other` | `ignore` | no |
| `other` | `human` | no |
<!-- generated:reply-rules:end -->

Example: send answers to simple questions automatically when the checker is confident.

```bash
openoutbound --workspace acme workspaces update --settings '{"replies":{"question":{"action":"auto_reply"}}}'
```

## Campaign settings

Stored per campaign. Pass them to `campaigns create` or `campaigns update` (`--settings '<json>'`, deep-merged like workspace settings). A new campaign takes its review level from `settings.approvals.default_review_level`. Step settings are described in [Campaigns](../concepts/campaigns.md#steps).

<!-- generated:campaign-settings:start -->
| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `review_level` | `every` \| `first` \| `unsure` | `"first"` | When messages wait for approval: every message, the first written message per person, or only when the checker is unsure |
| `schedule.days` | list of integer (1-7) | `[1,2,3,4,5]` | ISO weekdays, 1 = Monday |
| `schedule.start_hour` | integer (0-24) | `8` | Sending window start (hour, 0-24) in the schedule timezone |
| `schedule.end_hour` | integer (0-24) | `17` | Sending window end (hour, 0-24) in the schedule timezone |
| `schedule.timezone_mode` | `lead` \| `fixed` | `"lead"` | lead = send in each lead's timezone; fixed = use `timezone` |
| `schedule.timezone` | string | `"UTC"` | IANA zone; fallback when a lead has none |
| `schedule.start_at` | date-time | none | Do not send before this time (ISO 8601 with offset) |
| `schedule.end_at` | date-time | none | Do not send after this time (ISO 8601 with offset) |
| `daily_new_leads` | integer (0-10000) | `20` | New people started per day (queued enrollments beyond this wait) |
| `senders.mailbox_ids` | list of string | `[]` | Mailboxes this campaign sends from (mbx_...) |
| `senders.linkedin_account_ids` | list of string | `[]` | LinkedIn accounts this campaign acts from (lia_...) |
| `priority` | integer (0-100) | `50` | 0-100; higher-priority campaigns get sender capacity first |
| `writing.language` | string | none | Defaults to the workspace AI language |
| `writing.length` | `short` \| `medium` | `"short"` | Target email length: short or medium |
| `writing.style_notes` | string | `""` | Style guidance for the writer |
| `writing.instructions` | string | `""` | What to say and how: the campaign brief for the writer |
| `writing.rules` | list of string | `[]` | Rules learned from teach/corrections |
| `missing_data` | `skip_step` \| `skip_lead` | `"skip_step"` | When a step cannot run for a person (no email, not connected): skip the step, or stop the person |
| `end_action.type` | `none` \| `tag` \| `list` | `"none"` | What to do when a person finishes the sequence: nothing, add a tag, or add to a list |
| `end_action.value` | string | none | Tag name or list id |
| `stop.on_reply` | boolean | `true` | Stop a person's sequence when they reply |
| `stop.on_company_reply` | boolean | `true` | Stop colleagues at the same company when someone there replies |
| `stop.on_meeting` | boolean | `true` | Stop the sequence when a meeting is booked |
| `tracking.opens` | boolean | `false` | Adds a minimal HTML part only; open tracking is not implemented yet |
| `tracking.clicks` | boolean | `false` | Adds a minimal HTML part only; click tracking is not implemented yet |
| `ab_test.enabled` | boolean | `false` | Split people evenly across the step variants |
| `ab_test.metric` | `positive_reply_rate` \| `reply_rate` \| `meeting_rate` | `"positive_reply_rate"` | The metric the campaign report ranks variants on (leader, confidence, enough_data). End a test with campaigns pick-winner; the engine never picks a winner by itself |
<!-- generated:campaign-settings:end -->

Next: [Workspaces](../concepts/workspaces.md) · [Campaigns](../concepts/campaigns.md) · [Events](events.md) · [CLI reference](cli.md)
