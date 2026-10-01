# How it works

This page explains the three parts of OpenOutbound (the engine, the doors and the providers), how work flows through them, and how background jobs and schedules keep it running.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/how-it-works-dark.png">
  <img alt="How OpenOutbound works: AI agents (MCP server, Agent Skill), apps and scripts (REST API) and people (CLI) drive one engine. Every call passes one safety gate: scopes, limits, approvals, budgets and an audit log. The engine covers leads, research and signals, campaigns, sending, inbox and reports. Plug-ins for the AI brain, mailboxes, lead sources, finders and verifiers, research and signals, LinkedIn and CRM are all optional." src="../../assets/how-it-works-light.png" width="100%">
</picture>

## The short version

- **The engine** holds your data and rules, and runs the outbound loop 24/7. It enforces limits, suppression, approvals and budgets.
- **The doors** let anything drive the engine: AI agents over MCP, scripts over REST, people over the CLI. All doors are generated from one list of operations, so they always match.
- **The providers** connect the engine to outside services: an AI brain, lead databases, email finders and verifiers, research and signal APIs, LinkedIn, CRMs. Every provider is optional and swappable.

The rule behind the design: the engine enforces, agents decide. An agent can plan a campaign, but it cannot send more than a mailbox's daily limit, email a suppressed person or skip an approval, because those checks live in code, not in prompts.

## The outbound loop

| Step | What happens | Module | Read more |
| --- | --- | --- | --- |
| Knowledge | Company facts, offers, proof, voice samples, rules. Every claim about you comes from here. | knowledge | [Research and signals](../guides/research-and-signals.md) |
| ICP | Who you sell to, with a fit score from 0 to 100 and reasons | leads | [Lead sources](../guides/lead-sources.md) |
| Leads | Import your own files, or find people and companies in Apollo or Google Maps | leads | [Lead sources](../guides/lead-sources.md) |
| Enrichment | Find and verify email addresses in a waterfall | enrichment | [Enrichment](../guides/enrichment.md) |
| Research and signals | Sourced briefs per lead; buying signals with evidence URLs, scored and decaying over time | research, signals | [Signals](signals.md) |
| Campaigns | Several campaigns, each with its own steps (email and LinkedIn), schedule, senders and review level | campaigns | [Campaigns](campaigns.md) |
| Writing | Each message is drafted by the AI brain, checked by rules and a checker model, and revised once | campaigns | [Campaigns](campaigns.md#the-writing-pipeline) |
| Approvals | Messages wait for a human when the review level says so | runtime, campaigns | [Safety and approvals](safety-and-approvals.md) |
| Sending | Mailboxes and LinkedIn accounts within daily limits, ramps, gaps and sending windows | email, linkedin | [Mailboxes](../guides/mailboxes.md), [LinkedIn](../guides/linkedin.md) |
| Replies | Synced, classified, and handled by an action per category; a person can take a thread over | inbox | [Inbox](inbox.md) |
| Meetings | Booked through your booking link or by a person, recorded from booking webhooks or by hand, then held, missed or cancelled | inbox | [Meetings](../guides/meetings.md) |
| Lead file | What the engine remembers per person and company: facts with sources, notes, promises, company holds, one history | leads, inbox | [Lead file](lead-file.md) |
| Pipeline | Opportunities from interested replies to meetings, won and lost; CRM sync by the engine or your agent, and facts back from the CRM | inbox | [CRM and notifications](../guides/crm-and-notifications.md) |
| Operating | Where each relationship stands, what goes out next and why something is blocked; problems that need a person or the agent | relationships, problems | [Relationships](relationships.md) |
| Strategy | The client's strategy page, the change log with undo, change proposals and their results, lessons | strategy, knowledge | [Strategy, changes and lessons](strategy.md) |
| Reports | Overview, funnels with A/B leaders, senders, signals, ICP, pipeline with meetings held, costs; on demand or scheduled | reports | [Reports](reports.md) |

## One registry, every door

Every capability is one **operation** with a stable id, such as `campaigns.launch`. An operation declares its input and output schemas, its effect (`read`, `write`, `send`, `spend`, `destructive` or `admin`), whether it supports a dry run, and an optional REST route. The doors are generated from these declarations:

| Door | How the operation appears | Example for `campaigns.enroll` |
| --- | --- | --- |
| MCP | An action of a tool | `enroll_leads` with `{"action":"enroll","campaign_id":"cmp_...","list_id":"ls_..."}` |
| CLI | `openoutbound <group> <verb>` with flags from the input | `openoutbound campaigns enroll --campaign-id cmp_... --list-id ls_... --dry-run` |
| REST | A route under `/v1`, plus `POST /v1/ops/<operation id>` | `POST /v1/campaigns/cmp_.../enroll` |
| OpenAPI | `GET /openapi.json` (OpenAPI 3.1) | generated from the same schemas |
| Reference docs | `pnpm generate:reference` | [CLI](../reference/cli.md), [MCP tools](../reference/mcp-tools.md), [REST API](../reference/rest-api.md) |

Every call from every door passes the same safety gate: scopes, input validation, idempotency, the paused-workspace check, budgets, dry runs and the audit log. See [Safety and approvals](safety-and-approvals.md).

Results have standard shapes:

| Situation | Shape |
| --- | --- |
| A list | `{ items, next_cursor, has_more }`, with `limit` (default 25, max 100) and `cursor` |
| Long work | `{ job_id, status }`; check it with `get_job` or `openoutbound jobs get` |
| Waiting for a human | `{ status: "awaiting_approval", approval_id, summary }` |
| A dry run | `{ dry_run: true, preview, estimated_cost, warnings }` |
| An error | a code, a message and a hint naming the next step |

## Jobs and the worker

Anything slow or recurring runs as a **job** in the database: research, imports, enrichment, sending each email, syncing inboxes, classifying replies, delivering webhooks. The **worker** claims due jobs and runs them.

- The worker runs inside `openoutbound serve` (unless `--no-worker`), `openoutbound worker`, and embedded `openoutbound mcp` sessions. Plain CLI commands do not run jobs: they enqueue them and return a `job_id`.
- It polls every second and runs up to 4 jobs at once per process.
- A job holds a 5-minute lease that is renewed while it runs. If a worker dies, another one picks the job up after the lease expires.
- Failed jobs retry after the wait a provider asked for (`Retry-After`), otherwise with exponential backoff (30 seconds doubling up to 1 hour, with jitter), 5 attempts by default. Errors the engine does not retry (bad input, a missing provider, a budget stop, or a provider error marked not retryable: a rejected key, or a paid call that may already have used credits) fail at once, with the error and its provider failure kept on the job. See [Provider failures](provider-failures.md).
- A job can wait for something (a human decision, an agent task, a capacity slot, a brain to be configured) without using up attempts. Its status is then `waiting`.
- Statuses: `queued`, `running`, `waiting`, `succeeded`, `failed`, `cancelled`. Find failures with `openoutbound jobs list --status failed`.

With Postgres, several workers can run side by side; they never take the same job. With PGlite, one process owns the database, so there is one worker.

## Schedules

Recurring work is driven by cron schedules stored in the database. Built-in schedules run in UTC; per-workspace ones run for every workspace that is not archived (jobs that send check the pause switch themselves).

| Schedule | Cron | Does |
| --- | --- | --- |
| `campaigns.tick` | every minute | Moves enrollments forward: drafts, approvals, sends, waits, conditions |
| `email.sync_mailboxes` | every 5 minutes | Reads new mail over IMAP: replies, bounces, auto-replies, unsubscribes |
| `email.health_check` | hourly at :07 | Checks bounce rates and failures; pauses unhealthy mailboxes |
| `email.dns_daily_check` | daily 06:17 | Re-checks MX, SPF, DKIM and DMARC of every sending domain; opens a `dns_failed` problem when a record stops passing or turns red (never pauses) |
| `email.reconcile_sends` | every 10 minutes | Settles sends with an unknown outcome, emails and LinkedIn actions: looks for them (the Sent folder, the live profile), sends again at most once and only with proof the first did not arrive, or asks a person. Also queues again scheduled emails whose send job was lost |
| `meetings.assume_held` | hourly at :23 | Counts scheduled meetings as held `booking.assume_held_after_hours` after their start |
| `relationships.stuck_check` | every 15 minutes | Opens a `stuck` problem for relationships that stopped moving, and resolves the ones that moved again |
| `linkedin.sync` | every 15 minutes | Accepted invites, LinkedIn replies, stale invites |
| `content.publish_due` | every 5 minutes | Publishes scheduled LinkedIn posts and approved ones a stopped run left behind (10 minutes after approval), and marks a post `unknown` when its publish stopped mid-call 15 minutes ago |
| `signals.monitors_tick` | every 5 minutes | Starts signal monitors that are due |
| `signals.intent_decay` | daily 03:30 | Recomputes company intent scores as signals age |
| `inbox.crm_daily` | daily 02:40 | With `crm.timing: daily`, writes the day's events to the CRM |
| `inbox.privacy_reminders` | daily 08:05 | Reminds you of privacy requests with 7 days or fewer left, and daily once overdue |
| `inbox.lead_file_daily` | daily 04:25 | Expires lead-file facts whose date passed; opens a problem for promises more than a day overdue |
| `strategy.review_proposals` | daily 05:37 | Compares the numbers before and after applied proposals once `review_after_days` have passed |
| `knowledge.archive_expired_lessons` | daily 03:23 | Archives lessons past their expiry |
| `leads.saved_searches_tick` | every 15 minutes | Runs saved searches that are due |
| `leads.retention_sweep` | daily 03:17 | Deletes prospects with no activity for `compliance.retention_days` (default 1095 days); never customers, open deals or people in a sequence |
| `brain.expire_agent_tasks` | hourly at :17 | Expires agent brain tasks nobody answered in time |
| `system.maintenance` | daily 03:17 | Expires old approvals, prunes old events, deliveries, jobs and idempotency records |

Your own schedules live next to these: signal monitors (their own cron) and report schedules. If the engine was down, a missed slot runs once when it comes back, not once per missed slot.

## Events and webhooks

Things that happen (a lead created, a message sent, a reply classified, an approval requested) are stored as **events**. Modules react to events through durable handlers that run as jobs, so a crash never loses one. You can subscribe your own URLs to events with signed webhooks. See the [events reference](../reference/events.md) and [CRM and notifications](../guides/crm-and-notifications.md).

## Where state lives

Everything is in one Postgres database (or PGlite, the same engine embedded in a folder): workspaces, leads, messages, jobs, schedules, events, approvals, the audit log and encrypted secrets. There is no other state except `.env` and, while `serve` runs, `.openoutbound/server.json`. See [Architecture](../architecture.md) for the code map and data model.

Next: [Safety and approvals](safety-and-approvals.md) · [Workspaces](workspaces.md) · [Providers](providers.md) · [Architecture](../architecture.md)
