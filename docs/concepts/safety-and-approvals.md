# Safety and approvals

This page explains every safety mechanism in the engine: the gate each call passes, scopes, approvals and review levels, dry runs, idempotency, budgets, the kill switch, the checks before every send, the audit log and how untrusted text is handled.

The principle: the engine enforces, agents decide. None of these checks depend on a prompt. An agent that ignores its instructions still cannot pass them.

## The safety gate

Every call, from every door (MCP, CLI, REST, background jobs), runs through the same steps in this order:

| # | Step | Fails with |
| --- | --- | --- |
| 1 | Resolve the caller (API key, local principal or the system) | `unauthorized` |
| 2 | Resolve the workspace and check the caller may access it: a key or session bound to one workspace reaches only that one, and instance-level operations follow their policy | `forbidden`, `not_found`, `validation_failed` |
| 3 | Check the caller has the operation's scopes | `forbidden` (names the missing scope) |
| 4 | Validate the input against the operation's schema | `validation_failed` (lists the fields, with an example input) |
| 5 | Decide dry run or real run (reads ignore `dry_run`) | `unsupported` if the operation has no dry run |
| 6 | Look up the idempotency key | `idempotency_mismatch`, or the stored result is returned |
| 7 | Send operations: stop if the workspace is paused or archived | `workspace_paused` |
| 8 | Spend operations: stop if the monthly data budget is used up (a dry run still returns its preview, with a warning that the real run will be refused) | `budget_exceeded` |
| 9 | Run the operation | its own errors, for example `suppressed`, `limit_reached` |
| 10 | Write the audit log (every non-read call, including failures and dry runs) | |
| 11 | Store the result under the idempotency key | |

Background jobs check again at the moment of acting: right before an email or a LinkedIn action goes out, its job runs the send gate, see [Checks before every send](#checks-before-every-send).

## Principals and scopes

| Principal | Who | Scopes |
| --- | --- | --- |
| `local-admin` | The CLI running in-process on your machine | All six |
| `local-agent` | An agent using stdio MCP (`openoutbound mcp` without `--url` and `--api-key`, embedded or bridged to a local `serve`; `OPENOUTBOUND_API_KEY` is not used there) | `OPENOUTBOUND_AGENT_SCOPES`, default `read,write,send,spend` (no `approve`, no `admin`) |
| API key | REST, HTTP MCP, and the CLI or `openoutbound mcp` given a key (`--api-key`, or `OPENOUTBOUND_API_KEY` where it counts, see [Security](../guides/security.md#api-keys-and-scopes)) | The key's scopes (agent keys default to `read,write,send,spend`, human keys to all six, service keys to `read,write`) |
| `system` | Background jobs and schedules | Internal; a job acts only in its own workspace |

Each operation has an effect, and the effect sets the scope it needs:

| Effect | Scope needed | Examples |
| --- | --- | --- |
| `read` | `read` | Lists, reports, `get_status` |
| `write` | `write` | Create a campaign, enroll leads, edit a draft |
| `destructive` | `write` | Delete a draft campaign, remove a mailbox |
| `send` | `send` | Launch or resume a campaign, send a reply, publish a post |
| `spend` | `spend` | Research, paid searches, running a monitor, campaign previews |
| `admin` | `admin` | Workspaces, keys, providers, webhooks, notifications |

A few operations need more than their effect implies: reading the audit log, API keys, webhooks and notification channels needs `admin`, and `workspaces.resume` needs `write` and `send`. Deciding approvals needs `approve`. The [REST reference](../reference/rest-api.md) lists the scopes of every operation. A missing scope fails with `forbidden` and `details.missing_scope` on every door.

API keys: only a person (the local CLI or a human key) can create a `human` key, a key never gets scopes its creator lacks, and a key bound to a workspace can only create keys for that workspace.

### Workspace boundaries

- A key created with a workspace (`openoutbound --workspace acme keys create ...`) is bound to it. `openoutbound mcp --workspace acme` binds the session the same way (embedded: the local agent, or the `--api-key` key; bridge: calls naming another workspace are refused before they leave your machine, and the server checks again). Over HTTP, the `OpenOutbound-Bind-Workspace` header binds a key for one request. `OPENOUTBOUND_WORKSPACE` and the `OpenOutbound-Workspace` header only set a default.
- A bound caller naming another workspace gets `forbidden` (`details.reason: workspace_scope`) on every door, and never learns whether that workspace exists.
- Operations without a workspace declare whether a bound caller may run them: `workspaces.list` and `sandbox.status` answer with its own workspace only; `workspaces.create` and `sandbox.seed` refuse it (`forbidden`, `details.reason: instance_only`).
- Background jobs act only in their job's workspace. A job payload naming another workspace is refused, and engine services (events, jobs, approvals) never write into another workspace from a workspace context.

## Approvals

When work needs a human, the engine stores an approval and returns `{ status: "awaiting_approval", approval_id, summary }` instead of doing it. Nothing happens until someone with the `approve` scope decides.

One rule decides who must ask for a gated change: a person holding `approve` (the local CLI, a human key with it) acts directly, and everyone else (agent and service keys, the local agent, people without `approve`) gets an approval request. The gated changes: launching a campaign, raising a mailbox's daily limit above 50 or turning off or shortening the ramp of a mailbox that is still warming, scheduling or publishing a LinkedIn post, sending a reply, changing the text of a campaign message, sending a message or post whose outcome is unknown again, applying a change proposal, lowering a campaign's review level, letting an automation enroll people without approval, and changing whom an automation that already does that enrolls (its filters or enroll actions). Raising safety never needs an approval. A setting that turns a gate off (`settings.approvals.agent_launch_requires_approval: false`, `settings.approvals.agent_changes: auto`) turns it off for everyone, so only a person holding `approve` may loosen one: turning `agent_launch_requires_approval` off, setting `agent_changes` to `auto`, lowering `approvals.default_review_level`, raising or removing `ai.monthly_budget_usd` or `data.monthly_credit_budget`, or setting a reply rule to `auto_reply`. Anyone else gets `forbidden` naming the fields, even with `admin`, and nothing changes (`manage_workspaces` action `update`, an undo, a setup import or a new workspace alike); the hint shows the proposal to make instead (`manage_strategy` action `propose`, operation `workspaces.update`), which a person approves, and for a budget it asks the human. Tightening them, and every other setting, works as before.

| Kind | Created when |
| --- | --- |
| `message` | A campaign message (email, LinkedIn note, message or comment) needs review under the campaign's review level, its text was changed by someone who must ask or into a text that fails its checks (`manage_messages` action `update`; the message goes back to `pending_review`, also after a person approved it), or someone who must ask wants to send a message whose outcome is unknown again (`resolve_unknown` outcome `resend`; it takes no edits) |
| `reply` | A drafted reply to a prospect waits for review, or someone who must ask sends a reply |
| `campaign_launch` | Someone who must ask launches a campaign and `settings.approvals.agent_launch_requires_approval` is true (default). Approving launches the campaign only as the request showed it: when its settings, steps, offer, senders or enrolled people changed since, the decision answers `conflict` and nothing launches; ask again |
| `enrollment` | A signal automation wants to enroll people and requires approval (the default for rules that enroll) |
| `lead_import` | A saved search in `ask_first` mode found leads to import, or own leads (source `leads`) to add to its list |
| `post` | A LinkedIn post is scheduled or published by anyone other than a human with the `approve` scope |
| `referral` | A reply points to someone else, and adding that person as a lead waits for a decision |
| `mailbox_limits` | Someone who must ask raises a mailbox's daily limit above 50, or turns off or shortens the ramp of a mailbox that is still warming. Approve (or edit `daily_limit` first) to apply it |
| `review_level` | Someone who must ask lowers a campaign's review level (`every` to `first` to `unsure`), or switches a LinkedIn comment step from `review: "always"` to `"level"` (the request names the step, which keeps `always` meanwhile). Approve (or, for a campaign's level, edit `review_level` first) to apply it; reject keeps the current review |
| `automation_approval` | Someone who must ask sets `require_approval: false` on a signal automation that enrolls people, or changes the filters or enroll actions of one that already enrolls without approval. The rule keeps asking before each enrollment (or keeps its filters and actions) until a person approves. The summary shows the rule's filters and actions, and a rule that changed since the request answers `conflict` |
| `change` | A change proposal waits for an owner: from someone who must ask unless `settings.approvals.agent_changes` is `auto`, and from anyone who lacks the operation's scopes. See [Change approvals](#change-approvals) |
| `custom` | Free for [custom modules](../extending/custom-modules.md); no built-in module creates it |
| `comment`, `spend` | Reserved; nothing creates them yet |

An approval applies what it showed. A launch or automation request stores a fingerprint of what it covers, and a decision on one whose campaign or rule changed since answers `conflict` and applies nothing: ask again, and the new request replaces the old one. The same request is never stored twice. When a pending approval with the same kind, target and payload exists, the engine returns it instead of creating a new one, so retries do not pile up. A new launch request for a campaign, or a new limits request for a mailbox, cancels the older pending one ("Replaced by a newer request.").

Review and decide:

```bash
openoutbound approvals list                           # pending, oldest first
openoutbound approvals list --status approved         # decided ones, newest first
openoutbound approvals get --approval-id apr_...      # the full payload: draft, why, checks
openoutbound approvals decide --approval-id apr_... --decision approve
openoutbound approvals decide --approval-id apr_... --decision edit --edits '{"subject":"...","body":"..."}'
openoutbound approvals decide --approval-ids apr_1,apr_2 --decision reject --note "Off-brand"
```

Agents use the `review_items` tool with the same actions. Decisions:

- **approve** runs the held action (schedule the email, launch the campaign, import the leads).
- **edit** approves with changed fields, only the ones the approval's kind allows (below). The target a request names never changes: an edit of any other field answers `validation_failed` and the approval stays pending.
- **reject** cancels it (a rejected campaign message is cancelled and its step skipped).

| Kind | Fields an edit may change |
| --- | --- |
| `message`, `reply` | `subject`, `body` (a `resend` takes none) |
| `post` | `body`, `scheduled_for` (a `republish` takes none) |
| `review_level` | `review_level` (a comment step's request takes none) |
| `mailbox_limits` | `daily_limit`, `ramp` |
| `change` | `input` |
| `referral` | `email`, `name`, `title`, `campaign_id` |
| `lead_import` | `candidate_ids`, `person_ids`: a shorter list of the requested ids, never others |
| `enrollment` | `person_ids`: a shorter list of the requested ids, never others |
| `custom` | The fields its module's resolver lists (`editable`) |
| `campaign_launch`, `automation_approval`, `comment`, `spend` | None: approve or reject |

Up to 100 approvals can be decided at once; each reports its own result. Pending approvals expire after `settings.approvals.expire_days` (default 7, from 1 to 90); expired ones cannot be approved. Every request and decision emits an event (`approval.requested`, `approval.decided`), so you can route them to Slack or your own tools.

Nobody approves their own request. Someone who must ask can never decide an approval they requested: its result answers `forbidden` with a hint to ask a person, even when their key holds `approve`. A person holding `approve` may decide requests they made themselves (for example the leads a saved search in `ask_first` mode found), since they could have acted directly. Requests the engine makes on its own (`system`, from jobs) can be decided by anyone with `approve`. An agent holds the plain keys it creates, so a request from a key an agent or service created, directly or further down the chain, counts as that agent's own: neither the agent nor any other key it created can decide it. Agent keys and the local agent have no `approve` by default; an owner who adds it (`OPENOUTBOUND_AGENT_SCOPES`, `--scopes`) lets the agent decide what others requested, never its own requests or those of keys it created.

## Change approvals

Agents change a client's strategy through proposals: `manage_strategy` action `propose` names the operation and input it would run (for example `campaigns.update` with a new review level), with a reason, evidence and the expected outcome. See [Strategy, changes and lessons](strategy.md#proposals).

- A proposal from a person holding `approve` applies at once. Anyone else's (agents, services, the local agent, the engine's own jobs, people without `approve`) waits for an approval of kind `change`, unless `settings.approvals.agent_changes` is `auto`. A proposal from anyone who lacks the operation's scopes always waits.
- The approval shows the operation, the input, the reason, the evidence and the expected outcome.
- **approve** runs the operation through the normal gate as the proposer (their name is on the change and in the audit log). **edit** runs it with a new input: pass the whole input as `edits.input`; an invalid input keeps the approval pending with the error. **reject** changes nothing.
- The person deciding needs the scopes the change needs, for example `admin` for workspace settings, besides `approve`.
- If the operation fails, the proposal is stored as `failed` with the error and nothing changed. A person holding `approve` who approves the `change` approval also approves the operation's own gate (a lower review level, a higher mailbox limit, settings that loosen a gate), so it does not ask twice. Only when nobody holding `approve` decided it (`settings.approvals.agent_changes: auto`, or a decider who must ask) does the operation still ask for its own approval, which the proposal then waits for; settings that loosen a gate are refused then.

```bash
openoutbound approvals decide --approval-id apr_... --decision edit --edits '{"input":{"campaign_id":"cmp_...","settings":{"review_level":"first"}}}'
```

Every applied change can be undone with `manage_strategy` action `undo`, and after `review_after_days` (default 14) the engine compares the numbers before and after and stores a verdict on the proposal.

## Review levels

Each campaign has a review level (default from `settings.approvals.default_review_level`, which defaults to `first`):

| Level | A written message needs approval when |
| --- | --- |
| `every` | Always |
| `first` | It is the first written message to this person in this campaign; later steps send on their own |
| `unsure` | The checker's verdict is not `pass`, or its confidence is below 0.7 |

Whatever the level, a message whose checks failed always goes to review, and so does a message whose text someone who must ask changed (`manage_messages` action `update`): it goes back to `pending_review` with a new approval, even when a person approved the earlier text, and nothing is sent meanwhile. A person holding `approve` who edits an approved message keeps it approved, unless the new text fails its checks. A LinkedIn comment step with `review: "always"` (the default) always goes to review; set `review: "level"` to let the campaign's level decide. That switch lowers review too: from anyone but a person holding `approve` it waits for a `review_level` approval naming the step, which keeps `always` until a person approves. Steps without text (visits, likes, invites without a note) never need review. See [Campaigns](campaigns.md).

## Dry runs

Operations that send, spend or change a lot support `dry_run`. A dry run validates everything, writes nothing, sends nothing, spends nothing and returns `{ dry_run: true, preview, estimated_cost, warnings }`.

| Operation | What the preview shows |
| --- | --- |
| `campaigns.launch` | The pre-launch checklist with a fix per failing item, volume and AI cost estimates |
| `campaigns.enroll` | Who would be enrolled and why each skipped person was skipped |
| `campaigns.preview` | The cost estimate before drafting sample messages |
| `research.run`, `research.search` | What would be researched, the estimated cost and what is left of the data budget |
| `signals.monitors.run` | Companies, providers, estimated credits and what is left of the data budget |
| `threads.send_reply`, `posts.publish` | What would be sent; for a reply also `blocked_reasons`, why it would be refused (`suppressed`) |
| `mailboxes.add`, `mailboxes.import_csv`, `mailboxes.remove`, `linkedin.accounts.remove`, `crm.sync` | What would be created, removed or pushed |
| `changes.undo`, `changes.propose` | The values an undo would restore; whether a proposal would apply at once or wait for an approval |

Use `--dry-run` in the CLI or `dry_run: true` in MCP and REST (body or query). Operations without a preview reject `dry_run: true` with `unsupported`, the same answer on every door, so a dry run can never do real work by mistake; reads ignore it. The lead operations add their own dry runs (imports, finds, enrichment); see [Lead sources](../guides/lead-sources.md).

## Idempotency

Retries are safe when you pass an idempotency key: the `Idempotency-Key` header over REST, `idempotency_key` in MCP and REST bodies, `--idempotency-key` in the CLI.

- The same key with the same input returns the first result without running again.
- The same key with a different input fails with `idempotency_mismatch` (HTTP 409).
- Keys are 1 to 200 characters, scoped to the workspace, and kept for 24 hours.
- A failed call releases its key, so you can retry it. Dry runs are never stored.

Agents should reuse the key when they retry a call that may have succeeded (a timeout, a dropped connection).

## Budgets

Two monthly budgets per workspace, counted per calendar month in UTC:

| Setting | Counts | Checked |
| --- | --- | --- |
| `settings.ai.monthly_budget_usd` | Dollars spent on AI brain calls with a known price: Anthropic models in the engine's price table, and OpenRouter (which reports its cost). Other brains count $0. | Before every brain call |
| `settings.data.monthly_credit_budget` | Credits used by data providers (searches, enrichment, research, signals) | Before every `spend` operation and inside jobs that use credits; where the cost is known up front, against what is left |

Both default to `null` (no limit). Only a person holding `approve` raises or removes one; anyone else gets `forbidden`, even with `admin`. When a budget is used up, calls fail with `budget_exceeded` and a hint to wait until next month or ask the human to raise it (an agent never raises its own budget). Dry runs still work: they return the preview and the estimated cost, with a first warning that the real run will be refused and why. Where the cost is known before spending (lead searches and imports, saved searches, each email finder or verifier call, each research web search, each paid signal provider call in a monitor), the engine compares it with what is left, so a run never ends above the budget: dry runs show `budget` (`monthly_credits`, `used_this_month`, `left_this_month`) with a warning when the cost does not fit, and the real call is refused with the numbers, for example `Not enough data budget: needs 10 credits, 8 left this month (8 of 16 used).`, and a hint (import fewer, or ask the human to raise the budget). A Google Maps search knows only the least it costs, because splitting a busy area takes more requests (up to `max_requests_per_search`), so it gets what is left as its request cap instead: it stops there with fewer results and a `next_cursor` to continue, and it is refused only when not even one request fits (`needs at least 1 credit`). Its dry run warns when what is left cannot finish it. The checks do not reserve credits, so two spends that start at the same moment can together go past the budget ([known gap](../roadmap.md#known-gaps)). `get_status` and the attention queue warn at 80%. Set them with:

```bash
openoutbound --workspace acme workspaces update --settings '{"ai":{"monthly_budget_usd":50},"data":{"monthly_credit_budget":2000}}'
```

The costs report shows where the money went. See [Reports](reports.md).

## The kill switch

`openoutbound workspaces pause --reason "..."` (MCP: `manage_workspaces` action `pause`) stops all sending in a workspace immediately:

- Queued emails, LinkedIn actions and automatic replies stay queued.
- Every `send` operation fails with `workspace_paused`.
- Reply sync, classification and research keep running, so you do not miss replies.

`openoutbound workspaces resume` continues within the normal limits and windows. Resuming needs the `send` scope. Finer switches exist too: pause one campaign (`campaigns pause`), one mailbox (`mailboxes pause`) or one LinkedIn account (`linkedin accounts pause`).

## Limits and suppression

Sending limits are applied when a message is planned: daily limits and ramps per mailbox and LinkedIn account, random gaps, sending windows in the lead's timezone, working days, holidays and blackout ranges. When no slot is free, the message waits for the next one instead of failing. An email sent again after an unknown outcome is planned the same way. Right before a message goes out, only some limits are checked again. An email checks its mailbox's daily limit and ramp, counting the emails the mailbox is still sending, and checks the send window (days, hours, holidays and blackouts) only when it is a campaign email more than 15 minutes late; the gap is not checked again. A LinkedIn action checks its account's working hours, caps and the gap since its last action. `limit_reached` appears when a request rate is exceeded or when no LinkedIn slot exists in the next three weeks; its hint says what to change.

Before any email or LinkedIn action, the engine checks that the person can be contacted: suppressions of the email, domain, LinkedIn profile, person or company; the person's and company's status (do not contact, unsubscribed, bounced, customer, competitor); a company hold, an open CRM deal or an account a sales rep owns (as the `crm.*` settings say); system addresses (postmaster, abuse, no-reply) and the email status against `settings.sending` (verified email, catch-all policy); excluded countries and the consent rules (consent-required countries, publication evidence, UK sole traders). A suppressed person fails with `suppressed`. Unsubscribes and hard bounces add suppressions automatically, and locked reply rules cannot be switched off. See [Inbox](inbox.md#the-action-matrix) and [Mailboxes](../guides/mailboxes.md).

## Checks before every send

Right before an email or a LinkedIn action goes out, its job runs one list of checks: the send gate. `explain_blocker` and `get_next_actions` run the same gate, so they show what the sender will do (see [Relationships](relationships.md#blockers)); they list every blocker, the sender stops at the first.

First the job looks at the message itself. One that is no longer `scheduled` is left alone. One found `sending` (an attempt that stopped mid-send) becomes `unknown` and is never sent blindly (see [Never sending twice](#never-sending-twice)); a LinkedIn visit or like found that way is done again, since repeating one is harmless (up to 3 attempts, then it fails).

For the first blocker the sender does one of five things:

| Outcome | What happens |
| --- | --- |
| Wait | The message stays queued. The job looks again when the reason ends (a resume, the end of a company hold, its time slot) or after a set time |
| Move | The message is planned again: on another of the campaign's mailboxes, or later on the same one. An email no other mailbox can take waits for its own mailbox instead. A LinkedIn action goes back to the queue until its account or workspace works again |
| Skip | The message becomes `skipped` with the reason, for example `not_contactable: suppressed_email`, and the sequence moves on |
| Cancel | The message becomes `cancelled` and the sequence moves on |
| Fail | The message becomes `failed` with the error. When retrying cannot fix it, it also counts in the campaign's `send_failed` problem ([Mailboxes](../guides/mailboxes.md#problems-in-the-attention-queue)) |

Skips, cancels and failures fire `message.failed`.

Emails, in this order:

| # | Check | When it fails |
| --- | --- | --- |
| 1 | The workspace is active | Wait for the resume, looking again every 30 minutes |
| 2 | The person still exists | Cancel: they were deleted or forgotten |
| 3 | Exactly one plain recipient address | Fail |
| 4 | The campaign is not paused, and a sequence step's campaign has not ended | Paused: wait for the resume; answers to prospects still go. Completed or archived: cancel the step |
| 5 | A sequence step's sequence still runs for the person | Stopped, completed or failed: cancel the step. Paused: wait until the pause ends, looking again every hour when it has no end. Replies and other emails that are not a step go out whatever the sequence does |
| 6 | Nobody took the thread over | Cancel automatic replies and sequence steps in the thread with `superseded_by_person`. Replies a person or an agent wrote or approved still go |
| 7 | The mailbox can send | Move to another campaign mailbox that can send. An email that cannot move (a reply in a thread, or no other campaign mailbox can send) waits until its mailbox sends again: a resume, a clean `mailboxes test` or an OAuth reconnect sends it, and it looks again at least every 6 hours while the mailbox is paused and once a day while it is in error or disconnected. A mailbox paused for its bounce rate or a provider block holds all its emails, even those that could move. An email whose mailbox was removed moves too, and fails when no other mailbox can take it. A throttled mailbox moves the email to later |
| 8 | The person can be contacted: suppressions of the address and domain, the [contactability rules](#limits-and-suppression) (with an email verifier set up, the first email in 30 days to an address last verified over 30 days ago verifies it again), an open privacy request | Skip with `not_contactable: <codes>`. A company hold with an end date, and nothing else, waits until the hold ends |
| 9 | Inside the send window, for a campaign email more than 15 minutes late | Move to the next opening, same mailbox |
| 10 | Room in the mailbox's daily limit, ramp included | Move to the next free slot, same mailbox |
| 11 | A new thread has a subject | Fail |
| 12 | The unsubscribe link works: `OPENOUTBOUND_BASE_URL` is a public https address. Replies to people who wrote to you and sandbox email skip this check | Wait, looking again every 30 minutes, and open one `sending_blocked` problem for the workspace that says what to do. It resolves once such an email goes out with its link again |

A reply stops at check 8 only for opt-outs, suppressions, do not contact, bounces, bad data and an open privacy request. Consent-country and catch-all rules, and the company rules (a hold, an open CRM deal, an owned account), never block an answer to someone who wrote to you.

Then the email is written: an empty body, or a template variable with no value, fails it too. Last comes the claim: only a `scheduled` message becomes `sending`, so two workers never send the same email. The claim takes a lock on the mailbox and checks its daily limit once more, counting the emails it is still sending, so sends that run at the same time never go past it; without room the email is planned again as at check 10. The send itself must finish within 90 seconds, waiting for the mailbox's connection included: when it runs out of time, or its job ends first, the engine closes the connection, and the email becomes `unknown` when its data may have reached the server, or is tried again when it cannot have. An email whose outcome is `unknown` keeps its place in the mailbox's daily limit until it is settled, so the planner never gives that place away.

LinkedIn actions, in this order:

| # | Check | When it fails |
| --- | --- | --- |
| 1 | The workspace is active | Paused: wait for the resume, looking again every hour. Archived: back to the queue |
| 2 | The campaign is not paused, and a sequence step's campaign has not ended | Paused: wait for the resume. Unlike email, this also holds answers in a LinkedIn conversation that belongs to the campaign. Completed or archived: cancel the step |
| 3 | The action's time slot has come | Wait for it |
| 4 | A sequence step's sequence still runs for the person | Cancel the step or wait, as for email |
| 5 | Nobody took the conversation over | Cancel with `superseded_by_person`, as for email |
| 6 | The account exists and is active | Back to the queue while it is paused, restricted or disconnected. Fail when it was removed |
| 7 | The action names a person | Fail |
| 8 | The person can be contacted, and no privacy request is open | Skip. An answer in a conversation is never held back by a company hold, an open CRM deal or an owned account. A company hold with an end date, and nothing else, waits until it ends |
| 9 | The person's record still exists | Fail |
| 10 | The relation fits: a LinkedIn profile, no connection or pending invitation before an invitation, no invitation within 30 days of a withdrawal, a connection before a message | Skip |
| 11 | The text: an invitation note within its limit, a message or comment that is not empty, a comment of at most 1,250 characters | Fail |

Then, under a lock on the account, the job checks working hours, the caps and the gap since the last action, and waits for the next free slot when there is no room. The provider can still skip the action: already connected or invited, or no recent post to like or comment on.

## Never sending twice

Every outbound action is handed to its provider at most once per attempt, and a new attempt starts only with proof or a decision. [Delivery guarantees](delivery-guarantees.md) states the rule in full, boundary by boundary, with the test that proves each case.

Sends are claimed once: only a `scheduled` message becomes `sending`, so two workers never pick up the same one, and every claim starts a new attempt. A result is recorded only while the message still holds the claim of its own attempt. A job that finds its message already `sending` (an earlier attempt stopped mid-send) marks it `unknown` instead of sending it again.

When a send gets no clear answer (a timeout or a dropped connection after the email was handed over, an email send stopped at its 90-second deadline after its data may have reached the server, a timeout, a server error or an unreadable answer from the LinkedIn provider once an invitation, message or comment was sent to it, or a worker that stopped mid-send), the engine cannot tell whether it arrived, so it marks the message `unknown` (event `message.unknown`) and never retries it blindly. Errors that happen before anything was handed over are retried on the same message as usual; for LinkedIn that includes a rate limit, a refusal, a connection that never opened, and a failure while reading the profile before an invitation or the posts before a comment. A message becomes `failed` only when it did not go out, and an answer that took it without an id counts as sent.

Unknown sends are then checked. One goes out once more on its own only with proof that the first try did not arrive:

- **Email:** the `email.reconcile_sends` job (every 10 minutes) looks for the Message-ID in the mailbox's Sent folder. Found means sent. After 3 lookups without a copy, the email is sent once more only when the mailbox is proven to keep copies of what it sends (the engine found one of its own emails in its Sent folder), since only then does a missing copy prove it never left. Otherwise a person decides. The second try is planned like any send (inside the send window, within the daily limit), and a copy of the first try that turns up while it waits still marks the email sent and drops the second try.
- **LinkedIn invitations:** checked on the person's live profile. A pending invitation or a connection means it went out; nothing after 3 lookups means it did not, and it is sent once more. When that resend finds the invitation pending or the person connected after all, it is recorded as sent, not skipped.
- **LinkedIn messages and comments:** a person decides. When the provider can read recent messages, the same text sent in the person's own conversation confirms a message. Neither is sent again on its own.
- **LinkedIn posts:** a post that got no clear answer becomes `unknown` too, and a person settles it with `manage_posts` action `resolve_unknown` (see [LinkedIn](../guides/linkedin.md#posting)).

The engine never makes more than one automatic extra attempt. When it cannot tell, it opens a `send_unknown` problem for a person, who checks the Sent folder or the conversation and settles it with `manage_messages` action `resolve_unknown` (`sent`, `resend` or `cancel`). Resending by hand needs the `send` scope, and anyone but a person holding `approve` gets an approval of kind `message` instead: the message stays `unknown` and nothing is queued until a person approves it. A second try, automatic or by hand, runs the checks of any send: a sequence step whose sequence was stopped, whose campaign ended or whose thread a person took over meanwhile is cancelled instead. Details: [Mailboxes](../guides/mailboxes.md#sends-with-an-unknown-outcome) and [LinkedIn](../guides/linkedin.md#when-linkedin-gives-no-clear-answer).

Nothing goes out twice without a record. When the late answer of an earlier attempt says a message went out after it was sent again, the engine records a duplicate: the event `message.duplicate`, a `duplicate_send` problem that tells a person there is nothing to undo, and a count in the campaign report's `duplicates`. When the message was `unknown`, `failed`, queued again or back in review instead, it simply becomes `sent`, and an approval still asked for about it is cancelled. A failed campaign step gets a new message only when the failed one did not go out, or was a visit or like, which is harmless to repeat.

A move to another mailbox or a later time changes only a message that is still `scheduled`, so it never brings back one that was cancelled meanwhile. A `scheduled` email whose send job was lost (cancelled, or stopped without settling it) is queued again by `email.reconcile_sends` 15 minutes after its time. A reply asked for twice (the same text in the same thread within 24 hours, for example by an agent retrying after a timeout) returns the first one instead of making a second; calls on one thread take turns, so this holds for two calls at the same moment too.

## The audit log

Every non-read call is recorded, including failures, dry runs and calls that ended in an approval: when, who (actor type, id, name), through which door, which operation and effect, the target record, the `reason` the caller gave, the outcome and the error code. Inputs are stored redacted: fields that look like secrets become `[redacted]`, long text is cut at 500 characters. `leads.forget` stores `[erased]` instead of the email and LinkedIn URL it was given (in its input, `reason` and error message), and replaces the forgotten person's address in older entries too ([Security](../guides/security.md#data-protection-and-gdpr)).

```bash
openoutbound audit list --operation approvals.decide
openoutbound audit list --actor-id local-agent --since 2026-09-01T00:00:00Z --response-format detailed
```

Reading the audit log needs the `admin` scope. The maintenance job does not prune it. Agents are asked to pass a one-sentence `reason` with every change, so the log reads like a diary.

## Untrusted content

Text that comes from outside (inbound emails, LinkedIn messages, web pages, imported rows) is untrusted. The engine handles it in three ways:

1. **In prompts**, it is wrapped in `<untrusted_content source="...">` blocks, and the system prompt tells the model to treat it as data and never follow instructions inside it. Closing tags inside the text are neutralized so it cannot break out of the block.
2. **Models that read untrusted text have no tools.** They return schema-checked data only (a classification, a brief, a draft), so an instruction hidden in a reply cannot trigger an action.
3. **In tool outputs**, fields that carry inbound text are marked `untrusted: true`, and tool descriptions tell agents not to follow instructions found in them.

Replies that look like prompt injection or data requests are also flagged for a human by the inbox before any draft is sent. The sandbox includes a prompt-injection reply so you can watch this work. See [Security](../guides/security.md#prompt-injection).

## Outbound fetching

Every URL that comes from data (company websites, feeds, webhook targets) is fetched through a safe fetcher:

- Only `http` and `https`. Private, loopback, link-local, carrier-grade NAT and reserved addresses are blocked after DNS resolution and again on each redirect; cloud metadata addresses are always blocked.
- At most 5 redirects, 15 seconds, 5 MB.
- It identifies itself as `OpenOutboundBot/<version> (+https://github.com/xyluxx/openoutbound)` and honors `robots.txt` (cached for 24 hours) when crawling.
- A `429` backs the host off until its `Retry-After`.

`OPENOUTBOUND_ALLOW_PRIVATE_NETWORK=true` lifts the private-address block for self-hosters who need internal webhooks.

## Rate limits

The HTTP server allows 600 requests per minute per API key by default (`openoutbound serve --rate-limit <n>`). Over the limit it answers `429` with `Retry-After`.

Next: [Workspaces](workspaces.md) · [Campaigns](campaigns.md) · [Inbox](inbox.md) · [Security](../guides/security.md)
