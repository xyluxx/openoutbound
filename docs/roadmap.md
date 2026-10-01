# Roadmap

This page lists what OpenOutbound does not do yet and what it does instead, so you can plan around the gaps, and what is not planned. Nothing here has a promised date.

## Planned

These were left out on purpose, in the design.

| Area | Not in the engine yet | What it does instead |
| --- | --- | --- |
| Agents | OAuth sign-in for remote connectors in claude.ai or ChatGPT on the web | Remote MCP over HTTP with an API key in a header ([Connect your agent](getting-started/connect-your-agent.md)) |
| Approvals | Approval cards inside MCP clients, and Slack buttons | Decide with the CLI, MCP tools or REST; Slack gets notifications through an incoming webhook ([Safety and approvals](concepts/safety-and-approvals.md#approvals)) |
| LinkedIn | Other LinkedIn providers, such as Linked API | Unipile for actions; the official LinkedIn API or Unipile for posts ([LinkedIn](guides/linkedin.md)) |
| Sending | Handing sending to tools such as Instantly or lemlist | Sends through your own mailboxes over SMTP ([Mailboxes](guides/mailboxes.md)) |
| AI brain | Gemini's native SDK, and providers' discounted batch APIs | Gemini through Google's OpenAI-compatible endpoint; every brain call is a regular request ([AI brain](guides/ai-brain.md)) |
| Signals | Learning signal weights automatically | The signals report shows the lift of each signal and suggests a weight; you decide ([Reports](concepts/reports.md#metric-definitions)) |

## Not planned now

These are out of scope for now. Each has a way to get the result today.

| Not planned | What to use instead |
| --- | --- |
| Calendar free/busy and slot negotiation inside the engine | Replies offer your booking link and your booking tool handles the calendar; for other times a person or your agent checks a real calendar, books, then records the meeting ([Meetings](guides/meetings.md)) |
| A connector for every CRM | HubSpot, Pipedrive and your own endpoint are built in; any other CRM is synced by your agent with its own tools (`crm.mode: agent`) ([CRM and notifications](guides/crm-and-notifications.md)) |
| Custom data models | Custom fields (`custom`) and tags on people and companies, and lists ([Lead sources](guides/lead-sources.md)) |
| An extension marketplace | Write a provider or a module and register it as a built-in ([Write a provider](extending/write-a-provider.md), [Custom modules](extending/custom-modules.md)) |
| The web panel | Agents, the CLI and the REST API |
| An AI operator inside the engine | Your own agent runs the day over MCP: the operating state, next actions, problems and change proposals ([Relationships](concepts/relationships.md#the-operator-tools)) |

## Known gaps

Found while building and testing. Each row links to where the current behavior is explained.

| Area | Gap | What to do now |
| --- | --- | --- |
| Leads | A saved search stores a campaign but does not enroll the people it finds | Enroll the list yourself, or use a signal automation ([Lead sources](guides/lead-sources.md#saved-searches)) |
| Leads | Large exports are written on the engine machine; there is no download route | Copy the file from `.openoutbound/exports/` ([Lead sources](guides/lead-sources.md#export)) |
| Leads | A saved search run that stops at its spend cap or the budget starts from the beginning next time instead of continuing | Raise `spend_cap_credits` so one run can finish, or continue by hand with the search cursor ([Lead sources](guides/lead-sources.md#saved-searches)) |
| Budgets | Budget checks do not reserve credits: two spends that start at the same moment can each pass the check and together go past the monthly budget, by at most the size of one of them | Leave some headroom in the budget, and run large searches one at a time ([Safety and approvals](concepts/safety-and-approvals.md#budgets)) |
| Privacy | `forget` replaces only exact copies of the email address and LinkedIn URL with `[erased]`; names and other text about the person stay in events and finished jobs until they age out, and in audit entries, and the stored answer of a call made with an idempotency key keeps their details for 24 hours. Data already delivered to webhooks or notification channels stays there | Handle those in your own retention process ([Security](guides/security.md#data-protection-and-gdpr)) |
| Email | No open or click tracking; the `tracking` settings only add an HTML part | Judge campaigns by replies and meetings ([Reports](concepts/reports.md#metric-definitions)) |
| Meetings | The Calendly and Cal.com payloads follow the vendors' public docs and have not been tested against live accounts | Check the answer to the first real delivery before you rely on it ([Meetings](guides/meetings.md#known-limits)) |
| Lead file | Promises are read from email replies only, not from LinkedIn messages | Add a task by hand with `manage_tasks` ([Lead file](concepts/lead-file.md#promises)) |
| Approvals | The `comment` and `spend` approval kinds are reserved; nothing creates them | ([Safety and approvals](concepts/safety-and-approvals.md#approvals)) |
| Signals | Custom signals read only the free collectors; paid signal providers add nothing to them | ([Custom signals](guides/custom-signals.md#current-limits)) |
| Extending | The CLI, `openoutbound mcp` and `serve` load only built-in modules and providers; modules cannot add event types | Add yours as a built-in ([Write a provider](extending/write-a-provider.md#2-register-it), [Custom modules](extending/custom-modules.md#register-it)) |

Warmup is not on this list: it is left to dedicated warmup services on purpose ([Mailboxes](guides/mailboxes.md#warmup-is-external)).

## Suggest something

Open an issue on [GitHub](https://github.com/xyluxx/openoutbound/issues) with what you need and why. For code, read [CONTRIBUTING.md](../CONTRIBUTING.md) first.

Next: [FAQ](faq.md) · [Architecture](architecture.md) · [Write a provider](extending/write-a-provider.md)
