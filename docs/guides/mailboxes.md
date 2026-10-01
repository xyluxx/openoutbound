# Mailboxes

This guide shows how to connect sending mailboxes (Google Workspace, Microsoft 365, Zoho, any SMTP/IMAP server), set up DNS, and how the engine protects each mailbox with limits, ramps, health checks and reply sync.

OpenOutbound sends through mailboxes you own, over SMTP, and reads replies and bounces over IMAP. It does not warm mailboxes and does not track opens or clicks.

## Before you start

- **Use separate sending domains.** Send from domains that look like your brand but are not your main domain (for example `brand-mail.example.com` next to `brand.example.com`), so a reputation problem never reaches your company email.
- **Set up DNS first**: MX, SPF, DKIM and DMARC for each sending domain. `mailboxes check-dns --domain ...` tells you what is missing (see [Check DNS](#check-dns)).
- **Warm new mailboxes elsewhere.** See [Warmup](#warmup-is-external).
- **Keep volumes low**: 30 emails a day per mailbox is the default; the engine warns above 50.

## Choose how to connect

| Provider | Password (app password) | OAuth | Notes |
| --- | --- | --- | --- |
| Google Workspace | Yes (`--preset google`) | Yes (`mailboxes oauth-start --provider google`) | App passwords need 2-step verification on the account |
| Microsoft 365 | No | Yes, the only way | The mailbox must allow authenticated SMTP (tenant admin setting) |
| Zoho Mail | Yes (`--preset zoho`) | No | |
| Any other server | Yes (`--preset custom` with hosts) | No | |

| Preset | SMTP | IMAP |
| --- | --- | --- |
| `google` | `smtp.gmail.com:465` (TLS) | `imap.gmail.com:993` |
| `microsoft` | `smtp.office365.com:587` (STARTTLS) | `outlook.office365.com:993` |
| `zoho` | `smtp.zoho.com:465` (TLS) | `imap.zoho.com:993` |
| `custom` | Your `--smtp-host`; port 587 by default | Your `--imap-host`; port 993 by default |

Ports 465 and 993 use implicit TLS, other ports use STARTTLS, unless you pass `--smtp-security` or `--imap-security`. If you override the host or port of the `google` or `zoho` preset (for example `smtp.zoho.eu` on port 587), pass `--smtp-security` too: the preset's TLS setting is kept otherwise.

## Add a mailbox with a password

Put the password in `.env` under a name that starts with `MAILBOX_`, restart the engine, and pass the variable's name. The password then never enters a chat or the audit log:

```bash
# .env
MAILBOX_SAM_PASSWORD=abcd efgh ijkl mnop
```

```bash
openoutbound --workspace acme mailboxes add --email sam@brand-mail.example.com --from-name "Sam Carter" \
  --preset google --password-env MAILBOX_SAM_PASSWORD --test
```

`--password` also works (stored encrypted, never returned), but agents should always use `--password-env`. The variable is read by the engine: put it in the engine's `.env` and restart `openoutbound serve` before you add the mailbox. `--test` logs in to SMTP and IMAP right away without sending anything; `mailboxes test --mailbox-id mbx_...` does the same later. Both exit with code 1 when a login fails and say which one; the mailbox stays added.

| Option | Default | Meaning |
| --- | --- | --- |
| `--daily-limit` | 30 | Emails a day, 1 to 500. Above 50 you get a warning. |
| `--min-gap-seconds`, `--max-gap-seconds` | 240, 720 | Random gap between two sends from this mailbox |
| `--ramp` | `{"start":5,"increment":5,"every_days":7,"delay_days":14}` | No cold email for `delay_days` days, then `start` a day, growing by `increment` every `every_days` days up to the daily limit. The default is two quiet weeks, then 5 a day plus 5 a week, 30 from week 8. `null` turns it off. |
| `--warmed-up` | off | For a bought, pre-warmed mailbox: no quiet weeks, the ramp starts at week 5 (15 a day, plus 5 a week). It still ramps; pass `--ramp null` only for a mailbox that already sends cold email at full volume |
| `--signature` | none | Plain-text signature added to emails |
| `--warmup-patterns` | none | Extra markers of your warmup tool, so its mail is ignored (text, or `header:<name>`) |

## Connect with OAuth (Google, Microsoft 365)

OAuth needs your own OAuth app and an engine the browser can reach at `OPENOUTBOUND_BASE_URL`.

1. Create the OAuth app and set its redirect URI to `<OPENOUTBOUND_BASE_URL>/oauth/google/callback` or `<OPENOUTBOUND_BASE_URL>/oauth/microsoft/callback`.
2. Put its credentials in `.env` and restart:

   | Provider | Variables | Permissions the engine requests |
   | --- | --- | --- |
   | Google | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (both required) | `https://mail.google.com/`, `openid`, `email`, `profile`, offline access |
   | Microsoft | `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET` (for web app registrations), `MICROSOFT_OAUTH_TENANT` (default `common`) | `offline_access`, `IMAP.AccessAsUser.All`, `SMTP.Send`, `openid`, `email`, `profile` |

3. Run `openoutbound serve`, then ask for a link:

   ```bash
   openoutbound --workspace acme mailboxes oauth-start --provider microsoft --email sam@brand-mail.example.com --from-name "Sam Carter"
   ```

4. Open `connect_url` (valid 30 minutes) and sign in as that mailbox. The account must match `--email`. The mailbox is created with the default ramp and gaps; for an address that already exists, the connection is renewed.

The refresh token is stored encrypted; access tokens are refreshed automatically. Addresses on `onmicrosoft.com` are refused: use a custom domain. OAuth is not available in sandbox workspaces.

Facts to know when you create the app (checked 2026-09-27):

- **Google.** Mail scopes are restricted: a public app needs Google's verification and a yearly security assessment, and an unverified app is capped at 100 users. An app in testing mode gets tokens that expire after 7 days. For your own Workspace, an internal app (or one your admin trusts) avoids both. App passwords still work with 2-step verification.
- **Microsoft 365.** IMAP with a password is already off, so reading replies needs OAuth. SMTP with a password is off by default for existing tenants from the end of December 2026 (an admin can turn it back on) and is not available for tenants created after that. That is why OpenOutbound supports Microsoft 365 through OAuth only.

## Import many mailboxes from a CSV

`mailboxes import-csv` creates mailboxes from a CSV export (Instantly, Smartlead, a mailbox vendor, or your own) with the same checks as `add`. Run it as a dry run first to see how each row maps:

```bash
openoutbound --workspace acme mailboxes import-csv --csv-credentials "$(cat mailboxes.csv)" --dry-run
openoutbound --workspace acme mailboxes import-csv --csv-credentials "$(cat mailboxes.csv)" --test
```

(PowerShell: `--csv-credentials (Get-Content -Raw mailboxes.csv)`.)

Headers are matched by common names. The first match wins:

| Field | Accepted headers (lowercase, non-letters become `_`) |
| --- | --- |
| Email | `email`, `email_address`, `from_email`, `sender_email`, `mailbox`, `address` |
| Name | `from_name`, `sender_name`, `display_name`, `name`, `full_name`, or `first_name` plus `last_name` |
| Provider | `provider`, `preset`, `esp`, `email_provider`, `provider_type`, `type` |
| SMTP | `smtp_host` (`smtp_server`, `outgoing_server`, ...), `smtp_port`, `smtp_username` (`user_name`, `username`, ...), `smtp_password` (`password`, `app_password`, ...), `smtp_security` (`encryption`, `ssl`, ...) |
| IMAP | `imap_host`, `imap_port`, `imap_username`, `imap_password` (defaults to the SMTP password), `imap_security` |
| Limit | `daily_limit`, `max_email_per_day`, `daily_send_limit`, `sending_limit`, `limit` |
| Signature | `signature`, `email_signature` |

- Up to 500 rows (2,000,000 characters).
- Each row reports `created`, `valid` (dry run), `skipped` (duplicate or already exists) or `error` with the reason.
- Rows for Microsoft 365 (a provider value like `microsoft`, `outlook`, `office`, `o365`, `m365`, `exchange` or `hotmail`) fail: connect those one by one with OAuth.
- The CSV holds passwords in plain text. The audit log redacts the field; delete the file after the import.

## Check DNS

```bash
openoutbound --workspace acme mailboxes check-dns --domain brand-mail.example.com
openoutbound --workspace acme mailboxes check-dns --mailbox-id mbx_...
```

With `--mailbox-id`, the result is stored on every mailbox of that domain and shown in `mailboxes list`. `doctor` also shows it.

| Record | Green | Yellow | Red |
| --- | --- | --- | --- |
| MX | Present | | None |
| SPF | One record that includes your provider | More than one record, `+all`, or the provider's include missing | None |
| DKIM | A key found | No key found at the usual selectors | |
| DMARC | Policy `quarantine` or `reject` | None, `p=none`, or more than one record | |

The overall rating is the worst of the four. Each check comes with a one-line summary and the exact fix, for example "No SPF record." and the TXT record to add. The provider include is checked for Google (`include:_spf.google.com`), Microsoft (`include:spf.protection.outlook.com`) and Zoho. DKIM is found by probing the selectors `google`, `selector1`, `selector2`, `default`, `k1`, `s1` and `zoho`; if your provider uses another selector, a yellow DKIM result can be wrong. Run the check again after you change records.

### Daily DNS check

Every day at 06:17 UTC, each workspace re-checks the DNS of every domain that has an `active` or `warming` mailbox and stores the result on the domain's mailboxes, like `check-dns --mailbox-id` does. Records break more often than you would think: a DNS host change, a new SPF record that replaces the old one, an expired domain.

- When a record stops passing compared with the stored result (green before, yellow or red now, for example a DKIM key that disappears, a DMARC policy weakened to `p=none` or a second SPF record), or turns red, or a domain that was never checked is red, the engine opens one `dns_failed` problem for the domain in the attention queue (severity high, for a person). The problem names each record that changed and gives the fixes, then says to run `manage_mailboxes` action `check_dns` to confirm. The engine also emits `mailbox.dns_failed` for each sending mailbox of the domain and sends one notification to your channels.
- While the records stay as they are, the same problem stays open: no new problem, event or notification. Another record that stops passing is added to the problem and alerts again.
- When every record the problem names is green again, the problem is resolved. A record that was yellow from the start (a DKIM selector the probe cannot find, a DMARC policy of `p=none`) never opens the problem; `check-dns` still shows how to improve it. A problem whose domain no longer has a sending mailbox is resolved too.
- Mailboxes are never paused by this check. Bounces and health checks pause them when mail really fails (see [Health and automatic pauses](#health-and-automatic-pauses)).
- A lookup that times out or that the DNS server fails to answer (`SERVFAIL`, refused) counts as yellow and is no change: the stored status stays what it was, so a slow or broken resolver does not raise alarms, never reads as a missing record, and the next check still compares with the last known result.

Turn it off per workspace with `sending.daily_dns_check`:

```bash
openoutbound --workspace acme workspaces update --settings '{"sending":{"daily_dns_check":false}}'
```

Sandbox workspaces are never checked.

## Warmup is external

OpenOutbound does not warm mailboxes. Warmup networks exchange mail between many inboxes to build reputation; that needs a shared network, which an engine you run yourself does not have. Use a warmup service or buy pre-warmed mailboxes.

What the engine does instead:

- **Ramp.** New mailboxes send no cold email for two weeks (time to set up DNS and send some real mail), then 5 a day, plus 5 a week, up to the daily limit (30 from week 8). Their status is `warming` until then. Mailboxes you mark `--warmed-up` start at week 5 (15 a day).
- **Ignores warmup mail.** Messages from common warmup tools are recognized by their headers and tags (lemwarm, Mailwarm, Instantly, Smartlead, Warmbox, MailReach, Warmy and any `X-...warmup` header) and dropped during sync, so they never reach the inbox or the reports. Add your own markers with `--warmup-patterns`.

Keep your warmup tool running on mailboxes you send from, as vendors recommend.

## Where to get mailboxes

If you do not want to manage Google or Microsoft accounts yourself, mailbox vendors sell ready mailboxes on your domains. Facts as of September 2026, from the vendors' own pages (prices change; reputation data about these vendors is mostly written by competitors):

| Vendor | Price | What you get |
| --- | --- | --- |
| [Primeforge](https://www.primeforge.ai/pricing) | $4.50 per mailbox a month (minimum 10; about $3.75 on annual) | Not pre-warmed and no warmup included. Pre-warmed mailboxes: $9 a month or $90 a year, warmed at least 3 months, domains $18 a year, at least 4 domains with 3 mailboxes each. Its docs disagree on app passwords versus OAuth only. Has an API. |
| InboxKit | $3 per mailbox a month, $2.50 on annual, no minimum | App passwords, API and webhooks. Warmup $3; pre-warmed $6 to $9. |
| Zapmail | $39 for 10 mailboxes in the first year, then $59, plus $6 per mailbox | Check the current plans on the vendor's page |

Whatever you buy, check three things: you get SMTP and IMAP access (app passwords) or can connect with OAuth, you can export a CSV for `mailboxes import-csv`, and DNS (SPF, DKIM, DMARC) is set up on the domains.

## Limits and sending

| Rule | Value |
| --- | --- |
| Daily limit per mailbox | 30 by default (1 to 500), counted in the workspace timezone |
| Gap between two sends from one mailbox | Random, 240 to 720 seconds |
| Ramp | No cold email for two weeks, then 5 a day, plus 5 a week, up to the daily limit (30 from week 8). Pre-warmed mailboxes (`--warmed-up`) start at 15 a day |
| Per recipient domain | At most 2 emails an hour to one company domain across all your mailboxes (public domains like gmail.com are exempt) |
| Sending window | The campaign's days and hours in the lead's timezone, the workspace's working days, minus holidays and blackout ranges |

Change the limit or the ramp later with `mailboxes update` (MCP: `manage_mailboxes` action `update`). Like `mailboxes add`, it warns when the daily limit goes above 50 or the ramp is turned off. When an agent raises the daily limit above 50, or turns off or shortens the ramp of a mailbox that is still warming, that part waits for a human approval (kind `mailbox_limits`) and the other fields change at once; approving applies it, rejecting keeps the mailbox as it is. Lowering the limit or slowing the ramp never needs an approval.

The planner picks the campaign's mailbox with room left (the one already used for the person, else the least used) and the next free slot up to 21 days ahead. When no slot is free, the email waits instead of failing.

Every email is plain text. An HTML part is added only when the campaign turns on `tracking` settings, which do nothing else for now: there are no tracking pixels and no link rewriting. Each campaign email carries:

- A footer with your sender line and postal address, the advertisement line for recipients in `compliance.ad_disclosure.countries` (default the US) or with an unknown country, an unsubscribe link, and for EU, EEA and UK recipients a line naming the data source and the legal basis. Each line can be switched in `settings.compliance`.
- `List-Unsubscribe` headers with the link and a `mailto:`, plus `List-Unsubscribe-Post` when the link is https (one-click unsubscribe).

The unsubscribe link is `<OPENOUTBOUND_BASE_URL>/u/<token>`. Opening it shows a confirmation page; only the button (or a one-click POST from the mail client) unsubscribes. So set `OPENOUTBOUND_BASE_URL` to a public https URL before you send real campaigns (see [Deploy](deploy.md)). Until you do, campaigns with email steps do not launch, and emails are held (a `sending_blocked` problem says so) rather than sent without a working link; replies to people who wrote to you still go out, with the `mailto:` and a line asking them to reply "unsubscribe".

## Health and automatic pauses

| Trigger | Result |
| --- | --- |
| Hard bounce rate over 7 days at 2% or more (at least 20 sends) | Warning notification, at most once a day |
| Hard bounce rate over 7 days above 3% (at least 20 sends) | Mailbox paused, `mailbox.paused` |
| 5 failures in a row | Mailbox paused |
| Login or server settings rejected | Mailbox set to `error`, `mailbox.error`; queued emails move to another campaign mailbox that can send, and the others (replies, emails no other mailbox can take) wait until it sends again |
| The provider blocks the sender (codes such as 5.7.26 or 5.7.515, or Gmail's x.7.28) | Every mailbox on the sending domain paused (48 hours for x.7.28, until resumed otherwise) |
| The provider throttles | No sends from that mailbox until the next midnight in the workspace timezone |
| Another server refuses the sender (blocklist, reputation, spam or policy block) | Counts as a send failure on the mailbox |

The health check runs hourly (at minute 7). After a resume it counts only sends from the resume on, so bounces from before cannot pause the mailbox again. Fix the cause, then `mailboxes resume --mailbox-id mbx_...` (add `--restart-ramp` to start the ramp again today at its start volume, 5 a day by default, without the two quiet weeks). A mailbox in `error` or `disconnected` comes back when `mailboxes test` succeeds or it is reconnected with OAuth, and the emails that waited for it go out. `mailboxes pause` pauses by hand; replies keep syncing while paused.

## Problems in the attention queue

Problems tell a person when sending stops or keeps failing, or when replies cannot be read. Each names the mailbox or campaign, says why in plain words and gives the fix with the ids to use.

| Problem | Opens when | Resolved when |
| --- | --- | --- |
| `mailbox_down` (high, for a person) | The mailbox stops sending because of an error: login or server settings rejected (`error`), a lost connection, a pause for its bounce rate, after a provider block or after 5 failures in a row. A pause you make yourself opens nothing. One problem per mailbox, titled like "Mailbox sam@brand-mail.example.com stopped sending" | It sends again (a resume, a clean `mailboxes test`, an OAuth reconnect, the end of a timed pause), or it is removed |
| `mailbox_down` for reading (high, for a person) | The mail server refuses the IMAP login, so replies, bounces and unsubscribe replies are not read. It opens at the first refused login and is separate from the sending problem: sending is not affected. It also opens when the sync could not store the same message in 3 syncs in a row (see [Reply sync and bounces](#reply-sync-and-bounces)). Titled like "Mailbox sam@brand-mail.example.com cannot read replies" | A sync or `mailboxes test` reads the mailbox again (for a message that cannot be stored: a sync that gets past it), or it is removed |
| `send_failed` (normal, for anyone) | An email fails for good: no valid recipient address, no subject or text, a template variable with no value, the mail server refused it, or every try (6) failed with a temporary error. One problem per campaign (or conversation) and cause, with the count and the latest message | You resolve it with `resolve_exception` action `resolve` after the fix. The next failure opens a new one |

Bounces, skipped emails (the person may not be contacted) and cancelled emails never open `send_failed`. LinkedIn accounts and actions open the same two problems, see [LinkedIn](linkedin.md#restrictions-and-lost-sessions); a LinkedIn account whose sync keeps failing also gets a `mailbox_down` problem for reading, see [LinkedIn](linkedin.md#when-a-sync-fails).

## Reply sync and bounces

IMAP sync runs every 5 minutes for active and paused mailboxes. It reads `INBOX` and the spam folder (read-only), looks back 3 days on the first run, and reads at most 200 messages per folder per run. It also reads the Sent folder, see [Emails you write yourself](#emails-you-write-yourself).

When a sync fails, sending goes on. The error is kept on the mailbox with its class: `last_sync_error` and `last_sync_failure` in `mailboxes list`. A refused login (`auth_invalid`) opens the `mailbox_down` problem for reading at once (see [Problems in the attention queue](#problems-in-the-attention-queue)); other failures, such as a timeout or a lost connection, are tried again at the next sync. A clean sync or `mailboxes test` clears both fields.

A message the sync cannot store is never skipped, since it may be an unsubscribe: its folder waits at it and every sync tries it first. Such a sync counts as failed, with the folder, the UID and the error in `last_sync_error`. After 3 syncs in a row stopped at the same message, the `mailbox_down` problem for reading opens. Handle the message by hand (answer it, or suppress the sender if it asks to unsubscribe), then move it to a folder the sync does not read: the next sync goes past it and closes the problem. A `mailboxes test` does not clear it while the message still blocks its folder.

| Incoming mail | What happens |
| --- | --- |
| Hard bounce: a 5.x.x code about the address, such as 5.1.1 unknown user, 5.2.1 disabled mailbox or 5.4.4 no such domain. Mailbox full (5.2.2) and message too big (5.2.3, 5.3.4) are soft | Message marked bounced, the address marked invalid and suppressed, the person's status `bounced`, `message.bounced` |
| Soft bounce (4.x.x, mailbox full, message too big, or unknown) | Message marked bounced; a second soft bounce within 14 days counts as hard |
| Bounce that refuses the sender, not the address (authentication such as 5.7.26 or 5.7.515, x.7.28, blocklist, reputation or policy blocks, rate limits) | Message marked bounced with `sender_rejected`; only the mailbox's health changes, as in the table above. The person, their address and their bounce count stay untouched, and no `message.bounced` is emitted. The inbox applies the same rule to bounces the sync did not recognize (an unknown sender, no delivery-status part) |
| Unsubscribe reply (12 words or fewer with stop words in English, German, French or Spanish, or the subject "unsubscribe") | Address suppressed, person `unsubscribed`, `unsubscribe.received` |
| Auto-reply (by headers, or subject patterns in English, German, French and Spanish) | Stored in its thread and classified as out-of-office or another automatic reply; dropped when it matches no thread |
| Warmup mail | Dropped |
| A reply in a known thread, or mail from a known person | Stored, the thread flagged, `reply.received`; then the [inbox](../concepts/inbox.md) classifies it |
| Anything else | Ignored |

## Emails you write yourself

When you or a colleague write from the mailbox itself (in Gmail, Outlook or any mail app), the sync finds those emails in the Sent folder, so the engine never talks over you. The folder is found by its `\Sent` flag, else by a common name (Sent, Sent Items, Sent Mail, Sent Messages and their German, French and Spanish names). The sync keeps its own place in that folder and reads only the headers first; a full email is downloaded only when it matters.

| Email in the Sent folder | What happens |
| --- | --- |
| One the engine sent (same Message-ID) | Confirms a send whose outcome was unknown (see below) and proves that the server keeps sent copies (`sent_copies_seen_at`). Nothing new is stored |
| A reply in a known thread, with one of your leads in To or Cc | Stored in the thread as your message, and a person takes the thread over: the engine cancels its unsent messages there, stops the lead's sequences and writes nothing on its own until the thread is handed back. See [Inbox](../concepts/inbox.md#taking-a-thread-over) |
| A new email to one of your leads (in To) | Stored in a new thread that a person owns, and the lead's running sequences stop (reason `person_took_over`) |
| Warmup mail, auto-replies, bulk mail, forwards to colleagues, mail to anyone who is not a lead | Ignored, nothing stored |

Every email in the Sent folder counts as written by a person of that mailbox, also one sent from an alias of the account. Your own emails show in threads and in the lead's timeline as `origin: external`, and their text is marked untrusted like inbound mail. They never count as engine sends: not in reports, daily limits or bounce rates. They do keep the engine's usual gap after them, from the mailbox and to the same company domain. To stop reading Sent folders, turn off the workspace setting `inbox.read_sent_folder` (on by default).

## Sends with an unknown outcome

A send can end without a clear answer: the connection drops or times out after the email was handed over, the send runs past its 90-second deadline after its data may have reached the server (the engine then closes the connection, so the send cannot finish unseen later), or the worker stops in the middle. The email may or may not have gone out, so the engine never retries it blindly. It marks the message `unknown` (event `message.unknown`) instead. Errors before the email was handed over (connection refused, DNS, TLS, login) and answers in which the server refused it (any 4xx or 5xx answer, also one to the data itself) are handled as usual, on the same message: retried, bounced, failed, or treated as a mailbox problem (see [Health and automatic pauses](#health-and-automatic-pauses)). A send stopped at its deadline before its data went out is retried too. So `failed` always means the server never took the email. An answer that took it counts as sent, with or without a queue id; only a refusal of this recipient by name means it did not go out (addresses are compared in lowercase, with the domain in its ASCII form). The full rule, with the test behind each case: [Delivery guarantees](../concepts/delivery-guarantees.md).

Every 10 minutes the `email.reconcile_sends` job looks for each unknown email in its mailbox's Sent folder by Message-ID:

- **Found:** the message becomes `sent`, dated when its sending started, and the sequence moves on.
- **Not found after 3 lookups** (about 30 minutes): when the mailbox is proven to keep a copy of what it sends (`saves_sent_copies` is true, see below), the email goes out once more with the same Message-ID, at the next time its mailbox may send (inside the send window, within the daily limit). Otherwise, or when that second try has no clear answer either, a person is asked: a `send_unknown` problem (high severity) titled "Check whether an email went out", naming the mailbox, the recipient and the subject.
- **No way to look:** a mailbox without IMAP, or with no Sent folder, gets the problem at once. When the Sent folder cannot be opened, the problem opens 30 minutes after the send.
- **Late copy:** a copy that turns up within 3 days still marks the email sent and resolves the problem, also while the second try waits in the queue (the second try is dropped then).

A second try runs the checks of any send: a sequence step whose sequence was stopped, whose campaign ended or whose thread a person took over meanwhile is cancelled instead.

The same job sweeps messages still `sending` 15 minutes after their sending started with no job left to finish them: they become `unknown` too. It also queues again a `scheduled` email that is 15 minutes past its time with no send job left (for example after `jobs cancel`). An unknown email keeps its place in the mailbox's daily limit until it is settled.

**`saves_sent_copies`** (shown by `mailboxes list`) says whether the server is proven to keep a copy of what it sends in the Sent folder. It becomes true the first time the engine finds one of its own emails there (a lookup above or the Sent folder sync), and `sent_copies_seen_at` keeps when. It is false for `smtp-relay.gmail.com`, which never keeps copies, and empty until proven for every other mailbox, Google and Microsoft included: they usually keep copies, but that is a hint, not proof. Until then the engine does not send an unknown email again on its own, because a missing copy proves nothing. Changing the mailbox's SMTP or IMAP host or user with `mailboxes update` clears the proof, since a copy seen through other servers says nothing about the new ones.

**Duplicates.** The answer of a first try can still come after the email was sent again (for example from a worker that hung). When it says the first try went out and the second went out too, the email went out twice. The engine records it instead of hiding it: `why.duplicate_attempts` on the message, the event `message.duplicate`, a `duplicate_send` problem (normal severity) that says there is nothing to undo, and the campaign report's `duplicates` count. When the late answer finds the email `unknown`, `failed`, queued again or back in review, the email simply becomes `sent`, and an approval still asked for about it is cancelled.

To settle a problem, look in the Sent folder of the mailbox it names, then call `manage_messages` action `resolve_unknown` with the `message_id` and an `outcome` (CLI: `messages resolve-unknown`):

| Outcome | Effect |
| --- | --- |
| `sent` | You found it: the message becomes `sent`, is counted and the sequence moves on |
| `resend` | It is not there: it goes out again with the same Message-ID, after the usual checks and limits, at the next time its mailbox may send. Needs the `send` scope. Anyone but a person holding `approve` (an agent, for example) gets an approval of kind `message` instead: the message stays `unknown` and nothing is queued until a person approves it |
| `cancel` | Do not send it: the message is cancelled and the sequence skips the step |

Each outcome resolves the problem. Add `dry_run` to see what an outcome would do first. LinkedIn invitations, messages and comments follow the same rule, see [LinkedIn](linkedin.md#when-linkedin-gives-no-clear-answer).

## Tools and commands

MCP: `manage_mailboxes` (toolset `core`) with the actions `list`, `add`, `import_csv`, `update`, `remove`, `pause`, `resume`, `test`, `check_dns` and `oauth_start`. CLI: `mailboxes <action>` with hyphens (`mailboxes check-dns`, `mailboxes import-csv`, `mailboxes oauth-start`). `mailboxes remove` deletes the mailbox and its stored credentials. Unknown sends are settled with `manage_messages` action `resolve_unknown` (CLI: `messages resolve-unknown`). Every flag is in the [CLI reference](../reference/cli.md).

Sandbox workspaces get 3 fake mailboxes that write to an in-memory outbox and never connect anywhere. Recipients whose address starts with `bounce` get a hard bounce, so you can test bounce handling. The reconcile job looks in that outbox instead of a Sent folder.

Next: [LinkedIn](linkedin.md) · [Campaigns](../concepts/campaigns.md) · [Deploy](deploy.md) · [Inbox](../concepts/inbox.md)
