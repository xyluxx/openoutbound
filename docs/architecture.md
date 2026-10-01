# Architecture

This page is a map of the code for contributors and curious operators: where things live, how a request flows through the safety gate, how jobs run, and what the data model looks like.

OpenOutbound is one TypeScript package (Node 22+, ESM, strict mode). It builds with `tsc` to `dist/`, tests with Vitest, lints with Biome, and stores everything in Postgres through Drizzle (PGlite, an embedded Postgres, for local use).

## Code map

| Path | Holds |
| --- | --- |
| `src/core` | Contracts with little behavior: `defineOperation`, `defineTool`, `defineJob`, the context and engine types, errors, provider failures (`failures.ts`), ids, events, enums, settings schemas, config |
| `src/runtime` | The kernel: executor (the safety gate), registry, API keys, vault, audit, idempotency, approvals, usage and budgets, jobs (queue, runner, worker), scheduler, events and webhooks, notifications, safe fetch, provider resolution and provider health, `createEngine` |
| `src/modules/<name>` | One feature each: `operations`, `service.ts` (functions other modules may call), jobs, prompts, tests, and `index.ts` exporting the `EngineModule` |
| `src/providers/<slot>` | Plug-ins for outside services, one file per provider, plus `types.ts` (every slot interface), `registry.ts` and `http.ts` (requests with timeouts and classified failures) |
| `src/brain` | `definePrompt`, the untrusted-content helpers used by every prompt, and the brain service: model routing, retries, output checks, pricing and the backup brain |
| `src/cli` | The `openoutbound` command: built-ins (`init`, `doctor`, `serve`, `worker`, `mcp`, `db migrate`, `db reencrypt-secrets`, `openapi`, `version`) and one generated command per operation |
| `src/http` | The Hono app: `/v1` routes, `/v1/ops`, `/openapi.json`, `/health`, `/mcp`, auth, problem+json errors, rate limit, lock file |
| `src/mcp` | The MCP server: tools from the registry, toolsets, prompts, server instructions, stdio (embedded and bridge) and HTTP transports |
| `src/db` | Schema files per module group, the client (pg or PGlite) and migrations runner; SQL migrations in `drizzle/` |
| `src/sandbox` | The fake world, sandbox providers and the prospect simulator |
| `src/lib/web` | HTML to text, link, meta and email extraction, domain and LinkedIn URL normalization |
| `src/testing` | Test database, test context, fakes and factories (never used at runtime) |
| `skills/openoutbound` | The Agent Skill and its playbooks |
| `scripts` | `check-text.mjs` (em dash and secret patterns), `check-links.mjs` (docs links), `generate-reference.ts`, `generate-settings-docs.ts` |
| `tests/e2e` | CLI, HTTP and MCP end-to-end tests |
| `tests/providers` | The provider conformance test: every registered provider against timeouts, refusals, error statuses and wrong answers |

## Modules

| Module | Owns |
| --- | --- |
| `workspaces` | Workspaces, settings, pause and resume, the status checklist, setup export and import |
| `keys` | API keys |
| `providers-admin` | Provider catalog and settings per slot |
| `system` | Jobs, approvals, audit log, webhooks, notification channels, the change feed and its consumers |
| `brain` | Agent tasks for the agent brain, and brain tests |
| `knowledge` | Knowledge items, offers, lessons, website bootstrap, ingest, knowledge gaps, grounding packs for prompts |
| `leads` | People, companies, lists, ICPs and fit scores, imports, finding leads, saved searches, suppressions, export, GDPR forget, lead file facts and notes, company holds |
| `enrichment` | Email finder and verifier waterfall, website contact crawler |
| `research` | Research briefs with sourced facts, web search passthrough |
| `signals` | Signal catalog, custom signals, collectors, monitors, scoring, automations, inbound signal webhook |
| `email` | Mailboxes, OAuth, DNS checks (also daily), sending, capacity, IMAP sync, the Sent folder, sends with an unknown outcome, bounces, unsubscribes, health |
| `linkedin` | LinkedIn accounts, safety limits, actions, relations, sync, Unipile webhook |
| `campaigns` | Campaigns, steps, templates, enrollment, the sequencer, the writing pipeline, previews, A/B tests |
| `inbox` | Threads, reply classification, the action matrix, privacy requests, reply drafts, thread takeover, promises, opportunities, meetings and the meeting webhook, tasks, CRM sync, CRM facts and forget handling |
| `content` | LinkedIn posts and publishing |
| `reports` | Reports, report schedules, the attention queue |
| `problems` | Problem records: one item per thing that needs a person or the agent, with the reason and the remedy |
| `relationships` | The relationship view per person (state, next action, blockers), stuck rules, the operating state and next actions |
| `strategy` | The strategy page, the change log with undo, change proposals and the review of their results |
| `sandbox` | Seeding the sandbox and the simulator |

Modules talk to each other in two ways only: by calling functions exported from another module's `service.ts` (for example `checkContactable` from leads, `planEmailSend` from email), or through events. Every module can be left out of `createEngine({ modules })`.

## How a request flows

Take an agent enrolling a list into a campaign over MCP:

1. **Door.** The MCP server receives `enroll_leads` with `{"action":"enroll","campaign_id":"cmp_...","list_id":"ls_..."}`. It maps the action to the operation `campaigns.enroll` and splits off the common fields (`workspace`, `reason`, `dry_run`, `idempotency_key`, `response_format`).
2. **Engine.** `engine.call("campaigns.enroll", input, { principal })` enters the executor.
3. **Gate.** Principal, workspace and access, scopes, input validation, dry-run decision, idempotency lookup, the paused-workspace check for send operations, the data budget for spend operations. Details in [Safety and approvals](concepts/safety-and-approvals.md#the-safety-gate).
4. **Handler.** The operation gets an `OpContext`: the database, the workspace, the principal, and services (provider resolver, brain, jobs, events, audit, approvals, usage, vault, safe fetch, DNS lookups, clock, logger). It calls other modules through their `service.ts` (here `resolvePeople` and `checkContactable` from leads).
5. **Output.** The result is parsed against the output schema (unknown fields are dropped, dates become ISO strings), audited, stored for the idempotency key, and returned.
6. **Door again.** MCP returns `structuredContent` plus a compact Markdown rendering (capped, with a hint to narrow the query; tables keep the ids, severity, remedies, fixes and errors an agent acts on, and a page always shows its `next_cursor`); REST returns JSON (202 for job handles and approvals, RFC 9457 problem+json for errors); the CLI prints a table or `--json`.

The CLI and REST follow the same path with their own first and last steps. In bridge mode, `openoutbound mcp` and the CLI forward calls to a server with `POST /v1/ops/{operation_id}`, so the server runs the gate.

## Jobs, schedules and events

- **Jobs** are rows in the `jobs` table. `ctx.jobs.enqueue(name, payload, { runAt, singletonKey, priority })` adds one; a singleton key prevents duplicates while one is queued, running or waiting.
- **The worker** claims due jobs with `FOR UPDATE SKIP LOCKED`, holds a renewable lease, runs the handler with a `JobContext` (the system principal plus job info), retries what can be retried (one rule, `isRetryable` in `core/failures.ts`) after the provider's wait or with backoff, and parks jobs that throw `JobWaitError` as `waiting` until they are woken or a time passes.
- **Schedules** are cron rows. Modules register built-in ones (instance-wide or per workspace); users create others (monitors, report schedules). The scheduler fires each due slot once, even with several workers.
- **Events** are rows in `events`. `ctx.events.emit(type, { subject, data })` stores the event, enqueues one job per in-process handler (so handlers are durable and retried), and enqueues deliveries for subscribed webhooks.

## Data model

Every table has a text primary key made by `newId(prefix)`: the prefix, an underscore and 26 lowercase Crockford base32 characters that sort by creation time (for example `cmp_01k6a3v0q8x3m2n4p5r6s7t8v9`). Workspace-scoped tables carry `workspace_id` with cascade delete.

| Group | Tables |
| --- | --- |
| Core | `workspaces` (ws), `api_keys` (key), `secrets` (sec), `provider_settings` (prv), `audit_events` (aud), `idempotency_records`, `approvals` (apr), `jobs` (job), `schedules` (sch), `events` (evt), `webhook_endpoints` (whk), `webhook_deliveries` (whd), `usage_records` (use), `agent_tasks` (tsk), `automation_rules` (rul), `notification_channels` (ntf), `reports` (rpt) |
| Knowledge | `knowledge_items` (kn), `offers` (off), `knowledge_gaps` (gap) |
| Leads | `companies` (co), `people` (pe), `lists` (ls), `list_members`, `icps` (icp), `imports` (imp), `suppressions` (sup), `saved_searches` (ss), `lead_facts` (lf) |
| Research and signals | `research_briefs` (rb), `page_snapshots` (snap), `signal_definitions` (sd), `signals` (sig), `monitors` (mon), `automation_firings`, `signal_webhook_tokens` |
| Channels | `mailboxes` (mbx), `linkedin_accounts` (lia), `linkedin_relations`, `sender_counters`, `social_accounts` |
| Campaigns | `campaigns` (cmp), `campaign_steps` (stp), `enrollments` (enr), `enrollment_step_runs`, `templates` (tpl), `posts` (pst) |
| Inbox | `threads` (thr), `messages` (msg), `opportunities` (opp), `tasks` (tk), `crm_links`, `crm_webhooks` (cwh), `meeting_webhooks`, `meetings` (mt) |
| Control | `problems` (pb), `change_log` (chg), `change_proposals` (prop), `event_consumers` |

A few relationships carry most of the logic:

- A **person** belongs to at most one **company**. Unique per workspace: company domain, person email, person LinkedIn URL.
- An **enrollment** is one person in one campaign; it points at the current step and the sender chosen for the person.
- A **message** is every email or LinkedIn action, outbound or inbound, from draft to sent or received. Messages group into **threads**; inbound messages carry their classification.
- **Signals** attach to companies (and sometimes people) and feed the company's `intent_score`.
- **Suppressions** block an email, domain, LinkedIn profile, person or company, and survive when a person is deleted.
- **Lead facts** are short business facts about a person or a whole company (from replies, people, agents or a CRM); only active ones reach the writer.
- A **problem** is one thing that needs a person or the agent, with a plain reason and the exact remedy; a dedupe key keeps one open problem per cause.

Settings are JSON columns validated by zod schemas in `src/core/settings.ts`, always read through the parse helpers so defaults fill in. See the [configuration reference](reference/configuration.md).

## Extending

- A new outside service: [Write a provider](extending/write-a-provider.md).
- A new capability: [Custom modules](extending/custom-modules.md).
- Rules for contributors: [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).

Next: [How it works](concepts/how-it-works.md) · [Write a provider](extending/write-a-provider.md) · [Custom modules](extending/custom-modules.md)
