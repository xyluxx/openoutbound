# FAQ

This page answers the questions people ask most before and while running OpenOutbound, with links to the full explanations.

## Is LinkedIn automation allowed?

No. LinkedIn's User Agreement (section 8.2) does not allow automated activity or scraping, and any automation, this one included, can get an account restricted.

OpenOutbound lowers the risk but cannot remove it:

- Connecting an account requires `accept_risk: true`: the account owner accepts the risk in writing.
- Actions run in the owner's own account through Unipile, with conservative daily limits, working hours, random gaps and a ramp for new accounts. OpenOutbound never asks for or stores a LinkedIn password.
- Posting through LinkedIn's official API is allowed and does not need Unipile.

If the risk is not acceptable, run email-only campaigns and use `task` steps to remind a person to act on LinkedIn by hand. See [LinkedIn](guides/linkedin.md#read-this-first).

## Does it warm up mailboxes?

No. Warmup needs a shared network of inboxes that exchange mail, which an engine you run yourself does not have. Use a warmup service, or buy mailboxes that are already warmed up.

What the engine does instead:

- New mailboxes ramp up: no cold email for two weeks, then 5 a day, plus 5 a week, up to the daily limit (30 from week 8). Pre-warmed mailboxes (`--warmed-up`) start at 15 a day.
- Mail from common warmup tools is recognized and dropped during sync, so it never reaches the inbox or the reports.
- Bounce rates are watched: over 7 days (and at least 20 sends), a mailbox is flagged at 2% and paused above 3%.

See [Mailboxes](guides/mailboxes.md#warmup-is-external).

## Which AI brain should I pick?

| Your situation | Pick |
| --- | --- |
| You want it to just work | `anthropic` with `ANTHROPIC_API_KEY`: models are preset and costs are tracked exactly |
| You want many models on one bill | `openrouter` with `OPENROUTER_API_KEY` (Claude models by default; any OpenRouter model id in config) |
| Your team already uses OpenAI or Google | `openai` or `gemini` with the key; models are preset (costs count as $0 in budgets) |
| Prospect data must stay on your network | `openai_compatible` with the `ollama` or `lmstudio` preset. Quality depends on the model you run |
| You are trying it alone with your own subscription | `claude_cli` or `codex_cli`: personal use, one call at a time |
| You have no model keys at all | `agent`: the connected agent does the AI work. Slow, and the agent must be running; a backup brain (`ai.fallback_provider`) sorts replies when it is not |

Sandbox workspaces use a fake brain automatically. You can give different tasks different models with `ai.task_models`. See [AI brain](guides/ai-brain.md).

## What does it cost?

The software is free and open source (Apache-2.0). You pay for the services you plug in:

| Item | What you pay for | Details |
| --- | --- | --- |
| Mailboxes | Seats with Google Workspace or Microsoft 365, or ready mailboxes from a vendor | [Mailboxes](guides/mailboxes.md#where-to-get-mailboxes) |
| AI brain | Tokens. The launch checklist estimates $0.012 per lead for each AI-written step | [AI brain](guides/ai-brain.md#costs-and-budgets) |
| Email finding and verification | Credits per address found or checked | [Enrichment](guides/enrichment.md#finders-and-verifiers) |
| Lead data | Apollo credits, Google Maps requests | [Lead sources](guides/lead-sources.md) |
| Research and signals | Credits per search or call | [Research and signals](guides/research-and-signals.md) |
| LinkedIn | A Unipile account | [LinkedIn](guides/linkedin.md#set-up-unipile) |
| Hosting | Your computer, or a small server with Postgres | [Deploy](guides/deploy.md) |

Two monthly budgets per workspace stop spending when reached: `settings.ai.monthly_budget_usd` and `settings.data.monthly_credit_budget`. The costs report shows where the money went. See [Safety and approvals](concepts/safety-and-approvals.md#budgets).

## Is it GDPR compliant?

OpenOutbound gives you the tools; whether your outreach is lawful depends on what you send, to whom, and on what basis. This is not legal advice.

Built in, and on by default:

- No cold email to people in countries that require consent (DE, AT, IT, ES, NL, DK, PL, BE by default) unless the person is marked as having consented.
- A notice to EU, EEA and UK recipients saying where their data came from, the legal basis and how to object.
- An unsubscribe link and header in every campaign email, and your postal address in the footer.
- A retention sweep that deletes untouched prospects after 1,095 days.
- Privacy requests in replies ("delete my data", "where did you get my email") stop everything at once and open an urgent problem with the deadline, where the data came from and a suggested answer.
- `leads forget` for erasure requests: it deletes the person, erases their address in stored events and logs, and keeps only hashes, so they are never contacted again.

Known gaps: `forget` erases only exact copies of the email address and LinkedIn URL, so names stay in the audit log and in events until they age out (90 days), and data already delivered to webhooks stays there. See [Security](guides/security.md#data-protection-and-gdpr).

## Can it run without any paid service?

Yes, with limits.

| Works without paying anyone | Needs a paid or separate service |
| --- | --- |
| The sandbox: everything, simulated | Apollo and Google Maps searches |
| Importing your own CSV, XLSX or JSON files | Email finders and verifiers |
| Finding addresses published on company websites | Web search for research briefs |
| Sending from mailboxes you already have (SMTP and IMAP) | PredictLeads and Crustdata signals |
| A local model through Ollama or LM Studio, or the agent brain | LinkedIn actions (Unipile) |
| Free signal collectors: website changes, job boards, GDELT news, RSS, technology detection | Hosted AI models |
| Research briefs from the company's own website, reports, the inbox | |

One catch: by default the engine only emails addresses verified as `valid`. Without a verifier, import files with an `email_status` column (`valid`, `verified`, `deliverable`, `ok` and `safe` count as valid). Addresses found on websites stay `unknown` and are not emailed. You can turn off `sending.require_verified_email`, but expect more bounces. See [Enrichment](guides/enrichment.md#settings).

## "Your agent's OpenOutbound session has the local database open"

The local database (PGlite) allows one process at a time. The first process locks `.openoutbound/pglite.lock`, and any other process stops with a `conflict` error that names it:

```text
Error (conflict): Your agent's OpenOutbound session (pid 18180, started with "mcp --workspace northwind") has the local database open, and the embedded database allows one process at a time.
```

Usually an agent session started `openoutbound mcp` before `openoutbound serve` ran, and you then ran a CLI command or `serve`. The message names another command or a silent server when that is what holds the database. Fix it one of these ways:

- Close the agent session, run `openoutbound serve` in its own terminal, then start the agent again. The CLI and `openoutbound mcp` then send their calls to it, so any number of them can run. [The first hour](getting-started/first-hour.md) starts `serve` first for this reason.
- Stop the other process.
- Use Postgres (`DATABASE_URL`), which has no such limit.

A lock left by a process that has exited is taken over on the next start. If no such process runs (its id may now belong to another program), delete the lock file named in the hint. See [Install](getting-started/install.md#one-process-at-a-time-on-pglite).

## `serve` says the port is taken

`openoutbound serve` stops with `conflict` when another program holds its port (7331 by default). On Windows the system can also reserve ports; `netsh interface ipv4 show excludedportrange protocol=tcp` lists the reserved ranges.

Pick another port with `openoutbound serve --port 7171` (or `PORT` in `.env`). Then:

- Change `OPENOUTBOUND_BASE_URL` in `.env` if it names the old port: unsubscribe links and OAuth callbacks use it.
- Point agents that connect over HTTP at the new address, for example `OPENOUTBOUND_URL=http://127.0.0.1:7171`. The CLI and `openoutbound mcp` find the running server by themselves.

## Can one engine serve several clients?

Yes. Each client gets a workspace with its own leads, mailboxes, campaigns, settings, budgets and provider keys, and a key bound to one workspace can never see another. What the engine learns (lessons, lead files, the strategy page) stays with its client too. To start a new client from a setup that works, copy it with `workspaces export-setup` and `import-setup`. See [Workspaces](concepts/workspaces.md).

## Does it book meetings?

It never books calendars and never confirms a time. Replies offer your booking link, and a booking webhook from Calendly, Cal.com or another tool records the meeting, stops the lead's sequences and tells your CRM, as your `crm` settings say. When a prospect proposes a time, the engine opens a "Book a meeting" problem: a person or your agent checks a real calendar, books the slot, then records the meeting. See [Meetings](guides/meetings.md).

## What if I answer a lead myself?

The engine steps back. When you reply from the mailbox itself, the sync finds your email in the Sent folder, cancels the engine's unsent messages in that thread, stops the lead's sequences and writes nothing there until you hand the thread back. See [Inbox](concepts/inbox.md#taking-a-thread-over).

## Will an agent send email without asking me?

Only as far as you allow. Each campaign has a review level: `every` message, only the `first` message to each person (the default), or only messages the checker is `unsure` about. A message that fails its checks always goes to review, and when an agent launches a campaign, the launch waits for a human by default.

Agent API keys and the embedded local agent do not have the `approve` scope by default, and the engine refuses an approval decided by the agent that requested it, even when you give it `approve`. See [Safety and approvals](concepts/safety-and-approvals.md).

## Does it track opens and clicks?

No. Emails are plain text by default, with no tracking pixels or rewritten links. Judge campaigns by replies, positive replies and meetings. See [Reports](concepts/reports.md).

Next: [The first hour](getting-started/first-hour.md) · [Roadmap](roadmap.md) · [Security](guides/security.md)
