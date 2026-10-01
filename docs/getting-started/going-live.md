# Going live

This page lists every condition for a real send, in the order you meet them, each with the command that shows it. The last command, `workspaces readiness`, checks them all at once. A blocker there is something the engine refuses (a launch) or holds (a send) until it is fixed; a warning never stops a real send.

The commands are written as `openoutbound <command>` (see [Install](install.md#run-the-cli)); from a clone without that command, use `node dist/cli/main.js <command>`. Replace `harbor` with your workspace slug. An agent sees the same answer as `sending` in `get_status`.

## 1. A real workspace

A sandbox workspace never sends anything for real, whatever you configure in it. Real work happens in its own workspace: the `default` one that `init` created, or one per client.

```bash
openoutbound workspaces create --name "Harbor Dental Group" --slug harbor --timezone America/Chicago
openoutbound workspaces list
```

Point your agent at it: `--workspace harbor` in its MCP command (see [Connect your agent](connect-your-agent.md)). Keep the sandbox for practice.

## 2. A mailbox, connected and tested

Email needs at least one mailbox that can send (SMTP) and read replies (IMAP). Without reading replies the engine would miss replies, bounces and unsubscribes, so campaigns with email steps do not launch from a mailbox without IMAP. This is checked at launch: a campaign that already runs keeps sending from a mailbox that lost its IMAP server, so `workspaces readiness` then lists it as a warning.

Test both logins before the first real email. This is a warning (`mailbox_not_tested`), not a blocker: the engine also sends from a mailbox that was never tested, so a wrong password or server would only show on the first real email.

Keep the password (for Google, an app password) off the command line: put it in the engine's `.env` under the name you pass to `--password-env`, then restart `openoutbound serve`. While `serve` runs, the CLI hands the command to it, so a variable exported only in your shell is not seen.

```bash
MAILBOX_SAM_PASSWORD=<app password>
```

```bash
openoutbound mailboxes add --workspace harbor --email sam@harbor.example.com --preset google --password-env MAILBOX_SAM_PASSWORD --test
openoutbound mailboxes list --workspace harbor
openoutbound mailboxes test --workspace harbor --mailbox-id <mailbox id>
```

When a login fails, `mailboxes add --test` and `mailboxes test` exit with code 1 and say which login failed (sending over SMTP or reading replies over IMAP) and what to check. The mailbox stays added: fix the password or the server settings, then run `mailboxes test` again.

Microsoft 365 connects with OAuth only (`openoutbound mailboxes oauth-start --workspace harbor --provider microsoft --email sam@harbor.example.com`). [Mailboxes](../guides/mailboxes.md) covers every way to connect.

## 3. DNS: SPF, DKIM and DMARC

Without good SPF, DKIM and DMARC records, mail lands in spam or is refused. This is a warning, not a blocker: the engine sends anyway.

```bash
openoutbound mailboxes check-dns --workspace harbor --mailbox-id <mailbox id>
```

Each record gets green, yellow or red with the exact fix. The engine checks DNS again every day ([Check DNS](../guides/mailboxes.md#check-dns)).

## 4. Warm-up

A new mailbox sends no cold email for two weeks, then 5 a day, plus 5 a week, up to its daily limit. Emails wait until then; nothing fails. A mailbox you bought pre-warmed starts at 15 a day when you add it with `--warmed-up`. This is a warning, not a blocker.

```bash
openoutbound mailboxes list --workspace harbor
```

The list shows each mailbox's status (`warming` during the ramp) and today's limit ([Warmup is external](../guides/mailboxes.md#warmup-is-external)).

## 5. A public https base URL

Every campaign email carries an unsubscribe link at `OPENOUTBOUND_BASE_URL`. Until that is a public https address, campaigns with email steps do not launch, and their emails are held instead of going out with a link nobody can open. A `sending_blocked` problem says so. Replies to people who wrote to you still go out.

Set it in the engine's `.env` and restart `openoutbound serve`; held emails go out within 30 minutes:

```bash
OPENOUTBOUND_BASE_URL=https://outbound.harbor.example.com
```

```bash
openoutbound doctor
```

`doctor` warns while the base URL is not public https. [Deploy](../guides/deploy.md) shows how to put HTTPS in front of the engine.

## 6. A postal address

Every cold email must carry a postal address (CAN-SPAM, GDPR). Without one, campaigns with email steps do not launch. Replies to people who wrote to you still go out. The address is checked at launch: a campaign that already runs keeps sending, without the address in its footer, so `workspaces readiness` then lists it as a warning.

```bash
openoutbound workspaces update --workspace harbor --settings '{"company":{"name":"Harbor Dental Group","postal_address":"12 Example Street, Austin, TX 78701, USA"}}'
```

In Windows PowerShell 5.1 a JSON flag fails as printed, because PowerShell removes the quotes inside it: write the JSON to `settings.json` and pass `--settings '@settings.json'` ([Install](install.md#json-flags-in-windows-powershell-51) shows how).

## 7. An AI brain

Writing personalized steps and reply drafts needs an AI brain. Without one, AI-written steps and drafts wait: nothing is sent or failed until a brain is configured. Steps that need no writing (exact text, a visit, an invitation without a note) and replies a person approves go out without one.

`workspaces readiness` lists `brain` as a blocker while nothing waiting on the channel can go out without AI: nothing waits yet, or every waiting campaign step is AI-written. Once a step that needs no writing or an approved reply waits, that goes out and `brain` is a warning.

```bash
openoutbound providers set --workspace harbor --slot brain --provider anthropic --secrets '{"api_key":"<your key>"}' --test
openoutbound brain test --workspace harbor
```

In Windows PowerShell 5.1, write that JSON to `secrets.json` and pass `--secrets '@secrets.json'` ([Install](install.md#json-flags-in-windows-powershell-51)). Or set `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) in `.env` and restart `serve`. [AI brain](../guides/ai-brain.md) covers every option, costs and budgets.

## 8. Something to send

Nothing goes out until a campaign is launched or a reply is approved. Check the launch first: the checklist names every problem with its fix. The launch fails while any `FAIL` item is left; a `WARN` item does not stop it.

```bash
openoutbound campaigns launch --workspace harbor --campaign-id <campaign id> --dry-run
openoutbound campaigns launch --workspace harbor --campaign-id <campaign id>
```

When an agent launches, the launch waits for a person (`settings.approvals.agent_launch_requires_approval`, on by default). Decide what waits, launches and replies alike:

```bash
openoutbound approvals list --workspace harbor
openoutbound approvals decide --workspace harbor --approval-id <approval id> --decision approve
```

## 9. Who approves what: the review level

Each campaign has a review level. `first` is the default.

| Level | A person approves |
| --- | --- |
| `every` | Every campaign message before it goes out |
| `first` | The first message each lead gets in a campaign; the later steps go out without review |
| `unsure` | Only messages the automatic check is unsure about |

Whatever the level, a message that fails its automatic check waits for a person, and every reply the engine drafts waits for a person unless you turned on `auto_reply` for that kind of reply. Change the level of one campaign:

```bash
openoutbound campaigns update --workspace harbor --campaign-id <campaign id> --settings '{"review_level":"every"}'
```

In Windows PowerShell 5.1, write that JSON to `settings.json` and pass `--settings '@settings.json'` ([Install](install.md#json-flags-in-windows-powershell-51)).

`workspaces readiness` prints the rules of the workspace in plain words. More in [Safety and approvals](../concepts/safety-and-approvals.md#review-levels).

## 10. Working hours and daily limits

Even when everything above is true, a message goes out only inside its window and its limits:

| Rule | Default |
| --- | --- |
| Campaign send window | Monday to Friday, 8:00 to 17:00 in each lead's timezone |
| Working days of the workspace | Monday to Friday, minus holidays and blackout ranges |
| New leads a campaign starts per day | 20 (`daily_new_leads`) |
| Emails per mailbox per day | 30, with 4 to 12 minutes between two sends |

A message outside its window waits for the next one. See what goes out next and what blocks it:

```bash
openoutbound operating next-actions --workspace harbor
openoutbound operating explain --workspace harbor --message-id <message id>
```

## 11. The workspace is not paused

Pausing a workspace stops all sending at once (the kill switch). Everything waits until it resumes.

```bash
openoutbound workspaces status --workspace harbor
openoutbound workspaces resume --workspace harbor
```

## 12. A LinkedIn account, for LinkedIn steps

LinkedIn steps need a LinkedIn provider (Unipile) and a connected, active LinkedIn account. LinkedIn's terms forbid automation and an account can be restricted: connect one only after its owner accepts that risk. Email works without either.

First the provider, because an account connects through it. Copy the DSN (`host:port`) and the API key from your Unipile dashboard into the engine's `.env`, then restart `openoutbound serve`:

```bash
UNIPILE_DSN=<host:port>
UNIPILE_API_KEY=<your key>
```

Or store them for this workspace only (in Windows PowerShell 5.1, write the JSON to `secrets.json` and pass `--secrets '@secrets.json'`, see [Install](install.md#json-flags-in-windows-powershell-51)):

```bash
openoutbound providers set --workspace harbor --slot linkedin --provider unipile --secrets '{"dsn":"<host:port>","api_key":"<your key>"}' --test
```

Then the account:

```bash
openoutbound linkedin accounts connect --workspace harbor --accept-risk
openoutbound linkedin accounts list --workspace harbor
```

[LinkedIn](../guides/linkedin.md) explains the risks, the limits and the provider. When the LinkedIn provider itself is paused (its key rejected, its quota used up), LinkedIn actions wait until it is fixed: [Provider failures](../concepts/provider-failures.md#paused-providers).

## Check everything at once

```bash
openoutbound workspaces readiness --workspace harbor
```

It says, per channel, whether email and LinkedIn can reach a real person now, with every blocker and warning and the exact command that fixes each.

Some blockers stop campaign messages only: the base URL, the postal address, IMAP on a sending mailbox, a missing brain and having nothing to send. While only those block a channel, replies you approve (and automatic replies, when `auto_reply` is on) still go out on it: `replies_ready` is true, `replies` names the senders, and the summary ends with "Replies you approve still go out by email". A paused or archived workspace, a sandbox, no mailbox that can send, no LinkedIn provider and no active LinkedIn account stop replies too.

The ids it uses:

| Id | Section |
| --- | --- |
| `sandbox` | [1. A real workspace](#1-a-real-workspace) |
| `paused`, `archived` | [11. The workspace is not paused](#11-the-workspace-is-not-paused) |
| `no_mailbox`, `mailbox_not_sending`, `reply_sync` (a warning while a campaign with email steps already runs), `mailbox_not_tested` (warning) | [2. A mailbox, connected and tested](#2-a-mailbox-connected-and-tested) |
| `dns` (warning) | [3. DNS: SPF, DKIM and DMARC](#3-dns-spf-dkim-and-dmarc) |
| `warmup` (warning) | [4. Warm-up](#4-warm-up) |
| `base_url` | [5. A public https base URL](#5-a-public-https-base-url) |
| `postal_address` (a warning while a campaign with email steps already runs) | [6. A postal address](#6-a-postal-address) |
| `brain` (a blocker while nothing waiting goes out without AI, else a warning), `brain_failing` (warning) | [7. An AI brain](#7-an-ai-brain) |
| `nothing_to_send` | [8. Something to send](#8-something-to-send) |
| `linkedin_provider`, `no_linkedin_account`, `linkedin_not_active`, `linkedin_paused`, `linkedin_failing` (warning) | [12. A LinkedIn account, for LinkedIn steps](#12-a-linkedin-account-for-linkedin-steps) |

`openoutbound doctor --workspace harbor` prints the same, next to the engine's own checks.

Next: [Mailboxes](../guides/mailboxes.md) · [AI brain](../guides/ai-brain.md) · [Deploy](../guides/deploy.md) · [Safety and approvals](../concepts/safety-and-approvals.md)
