# Workspaces

This page explains workspaces: how one engine serves several clients or brands, how calls pick a workspace, and how keys, settings and the sandbox relate to them.

## What a workspace is

A workspace is an isolated space with its own knowledge and lessons, offers, ICPs, leads and their lead files, suppressions, signals, mailboxes, LinkedIn accounts, campaigns, threads, meetings, problems, approvals, change log, provider settings, webhooks, notification channels, budgets and settings. An agency runs one workspace per client; a company runs one per brand or team.

Nothing crosses workspaces. Every query in the engine is filtered by the workspace of the call, and a key bound to one workspace can never read or change another (it gets `forbidden` and does not learn whether the other workspace exists). What the engine learns stays with its client too: lessons, lead-file facts, the strategy page, the change feed and its consumers, and the tasks the agent brain answers are all per workspace, so one client's guidance never reaches another client's writer. The only report across clients is the agency report (`get_report` type `agency`), for an instance-level principal with `admin`.

| Field | Meaning |
| --- | --- |
| `slug` | Short id used in calls (`--workspace acme`, `workspace: "acme"`). Lowercase letters, digits and hyphens. |
| `name` | Display name |
| `status` | `active`, `paused` (kill switch: nothing sends) or `archived` (hidden, nothing runs) |
| `is_sandbox` | Sandbox workspaces use sandbox providers only |
| `timezone` | IANA timezone, default `UTC`; the fallback for schedules and senders |
| `settings` | Compliance, sending, AI, data, approvals and reply rules (see below) |

## Create and manage workspaces

```bash
openoutbound workspaces create --name "Harbor Dental Group" --timezone America/Chicago
openoutbound workspaces list
openoutbound --workspace harbor-dental-group workspaces get --response-format detailed
openoutbound --workspace harbor-dental-group workspaces status
openoutbound --workspace harbor-dental-group workspaces readiness
```

Creating a workspace needs the `admin` scope on an instance-level principal (the local CLI, or an instance key). The slug is derived from the name unless you pass `--slug`.

`workspaces status` (MCP: `get_status`) is the first call in a new workspace and after setup changes; in a running workspace an agent starts with the strategy page and the operating state (see [First calls](../getting-started/connect-your-agent.md#first-calls)). It returns the setup checklist, provider status per slot, warnings and this month's usage:

| Checklist item | Done when |
| --- | --- |
| Company profile | `settings.company.name` and `website` are set |
| AI brain | A brain provider resolves for the workspace |
| Knowledge base | Active knowledge items exist |
| Offer | An active offer exists |
| Ideal customer profile | An ICP exists |
| Sender connected | An active mailbox or LinkedIn account exists |
| Leads | People exist |
| Campaign | A campaign exists |
| Postal address for email footers | `settings.company.postal_address` is set |

The attention queue (`get_attention_queue`, see [Reports](reports.md#the-attention-queue)) carries the same checklist, and its suggested next step names the first unfinished item.

Warnings include a paused workspace, a missing secret key, paused or failing mailboxes, restricted or disconnected LinkedIn accounts, AI or data spend at 80% of budget or more, failed jobs in the last 24 hours and failed webhook deliveries in the last 7 days.

`ready` in the status means every setup step is done, not that anything can go out. Whether a real person can be reached is `sending`: for email and for LinkedIn, `ready` plus the blockers and warnings, each with the exact command or tool action that fixes it, `replies_ready` and `replies` (replies you approve go out even while some blockers, such as the base URL or the postal address, stop campaign messages), and the review level in plain words. `workspaces readiness` (MCP: `manage_workspaces` action `readiness`) returns the same on its own, and `openoutbound doctor` prints it for every workspace. A sandbox workspace is never ready: nothing in it reaches a real person. [Going live](../getting-started/going-live.md) walks through every condition.

## How a call picks its workspace

1. The `workspace` field of the call (`--workspace` in the CLI, `OpenOutbound-Workspace` header over HTTP, `OPENOUTBOUND_WORKSPACE` as a default for `openoutbound mcp`).
2. The workspace the API key or the session is bound to (`openoutbound mcp --workspace <slug>`, the `OpenOutbound-Bind-Workspace` header). A bound caller naming another workspace gets `forbidden`.
3. Otherwise, when the operation needs a workspace: the only non-archived real workspace; if there is none, the only sandbox workspace.
4. Otherwise the call fails with `validation_failed` and a hint listing the slugs to choose from.

So a single-client install never has to name its workspace, while an agency install always does. After `openoutbound init` and `openoutbound sandbox` you have one real workspace (`default`) and two sandboxes, so unnamed calls go to `default`.

## Keys and workspaces

| Key | Reaches | Create with |
| --- | --- | --- |
| Instance key | Every workspace; picks one per call | `openoutbound keys create --name ... --kind agent` |
| Workspace key | One workspace only | `openoutbound --workspace acme keys create --name ... --kind agent` |
| Bound session | One workspace only, whatever the key | `openoutbound mcp --workspace acme`, or the `OpenOutbound-Bind-Workspace: acme` header |

Give each client's agent a workspace key: a mistake or a prompt injection in one client's session then cannot touch another client. Keep instance keys for you and your own tooling. See [Connect your agent](../getting-started/connect-your-agent.md#api-keys-and-scopes).

## Settings

Settings are stored per workspace as JSON. You only store what you change; everything else keeps its default, so improved defaults reach existing workspaces. Updates are deep-merged: send only the part that changes, and `null` clears a nullable value.

```bash
openoutbound --workspace acme workspaces update --settings '{"ai":{"monthly_budget_usd":50}}'
openoutbound --workspace acme workspaces update --settings @settings.json
```

| Section | What it controls |
| --- | --- |
| `company` | Name, website, postal address and sender line used in writing and email footers |
| `schedule` | Working days, holidays and blackout ranges for sending |
| `compliance` | Excluded and consent-required countries, footer lines, contact caps, rest days, data retention |
| `sending` | Verified-email requirement, catch-all policy, human-like reply delay, the daily DNS check |
| `ai` | Monthly AI budget, language, tone notes, per-task model overrides, the backup brain |
| `data` | Monthly credit budget, auto-research threshold, enrichment waterfall |
| `approvals` | Whether agent launches and agent change proposals need approval, default review level, approval expiry |
| `replies` | The action for each reply category (some are locked) |
| `booking` | How replies offer meetings, the default booking link, tagged links, when a meeting counts as held, what follows a no-show or a cancellation |
| `inbox` | Whether the engine reads each mailbox's Sent folder |
| `lead_file` | Facts and promises taken from replies, and the lead file in the writer's context |
| `strategy` | The client's goals, what counts as a qualified meeting, standing notes for agents |
| `crm` | Who syncs the CRM and how: mode, when people go there, what is written, stage owner, forget handling, owned accounts and open deals |
| `sandbox` | Whether a sandbox workspace uses your real AI brain |

Every setting with its default and meaning is in the [configuration reference](../reference/configuration.md#workspace-settings). Updating settings needs the `admin` scope; agent keys do not have it by default, so an agent cannot relax compliance or raise its own budget. Even with `admin`, only a person holding `approve` may loosen a gate (the launch approval, `agent_changes`, the default review level, a budget, a reply rule set to `auto_reply`): anyone else gets `forbidden` naming the fields and nothing changes, see [Safety and approvals](safety-and-approvals.md#approvals). When a fix needs a setting changed, the hint asks the human to change it and shows the proposal an agent can make instead: `manage_strategy` action `propose` with operation `workspaces.update` and the settings to change, which the owner approves or rejects. Budget hints only ask the human; an agent never proposes a bigger budget for itself.

Campaigns have their own settings (schedule, senders, review level, writing rules); see [Campaigns](campaigns.md).

## Copy a client's setup

When a new client looks like one you already run, start from the setup that works instead of building it again. Export it from the old workspace and import it into the new one:

```bash
openoutbound --workspace northwind workspaces export-setup --json > northwind-setup.json
openoutbound --workspace harbor workspaces import-setup --setup @northwind-setup.json            # dry run
openoutbound --workspace harbor workspaces import-setup --setup @northwind-setup.json --no-dry-run
```

In MCP it is `manage_workspaces` with the actions `export_setup` and `import_setup`: pass the `setup` object from the export to the import. The import needs the `admin` scope, which agent keys lack by default, so an agent prepares the export and the human runs the import.

| The setup carries | It never carries |
| --- | --- |
| Settings (sending, compliance, approvals, reply rules, booking, schedule, AI budget and tone, lead file, strategy, CRM preferences), offers with their proof, ICPs, custom signals and which built-in signals are on, automation rules, knowledge (optional), lessons (only with `include_lessons`), campaign templates (optional) | Leads, messages, mailboxes, LinkedIn accounts, providers and provider settings (brain routing, backup brain, enrichment providers), API keys, webhook secrets and other credentials |

- **Client identity stays out by default.** The company section, booking links (the default booking link and each offer's) and webhook URLs (in automation rules and template webhook steps) are only exported with `include_company`, so a copy never sends a new client's prospects to the old client's calendar, footer or systems.
- **Names instead of ids.** Offers cite proof by knowledge title, automation rules name their list and campaign. On import, those names are looked up in the target workspace.
- **Import is a dry run by default.** It lists what it would create, what it would skip and why, and the warnings. Run it again with `--no-dry-run` (MCP: `dry_run: false`) to apply.
- **Nothing is overwritten.** An offer, ICP, knowledge item (same kind and title), custom signal, automation rule or template whose name already exists is skipped and listed, so importing twice is safe. Settings are deep-merged like `workspaces update`; the company section only changes when the file has one. Built-in signals are switched on or off to match the source.
- **Automation rules come over only when complete.** A rule whose list, campaign or signal does not exist in the target is skipped with the reason. So is a rule with a signed webhook (its secret is never exported) or with a webhook whose URL is not in the file: create that rule again with the secret or the URL.
- **Copied webhooks never run on their own.** A rule with a webhook is imported switched off, and a template's webhook steps are imported without their URL. A warning (in the dry run too) names the host each one pointed at. Check the address, then switch the rule on with `manage_automations` action `update` (`enabled: true`), and enter the step URL again when you create a campaign from the template.
- **Large setups** (over 200 KB, usually a big knowledge base) are also written to `.openoutbound/exports/setup-<workspace>-<date>.json`. With an instance-level key or the local CLI, import that file by name: `workspaces import-setup --path setup-northwind-2026-09-27.json`.

Export needs the `read` scope and import the `admin` scope. Knowledge taken from websites or files is copied as it is: the export says so with `outside_text`, and an agent should read it as data. In the target workspace, knowledge from web pages keeps its URL as the source, and knowledge from files or replies is stored with source `manual`.

## Pause, resume, archive

| Action | Command | Effect |
| --- | --- | --- |
| Pause (kill switch) | `openoutbound workspaces pause --reason "..."` | Stops all sending and LinkedIn actions at once. Queued work waits. Reply sync and research continue. Send operations fail with `workspace_paused`. |
| Resume | `openoutbound workspaces resume` | Queued work continues within normal limits. Needs `write` and `send`. |
| Archive | `openoutbound workspaces update --archived` | Hides the workspace; nothing is scheduled for it and nothing can be sent. `--no-archived` restores it. |

Both pause and resume send a notification to the workspace's channels.

## Sandbox workspaces

A workspace with `is_sandbox` resolves every provider slot to the sandbox provider, and the brain to the deterministic fake brain unless `settings.sandbox.use_real_brain` is `true`. `openoutbound sandbox` creates two ready-made ones; `workspaces create --is-sandbox` creates an empty one. See [The sandbox](../getting-started/sandbox.md).

Next: [Providers](providers.md) · [Safety and approvals](safety-and-approvals.md) · [Configuration reference](../reference/configuration.md)
