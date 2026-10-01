# OpenOutbound documentation

This is the map of the OpenOutbound docs: every page, with one line on what it covers.

New here? Start with [The first hour](getting-started/first-hour.md): the sandbox needs no accounts or keys, and nothing in it reaches a real person.

## Getting started

| Page | What it covers |
| --- | --- |
| [The first hour](getting-started/first-hour.md) | From a fresh clone to an agent working in the sandbox: init, the sandbox, `serve` first, connecting the agent, approving what it proposes, what would have been sent, and when a real send happens |
| [Going live](getting-started/going-live.md) | Every condition for a real send, in the order you meet them, each with the command that shows it, and the readiness check |
| [Quickstart](getting-started/quickstart.md) | Now a pointer to The first hour |
| [Install](getting-started/install.md) | Running from source or with Docker and Postgres, where data lives, updates, backups, and the one-process PGlite lock |
| [Connect your agent](getting-started/connect-your-agent.md) | Claude Code, Claude Desktop, Codex, Cursor, VS Code or any MCP client; the first calls in a session; the change feed; API keys and scopes; the Agent Skill and plugin |
| [Sandbox](getting-started/sandbox.md) | The fake world: what it contains, what it simulates (replies, bookings, a privacy request), how to reset it and move to real data |

## Concepts

| Page | What it covers |
| --- | --- |
| [How it works](concepts/how-it-works.md) | The engine, the doors (MCP, CLI, REST) and the providers, and how jobs and schedules keep it running |
| [Safety and approvals](concepts/safety-and-approvals.md) | The safety gate, scopes, approvals and change approvals, review levels, dry runs, budgets, the kill switch, the checks before each send, never sending twice and the audit log |
| [Delivery guarantees](concepts/delivery-guarantees.md) | The rule that every outbound action is handed over at most once per attempt: what happens at each boundary when an answer is unclear, how duplicates are recorded, what is done at least once by design, and the test behind each case |
| [Workspaces](concepts/workspaces.md) | One engine for several clients or brands: client separation, keys, settings, copying a client's setup and the sandbox |
| [Providers](concepts/providers.md) | Slots for outside services, how the engine picks a provider, and how to configure one |
| [Provider failures](concepts/provider-failures.md) | The failure classes, retries, writes with an unknown outcome, paused providers and where failures show |
| [Campaigns](concepts/campaigns.md) | Steps, enrollment, the writing pipeline, review, launch checks, the sequencer and what stops a sequence |
| [Signals](concepts/signals.md) | The signal catalog, scoring and decay, collectors, monitors and automations |
| [Inbox](concepts/inbox.md) | Reply classification, the action matrix, privacy requests, reply drafts, threads a person took over, opportunities, booking modes, proposed times and tasks |
| [Lead file](concepts/lead-file.md) | What the engine remembers about each lead and company: facts, notes, promises and the full history, how the writer uses them, and company holds |
| [Reports](concepts/reports.md) | Report types, metric definitions (meetings held, A/B leaders), scheduled reports and the attention queue |
| [Strategy, changes and lessons](concepts/strategy.md) | The strategy page agents read first, the change log with undo, proposals with approvals and results, and lessons |
| [Relationships](concepts/relationships.md) | Where each person stands, the next action, blockers and their fixes, stuck rules, problems and the operator tools |

## Guides

| Page | What it covers |
| --- | --- |
| [AI brain](guides/ai-brain.md) | Choosing and setting up the model: every brain provider, tiers, per-task models, the backup brain, costs and budgets |
| [Mailboxes](guides/mailboxes.md) | Connecting Google Workspace, Microsoft 365, Zoho or any SMTP/IMAP mailbox; DNS and the daily DNS check; limits, ramps, health, reply sync, the Sent folder and sends with an unknown outcome |
| [LinkedIn](guides/linkedin.md) | LinkedIn accounts through Unipile, the risks and limits, restrictions, and posting with the official API |
| [Meetings](guides/meetings.md) | Booking settings, connecting Calendly, Cal.com or any booking tool, tagged links, recording meetings by hand, no-shows, cancellations and qualified meetings |
| [Lead sources](guides/lead-sources.md) | Importing files, Apollo, Google Maps, saved searches, ICP scores, lists, suppressions and exports |
| [Enrichment](guides/enrichment.md) | Finding and verifying email addresses: the waterfall, finders, verifiers, catch-all domains and the website crawler |
| [Research and signals](guides/research-and-signals.md) | Research briefs and signal providers, what they cost, what works for free, and pushing your own signals |
| [Custom signals](guides/custom-signals.md) | Writing your own buying signal in plain English, with examples |
| [CRM and notifications](guides/crm-and-notifications.md) | HubSpot, Pipedrive, your own endpoint or an agent syncing any CRM, CRM facts back, Slack and email notifications, and signed webhooks |
| [Deploy](guides/deploy.md) | Running on a server: Docker compose, Postgres, HTTPS, the base URL, backups, upgrades and more workers |
| [Security](guides/security.md) | Keys and scopes, the secret key, network protections, incoming webhooks, prompt injection, retention, privacy requests and forget |

## Reference

| Page | What it covers |
| --- | --- |
| [MCP tools](reference/mcp-tools.md) | Every MCP tool by toolset, with actions and fields (generated) |
| [CLI](reference/cli.md) | Every command and flag (generated) |
| [REST API](reference/rest-api.md) | Every route (generated); the schema is in [openapi.json](reference/openapi.json) |
| [Configuration](reference/configuration.md) | Every environment variable, workspace setting and campaign setting, with defaults |
| [Events](reference/events.md) | Every event with its payload fields, for webhooks and automations |

## Extending

| Page | What it covers |
| --- | --- |
| [Write a provider](extending/write-a-provider.md) | Connect a new outside service: a complete example provider, registration and tests with fixtures |
| [Custom modules](extending/custom-modules.md) | Add a capability: operations, an MCP tool, a job and an approval, with a test |

## More

| Page | What it covers |
| --- | --- |
| [Architecture](architecture.md) | The code map, how a request flows through the gate, jobs and events, and the data model |
| [FAQ](faq.md) | LinkedIn rules, warmup, which brain, costs, GDPR, running for free, and the database lock error |
| [Roadmap](roadmap.md) | What the engine does not do yet, what it does instead, and what is not planned |

The Agent Skill that teaches agents to use OpenOutbound, with its playbooks, is in [skills/openoutbound](../skills/openoutbound/SKILL.md).

Next: [The first hour](getting-started/first-hour.md) · [How it works](concepts/how-it-works.md) · [Connect your agent](getting-started/connect-your-agent.md)
