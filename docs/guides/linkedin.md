# LinkedIn

This guide shows how to connect LinkedIn accounts for outreach through Unipile, what the safety limits are and why, what happens when LinkedIn restricts an account, and how to publish posts with LinkedIn's official API.

## Read this first

LinkedIn's User Agreement (section 8.2) does not allow automated activity or scraping. Any automation, including this one, can get an account restricted. OpenOutbound lowers the risk (conservative limits, working hours, random gaps, a ramp for new accounts) but cannot remove it.

- Connecting an account requires `accept_risk: true`: the account owner accepts the risk in writing.
- Actions run inside the owner's own account through Unipile. OpenOutbound never asks for or stores a LinkedIn password; the owner logs in on Unipile's page.
- Posting through the official API (below) is allowed by LinkedIn and does not need Unipile.

If the risk is not acceptable, run email-only campaigns and use LinkedIn by hand: campaign `task` steps can remind a person to visit or message someone.

## Set up Unipile

1. Create a Unipile account and copy your DSN (`host:port`) and API key from its dashboard.
2. Configure the provider, for one workspace or the whole instance:

   ```bash
   openoutbound --workspace acme providers set --slot linkedin --provider unipile \
     --secrets '{"dsn":"<host:port>","api_key":"..."}' --test
   ```

   Or set `UNIPILE_DSN` and `UNIPILE_API_KEY` in `.env`. The same two secrets also serve the Unipile posting provider (slot `social`).
3. Optional but recommended: in the Unipile dashboard, add a webhook to `<OPENOUTBOUND_BASE_URL>/hooks/unipile` with the header `X-OpenOutbound-Secret: <UNIPILE_WEBHOOK_SECRET>`, and set `UNIPILE_WEBHOOK_SECRET` in `.env`. Webhooks deliver new messages, accepted invites and account problems as they happen. Without them, the engine syncs every 15 minutes.

## Connect an account

```bash
openoutbound --workspace acme linkedin accounts connect --accept-risk --name "Sam Carter" --timezone Europe/Berlin
```

The command returns a hosted login link (valid 24 hours). The account owner opens it and logs in to LinkedIn on Unipile's page. The account starts as `pending` and turns `active` when Unipile calls `<OPENOUTBOUND_BASE_URL>/hooks/unipile/auth`, or at the next sync (`linkedin accounts sync` runs one now).

| Option | Meaning |
| --- | --- |
| `--accept-risk` | Required. The owner accepted that automation breaks LinkedIn's terms and can get the account restricted. |
| `--timezone` | The owner's timezone for working hours (default the workspace timezone) |
| `--premium` | Premium or Sales Navigator: 300-character invite notes and no monthly note cap |
| `--ramp` / `--no-ramp` | Start at 40% of the limits and ramp up over 2 weeks (on by default) |
| `--external-account-id` | Link an account that is already connected in Unipile, without a new login |

MCP: `manage_linkedin` action `connect`. Agents must never ask for a LinkedIn password.

## Limits and why

Every account has daily caps, working hours and random gaps. The defaults are conservative on purpose: LinkedIn watches for bursts, round-the-clock activity and invites that nobody accepts.

| Action | Default cap | Maximum you can set |
| --- | --- | --- |
| Invites | 15 a day, 80 in any 7 days | 100 a day, 300 a week |
| Messages | 40 a day | 150 |
| Profile visits | 60 a day | 250 |
| Likes | 30 a day | 150 |
| Comments | 10 a day | 50 |
| Invite notes (free accounts) | 3 a month | 300 |

| Rule | Value |
| --- | --- |
| Working hours | Monday to Friday, 09:00 to 18:00 in the account's timezone |
| Gap between two actions | Random, 2 to 12 minutes |
| Ramp | 40% of every cap in week 1, 70% in week 2, 100% from week 3 |
| Invite notes | At most 300 characters on premium accounts; campaign notes are written to 200 characters or fewer |
| Pending invites | Withdrawn after 21 days (at most 2 per sync run) |
| Re-invite | Not within 30 days of a withdrawal |
| Likes and comments | Only on posts from the last 14 days |

Change them per account with `linkedin accounts update --limits '{"invites_per_day":10}'`, `--working-hours '{"days":[1,2,3,4,5],"start_hour":8,"end_hour":17}'` or `--ramp on|off|restart`. Lowering is always safe; raising above the defaults returns warnings.

When no slot is free in the next three weeks, the action fails with `limit_reached`. Campaign steps otherwise wait for the next free slot.

## Restrictions and lost sessions

| Status | Cause | What to do |
| --- | --- | --- |
| `restricted` | Unipile reported a restriction, or 3 rate limits in a row | Everything on the account stops, `linkedin.account_restricted` fires and you get a critical notification. Log in by hand, clear every LinkedIn check, use the account normally for about 7 days, then `linkedin accounts resume`. Only a human can resume a restricted account; the ramp restarts at week 1. |
| `disconnected` | The session expired or LinkedIn asks for the password again | Queued actions are paused and you get a notification. Log in again at Unipile; when Unipile reports the account reconnected, it becomes active again. |
| `paused` | You paused it (`linkedin accounts pause`) | Nothing new is planned; replies keep syncing. `linkedin accounts resume` continues. |

`linkedin accounts remove` disconnects the account from OpenOutbound (queued actions are cancelled, sent messages stay); it does not delete anything at Unipile or on LinkedIn.

A restriction or a lost session also opens one `mailbox_down` problem for the account in the attention queue (severity high, for a person), titled like "LinkedIn account Sam on LinkedIn stopped sending", with what to do. A pause you make yourself opens nothing. The problem is resolved when the account works again (`linkedin accounts resume`, Unipile reports it reconnected, a new login) or is removed.

An action that fails for good counts in its campaign's `send_failed` problem, like an email: an invitation note or a comment that is too long, an empty message or comment, or LinkedIn refusing it or failing on every retry. Skipped actions (the person may not be contacted, already connected or invited) never do. See [Mailboxes](mailboxes.md#problems-in-the-attention-queue).

## Sync and relations

The sync (every 15 minutes, or on webhook) picks up accepted invites, new LinkedIn messages and finished logins, and withdraws old invites. An accepted invite fires `linkedin.connected` and wakes campaign steps that wait for the connection. New messages go to the [inbox](../concepts/inbox.md) like email replies.

`linkedin relations list` shows the state between each of your accounts and each person: `none`, `invited`, `connected` or `withdrawn`, with invite and connect times.

### When a sync fails

The sync reads two listings from the provider, relations and messages, and only moves past what it received and stored.

- When the provider stops a listing early (it hands back a cursor), the next sync continues from that cursor. The time up to which everything was read moves only once the listing ends, so nothing is skipped.
- When the provider no longer accepts a stored cursor (`bad_request`, `not_found` or `malformed`, for example an expired cursor), the sync drops it: the next sync lists again from the time up to which everything was read. Messages read twice are stored once.
- When a listing fails, it keeps its place and the failure is kept with its class: `last_sync_error` in `linkedin accounts list` shows when, which step (`relations`, `messages` or `actions`), the error and the `failure`. The sync result has the same `failure`.
- One failed listing does not stop the other, unless the failure concerns the account or the provider (a lost session, a rejected Unipile key, a rate limit, the provider down). Old invites are withdrawn only in a sync where nothing failed. Overdue actions (whose jobs were lost while the workers were down) are queued again after a failed listing too, unless the failure stopped the sync.
- A lost LinkedIn session (Unipile `errors/disconnected_account` or expired credentials) sets the account to `disconnected`, as in [Restrictions and lost sessions](#restrictions-and-lost-sessions).
- A rejected Unipile API key, or a Unipile paused for the workspace, leaves the account `active` with the error in `last_sync_error`: the provider is paused with a `provider_down` problem (see [Provider failures](../concepts/provider-failures.md#paused-providers)), and the account syncs again once the key is fixed. Do not reconnect the accounts for it.
- The next clean sync clears `last_sync_error`. Temporary failures need nothing from you: the sync runs again within 15 minutes.
- After 5 failed syncs in a row (about 75 minutes), the account gets a `mailbox_down` problem for reading (high, for a person, key `mailbox_down:<account_id>:read`), titled like "LinkedIn account Sam Example cannot read replies": new replies and accepted invitations are then read only through the webhook, if one is set up. The next clean sync, or removing the account, resolves it.

## When LinkedIn gives no clear answer

An invitation, message or comment whose call timed out, was cut off, got a server error (5xx, whatever its text says) or an answer that cannot be read may have reached LinkedIn, so it is never retried blindly. It becomes `unknown` (event `message.unknown`) and is checked every 10 minutes. Only an answer that refused the action (a rate limit, a refusal, a restricted or disconnected account), a connection that never opened (refused, or timed out while opening), a call stopped before it was sent, or a failure while reading the profile before an invitation or the posts before a comment is retried on the same message, since nothing was sent then. An answer that took the action without an id counts as sent. Every provider call stops when its job ends, so no call outlives its job.

| Action | How it is checked |
| --- | --- |
| Invitation | The person's live profile: a pending invitation or a connection means it went out. Nothing after 3 checks: sent once more, and a person decides if that is unclear too |
| Message | A person decides. When the provider can read recent messages, the same text sent by the account in the person's own conversation (the thread's chat, or a chat the person wrote in) confirms it; the same text in another conversation proves nothing. It is never sent again on its own: a chat list that does not show it yet is no proof |
| Comment | A person decides, after looking at the post's comments. It is never sent again on its own |

A person gets a `send_unknown` problem such as "Check whether a LinkedIn message went out" and settles it with `manage_messages` action `resolve_unknown` after checking LinkedIn. A second try runs the checks of any action: a sequence step whose sequence was stopped, whose campaign ended or whose conversation a person took over meanwhile is cancelled instead. See [Mailboxes](mailboxes.md#sends-with-an-unknown-outcome) for the outcomes. When a late answer shows an action went out twice, a `duplicate_send` problem says so ([Delivery guarantees](../concepts/delivery-guarantees.md#duplicates)).

Profile visits and likes are done at least once by design, since doing them twice is harmless. One that stopped mid-action is done again (up to 3 attempts), and one whose call timed out, was cut off or got a server error is tried again like any temporary failure (up to 5 tries of its job). After that, or when LinkedIn's answer cannot be read, it fails, marked as possibly done (`why.failed_before_handover` is false).

## Posting

Posts are drafted from your knowledge base and published to a LinkedIn profile. Two ways to publish:

| Provider | Slot | What it needs | Account ids |
| --- | --- | --- | --- |
| `linkedin_official` | `social` | A LinkedIn developer app with the "Share on LinkedIn" product | `sac_...` |
| `unipile` | `social` | A connected Unipile LinkedIn account | `lia_...` |

Official API setup:

1. Create an app at LinkedIn's developer portal. Add the "Share on LinkedIn" product and OpenID Connect sign-in (for the `openid` and `profile` scopes), and add the redirect URL `<OPENOUTBOUND_BASE_URL>/oauth/linkedin/callback`.
2. Set `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` in `.env` (or `providers set --slot social --provider linkedin_official`).
3. Run `openoutbound serve` and `openoutbound --workspace acme posts accounts connect`. Open the link (valid 15 minutes) and sign in. The engine requests the scopes `openid`, `profile` and `w_member_social`. Tokens last about 60 days; connect again when `posts accounts list` shows the account as expired.

Then:

```bash
openoutbound --workspace acme posts draft --topic "What we learned from 50 onboarding calls" --count 3
openoutbound --workspace acme posts schedule --post-id pst_... --scheduled-for 2026-10-06T08:30:00+02:00
```

Scheduling or publishing creates an approval of kind `post` unless a human with the `approve` scope asks. Approved posts go out at their time (the publisher checks every 5 minutes) while the workspace is active; `post.published` fires with the URL. MCP: `manage_posts` (toolset `content`) with the actions `list`, `draft`, `update`, `schedule`, `publish`, `cancel`, `resolve_unknown`, `accounts` and `connect_account`.

A post is published at most once per attempt, by the same rule as messages ([Delivery guarantees](../concepts/delivery-guarantees.md)). Its status says where it stands, and `note` (in `manage_posts` action `list`) says what the engine knows beyond that:

| Status | Meaning |
| --- | --- |
| `draft` | Written, not planned |
| `pending_review` | Waits for a human approval |
| `scheduled` | Waits for its time, for another try after a rate limit or a connection that never opened, or while its publisher is paused (the `note` says when) |
| `approved` | Approved and due: published at once. Moving its time makes it `scheduled` for that time |
| `publishing` | Being handed to LinkedIn right now. `publish`, `schedule`, `update` and `cancel` refuse it meanwhile |
| `published` | Live. An answer without a post id still counts; the `note` then says the link is missing |
| `failed` | Nothing reached LinkedIn: a refusal, the member's rejected token, bad input, missing credentials, an inactive account, or 5 tries of one request that each stopped before LinkedIn. It can be published again |
| `unknown` | The publish got no clear answer (a timeout or a dropped connection once the connection was open, a server error, an answer that broke off before LinkedIn named the post, or a run that stopped mid-publish for 15 minutes): it may be live. It is never published again on its own |

An `unknown` post gets a `send_unknown` problem ("Check whether a LinkedIn post went out"). Look at the profile's recent activity, then settle it with `manage_posts` action `resolve_unknown` (CLI `posts resolve-unknown`):

| Outcome | Effect |
| --- | --- |
| `published` | It is live: the post becomes `published`. Pass `url` when you found it |
| `republish` | It is not there: publish it once more. Needs the `send` scope and, like any publish, a human approval unless a human with the `approve` scope asks. That approval covers only the try it was asked about: publishing the post again another way cancels it. If the first one turns out to be live after all, a `duplicate_send` problem says the post went out twice |
| `cancel` | Do not publish it: back to `draft` |

Each outcome closes the problem. `publish`, `schedule`, `update` and `cancel` refuse an `unknown` post and point to `resolve_unknown`.

## Tools and commands

| MCP tool | Actions | CLI |
| --- | --- | --- |
| `manage_linkedin` | `list`, `connect`, `update`, `pause`, `resume`, `remove`, `sync`, `relations` | `linkedin accounts ...`, `linkedin relations list` |
| `manage_posts` | `list`, `draft`, `update`, `schedule`, `publish`, `cancel`, `resolve_unknown`, `accounts`, `connect_account` | `posts ...`, `posts resolve-unknown`, `posts accounts list`, `posts accounts connect` |

Sandbox workspaces have one fake LinkedIn account; about 35% of invites are accepted, and nothing touches LinkedIn.

Next: [Campaigns](../concepts/campaigns.md) · [Mailboxes](mailboxes.md) · [Inbox](../concepts/inbox.md) · [FAQ](../faq.md)
