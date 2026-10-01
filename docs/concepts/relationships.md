# Relationships

This page explains how OpenOutbound sees each person: where the relationship stands, the one thing that happens next, what blocks it and how to fix that, when a relationship is stuck, the problems list, and the four operator tools an agent uses to run the day.

## One view per person

For every person the engine answers four questions:

| Field | Answers |
| --- | --- |
| `state` and `state_since` | Where the relationship stands, and since when |
| `next_action` | The one thing that happens next: what, when, on which channel, and why |
| `blockers` | Why that next thing cannot happen now, each with the fix |
| `stuck` and `stuck_reason` | Whether the relationship stopped moving without anyone noticing |

Ask for it with `explain_blocker` (`person_id`), CLI `operating explain --person-id pe_...`. Resolving a problem about a person returns the same view, so you see at once what happens now.

## States

The first state that applies wins, in this order:

| State | In plain words |
| --- | --- |
| `stopped` | Never contacted again: their address, domain, LinkedIn profile, person or company is suppressed, they opted out, bounced or are marked do not contact, the company is marked do not contact, or a privacy request is open |
| `won` | An opportunity was won, or the person is a customer |
| `meeting_scheduled` | A meeting is booked and has not happened yet |
| `meeting_held` | A meeting took place: marked held, or assumed held after `booking.assume_held_after_hours` |
| `in_conversation` | They wrote back (interested, a question, an objection and similar), a person took over the conversation, or an opportunity is at the interested stage |
| `not_now` | They said "not now" and a follow-up task is open |
| `waiting` | Something waits on purpose: a message for approval, a paused sequence or one waiting for a review, or a hold on the whole company |
| `in_sequence` | A sequence is running |
| `lost` | An opportunity was lost, or they said they are not interested |
| `finished` | Their last sequence ended, or they were contacted before and nothing runs now |
| `new` | Never contacted |

Workspaces from before meeting records existed still work: without meeting records, the booked and held states come from opportunities.

## The next action

The next action is the earliest of these, with the one closest to going out first when two share a time:

| Kind | Example reason |
| --- | --- |
| `send_message` | An email (campaign Q4 distributors) is scheduled for tomorrow 13:00 UTC. |
| `review` | A message waits for approval; the reference is the approval to decide. |
| `send_draft` | A reply draft is ready and nobody sent it yet. |
| `write_message` | A message is being written. |
| `campaign_step` | Step 1 (LinkedIn invitation) of campaign LinkedIn first is due today 18:00 UTC. |
| `task` | Promise: Send the case study (due today 20:00 UTC). |
| `meeting` | The next booked meeting. |

Times are in the workspace timezone.

## Blockers

A blocker says why the next thing cannot happen now. Every blocker has the same five fields:

| Field | Meaning |
| --- | --- |
| `code` | Stable machine code, for example `daily_cap_reached` |
| `message` | Plain words, for example "Mailbox sam@harbor.example.org hit its daily cap of 40. Next try tomorrow 13:00 UTC." |
| `until` | When it clears by itself, or null |
| `fix` | The exact tool and action that fixes it, or null when nobody needs to act |
| `hard` | true when waiting will not clear it: a person or the agent must act |

The sender and the view share one gate. The email send job and the LinkedIn action job run the send gate right before they act, and the view runs the same gate: the same checks, in the same order, with the same functions. The sender stops at the first blocker and waits, moves, skips, cancels or fails the message ([Safety and approvals](safety-and-approvals.md#checks-before-every-send)); the view lists every blocker and reserves nothing. The tests put the view and the real senders in the same situations and require the same answer and the same next time.

Common blockers:

| Code | Clears by itself | Fix |
| --- | --- | --- |
| `workspace_paused` | No | `manage_workspaces` action `resume`, once the reason for the pause is fixed |
| `campaign_paused` | No | `launch_campaign` action `resume` |
| `suppressed_email`, `suppressed_domain` | No | Only if it was a mistake: `manage_suppressions` action `remove` |
| `person_do_not_contact`, `company_do_not_contact` | No | None: they asked not to be contacted |
| `company_on_hold` | Yes, when the hold ends | `manage_leads` action `release_company` to end it early |
| `company_open_deal` | No | Close the deal in the CRM, or, if reps agree, ask the human to set `crm.allow_outreach_with_open_deal` (an agent suggests it with `manage_strategy` action `propose`) |
| `company_owned` | No | If reps agree, ask the human to set `crm.skip_owned_accounts` to false (an agent suggests it with `manage_strategy` action `propose`) |
| `approval_pending` | No | `review_items` action `decide` |
| `send_unknown` | No | Check the Sent folder or LinkedIn, then `manage_messages` action `resolve_unknown` |
| `mailbox_paused` | Only when the engine paused it for its health; the email moves to another campaign mailbox when one can take it | Fix the cause, then `manage_mailboxes` action `resume` |
| `mailbox_throttled` | Yes | None |
| `daily_cap_reached`, `mailbox_warming`, `no_capacity` | Yes, when there is room again | None; to send more a day, add a mailbox with `manage_mailboxes` action `add` |
| `outside_window` | Yes, when the window opens | None; if the window is wrong, `create_campaign` action `update` |
| `unsubscribe_link_missing` | No | Set `OPENOUTBOUND_BASE_URL` to the engine's public https address and restart `openoutbound serve` |
| `linkedin_account_restricted` | No | Check the account on LinkedIn, then `manage_linkedin` action `resume` |
| `linkedin_outside_hours`, `linkedin_cap_reached` | Yes, at the next free slot | None |
| `not_connected` | Yes if an invitation is pending, else no | Send a connection invitation first |
| `thread_owned_by_person` | No | Answer yourself, or `reply_to_thread` action `release` |
| `privacy_request_open` | No | Answer the request; a deletion closes with `manage_leads` action `forget`, any other request with `resolve_exception` action `resolve` |
| `ai_budget_used_up` | Yes, next month | Wait, or ask the human to raise `ai.monthly_budget_usd` |

Every blocker's own `fix` names the ids to use. A message that is already closed (skipped, cancelled, failed or bounced) shows the reason stored when it closed, in the same words. There is no "unknown reason": when nothing blocks a message, the answer says so and says when it goes out.

## Stuck relationships

Every 15 minutes, per workspace, the job `relationships.stuck_check` looks for relationships that stopped moving:

| Rule | Stuck when | Severity |
| --- | --- | --- |
| `hot_reply_unanswered` | An interested or meeting-request reply from the last 30 days has had no answer drafted or sent for 24 hours, and no meeting was recorded for the person since. In a conversation a person took over, the problem is theirs (owner `person`) and reminds them to answer | high |
| `active_no_next_step` | An active enrollment in an active campaign has no message queued, and its step is not scheduled or was due over 6 hours ago and never ran. Skipped while the workspace is paused | normal |
| `approval_waiting` | An approval has waited for a decision for over 72 hours | normal |
| `meeting_unmarked` | A meeting started over 48 hours ago and is still marked scheduled, when `booking.assume_held_after_hours` is 0 | normal |

Each case opens one `stuck` problem with its reason and remedy, and never a second one for the same case. The reason gives times as dates, not "hours ago", so a problem that is still true keeps its words and the job leaves it untouched. When the condition clears, the job resolves the problem by itself with a note saying what changed. People nobody may contact any more (a privacy request, an opt-out, do not contact, a suppression of the person or company) are left out, and their open stuck problems resolve with "The person may not be contacted any more." A run opens at most 200 problems per rule; the rest follow on the next run.

## Problems

A problem is something that needs a person or the agent: a privacy request, a send with an unknown outcome, a mailbox or LinkedIn account that stopped sending (`mailbox_down`), messages that failed for good (`send_failed`), a stuck relationship, a meeting to book, an outage. Each has a severity (`urgent`, `high`, `normal`, `low`), an owner (`person`, `agent` or `anyone`), a title, a reason, a remedy naming the tool to use, and sometimes a due date.

| Kind | Opened when | Severity | Owner |
| --- | --- | --- | --- |
| `privacy_request` | A prospect asks to delete their data, to see it, or where it came from ([Inbox](inbox.md#privacy-requests)) | urgent | person |
| `send_unknown` | The engine cannot tell whether an email, a LinkedIn action or a LinkedIn post went out ([Delivery guarantees](delivery-guarantees.md)) | high | person |
| `mailbox_down` | A mailbox or LinkedIn account stops sending because of an error: a refused login, a lost connection, a pause for its bounce rate, a provider block, a failure streak, a LinkedIn restriction. Never for a pause a person made. A mail server that refuses the IMAP login, or a message the sync could not store in 3 syncs in a row, opens a second one for the mailbox (key `mailbox_down:<mailbox_id>:read`): replies are not read, sending is not affected ([Mailboxes](../guides/mailboxes.md#problems-in-the-attention-queue)). A LinkedIn account whose sync failed 5 times in a row gets the same kind of problem for reading (key `mailbox_down:<account_id>:read`, [LinkedIn](../guides/linkedin.md#when-a-sync-fails)) | high | person |
| `send_failed` | Messages failed for good, one problem per campaign (or conversation) and cause, with the count ([Mailboxes](../guides/mailboxes.md#problems-in-the-attention-queue)) | normal | anyone |
| `meeting_to_book` | A prospect proposed a time, or asked for a meeting with no booking link to offer ([Inbox](inbox.md#the-engine-never-confirms-a-time)) | high in `handoff` mode or without a link, else normal | anyone |
| `unmatched_booking` | A booking came from someone who is not a lead ([Meetings](../guides/meetings.md#record-a-meeting-by-hand)) | normal | person |
| `stuck` | A relationship stopped moving (the rules above) | high for a hot reply, else normal | anyone; person for a hot reply in a conversation a person took over |
| `promise_overdue` | Something we promised in a reply is more than a day overdue ([Lead file](lead-file.md)) | normal | person |
| `company_hold_suggested` | A reply suggests that nobody at the company should hear from you until a date ([Lead file](lead-file.md#company-holds)) | normal | anyone |
| `dns_failed` | The daily DNS check finds a record (MX, SPF, DKIM or DMARC) that stopped passing, or MX or SPF newly red ([Mailboxes](../guides/mailboxes.md#daily-dns-check)) | high | person |
| `brain_down` | The AI brain fails in a way retrying cannot fix: a rejected key, a used-up quota, a missing model or CLI, or no brain configured at all ([AI brain](../guides/ai-brain.md)) | high | person |
| `crm_sync_failed` | The CRM rejects writes for good or keeps failing ([CRM](../guides/crm-and-notifications.md#when-a-sync-fails)) | high | person |
| `crm_forget` | A forgotten person still has a record in the CRM ([CRM](../guides/crm-and-notifications.md#forgotten-people)) | normal | person; agent for records the agent linked |
| `provider_down` | A provider rejects its credentials, is out of credits or quota, lacks a permission this needs, or fails 5 times in a row. Calls to it pause until it is fixed, except when it only keeps failing ([Provider failures](provider-failures.md#paused-providers)) | high; normal while it only keeps failing | person |
| `duplicate_send` | An email, a LinkedIn action or a LinkedIn post went out twice (or may have): an answer that came late showed that an earlier attempt arrived after the engine had sent it again ([Delivery guarantees](delivery-guarantees.md#duplicates)) | normal | person |
| `sending_blocked` | Emails are held because their unsubscribe link would not work: `OPENOUTBOUND_BASE_URL` is not a public https address. One per workspace; replies to people who wrote to you still go out ([Safety](safety-and-approvals.md#checks-before-every-send)) | high | person |
| `custom` | Anything without a kind of its own. The engine uses it for a notification channel whose last 5 deliveries failed, one problem per channel (key `notification_failing:<channel_id>`) ([CRM and notifications](../guides/crm-and-notifications.md#when-a-channel-fails)) | high | person |

Most problems resolve by themselves once the cause is gone: a booking resolves its `meeting_to_book`, a successful write its `crm_sync_failed`, a passing DNS check its `dns_failed`, a working brain its `brain_down`, a provider that answers again, gets new credentials or passes its test its `provider_down`, a sender that sends again its `mailbox_down`, a mailbox that is read again its `mailbox_down` for reading, a notification that goes through its channel's `custom` problem, an email that goes out with its unsubscribe link again its `sending_blocked`. A `send_failed` problem stays until you resolve it after the fix.

- **See them.** `get_attention_queue` shows the top 20 open problems, most severe first. The full list is `resolve_exception` action `list` (CLI `problems list`, REST `GET /v1/problems`), with filters for status, kind and person; action `get` shows one problem with the facts its remedy refers to (`data`).
- **Resolve.** Do the remedy, then `resolve_exception` action `resolve` with a short note. When the problem is about a person, the answer includes their fresh relationship view: the new next action and anything still blocking it. A problem the engine still detects opens again at its next check: a stuck relationship within 15 minutes, an overdue promise, a DNS record that stops passing, a failing AI model or CRM sync. A `send_unknown` problem is not resolved here while its outcome is unknown: settle the message with `manage_messages` action `resolve_unknown`, or the post with `manage_posts` action `resolve_unknown`, which closes the problem too. A request to delete a person's data is not resolved here while the person is still stored: `manage_leads` action `forget` closes it. Only a caller with the `admin` scope may close it without the forget, with a note saying why the data is kept. Resolving a privacy request never lists what still blocks the person, and nothing suggests lifting the suppressions of someone who made a privacy request.
- **Snooze.** `resolve_exception` action `snooze` hides a problem until a time, at most 90 days ahead and at most 24 hours for an urgent problem. After that time it counts as open again. A snooze never ends after the problem's due time, so a privacy request cannot be snoozed past its deadline, and an overdue problem cannot be snoozed at all.

## The operator tools

Four tools in the core toolset let an agent run the day. The first three only read.

| Tool | Operation | Use it to |
| --- | --- | --- |
| `get_operating_state` | `operating.state` | See the whole workspace in one call: campaigns by status, today's sending against capacity, hot replies and drafts waiting, this week's meetings, open problems, pending approvals, brain health, budgets and the last three configuration changes |
| `get_next_actions` | `operating.next_actions` | See what happens in the next hours (default 24, up to 168): scheduled messages, due sequence steps, tasks and meetings in time order, with overdue items first (up to 7 days late; `explain_blocker` still explains older ones, and the attention queue counts every overdue task and lists the oldest) and every blocked item listed with its blockers |
| `explain_blocker` | `operating.explain` | Ask why one message has not gone out (`message_id`) or where one person stands (`person_id`) |
| `resolve_exception` | `problems.list`, `problems.get`, `problems.resolve`, `problems.snooze` | List problems, read one with its facts, and close or snooze a problem after doing its remedy |

`get_next_actions` checks blockers for the items on the page only. Each sequence step on the page is planned the way the sequencer would plan it, so page with `cursor` rather than asking for 100 items at once. `get_operating_state` uses a fixed number of aggregate queries, whatever the size of the workspace.

A good daily loop: `get_operating_state` for where things stand, `get_attention_queue` for what needs a decision, `get_next_actions` for what the engine will do, `explain_blocker` for anything that looks wrong, and `resolve_exception` once each problem is handled.

Next: [Reports](reports.md) · [Inbox](inbox.md) · [Campaigns](campaigns.md) · [Safety and approvals](safety-and-approvals.md)
