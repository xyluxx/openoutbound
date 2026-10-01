# Inbox

This page explains what happens when a prospect answers: how replies are matched, classified and acted on, when a reply is drafted or sent, and how opportunities, meetings and tasks come out of it.

## From reply to action

1. **Sync.** Email replies arrive through IMAP sync every 5 minutes (see [Mailboxes](../guides/mailboxes.md#reply-sync-and-bounces)); LinkedIn messages through the LinkedIn sync and webhook (see [LinkedIn](../guides/linkedin.md)). Bounces, unsubscribe requests, auto-replies and warmup mail are recognized on the way in; an opt-out that also asks about their data, and privacy wording in mail with auto-reply headers, go on to classification as a privacy request.
2. **Thread.** The reply joins its thread and fires `reply.received`. The person's campaign enrollments pause while the reply is handled.
3. **Classify.** The job `inbox.classify` sorts the reply into one category with a confidence.
4. **Act.** The category's rule (the action matrix below) decides: stop, suppress, create an opportunity, draft a reply, create a task, or hand the thread to a human.
5. **Reply.** A drafted reply waits for approval, or, only when you allowed it and every check is confident, goes out by itself after a human-like delay.

## Classification

| Category | Meaning |
| --- | --- |
| `interested` | Wants to know more or talk |
| `meeting_request` | Asks for a meeting or proposes a time |
| `question` | Asks something about the offer |
| `objection` | Pushes back (price, timing, has a tool) |
| `not_now` | Not now, maybe later |
| `referral` | Points to someone else |
| `wrong_person` | Not the right contact |
| `out_of_office` | Away, often with a return date |
| `unsubscribe` | Asks to stop |
| `privacy_request` | Asks to delete their data, to see the data you hold, or where you got their details |
| `bounce` | Delivery failure |
| `negative` | Angry or hostile |
| `auto_reply_other` | Other automatic replies (ticket systems, "we got your message") |
| `other` | Anything else |

Before the model runs, simple checks catch delivery failures (`bounce`), privacy requests (`privacy_request`) and unsubscribe wording (`unsubscribe`) with confidence 1. A reply that asks to delete their data, to see it or where it came from is a privacy request even when it also asks to unsubscribe; "remove me" or "stop emailing me" alone stays `unsubscribe`. The model can only make mail with auto-reply headers `out_of_office`, `auto_reply_other`, `bounce` or `unsubscribe`: a plain automatic reply (a privacy policy footer, a ticket confirmation) is never a privacy request, whatever the model says. Privacy wording the prechecks find ("please delete my data") is one even with auto-reply headers, to be safe: the problem then says so, for a person to check that someone wrote it. The classifier prompt (`inbox.reply.classify`, tier `fast`) also extracts a summary, the return date, a follow-up date, the question asked, whether the person left the company, a meeting time they proposed, what a privacy request asks, up to 5 short business facts, and a suggested hold for the whole company ("signed with a competitor until 2027"). Facts and hold suggestions are information for the lead file, never instructions.

The prechecks also look for:

- **Prompt injection.** Text aimed at an AI ("ignore all previous instructions ...") marks the reply suspicious. A suspicious reply gets only the protective actions (unsubscribe, privacy request, bounce), no draft, no facts and no other action, and the thread is flagged `possible_prompt_injection` for a human.
- **Topics that always need a human:** the prospect asks whether they talk to a bot, legal questions, data requests (GDPR), security reviews and press. These never get an automatic reply.

A classification with confidence below 0.7 flags the thread for a human (`low_confidence`). You can correct a category with `threads update --category ...`, which runs the new category's actions.

## The action matrix

Each category has a rule in `settings.replies` (workspace) that a campaign can override for unlocked categories. Locked rules cannot be changed by anyone.

| Category | Default action | Locked | What it does |
| --- | --- | --- | --- |
| `interested`, `meeting_request` | `opportunity_and_draft` | no | Creates an opportunity at stage `interested`, notifies you now, drafts a reply for review that offers your booking link (see [booking modes](#booking-modes)) |
| `question`, `objection` | `draft_reply` | no | Drafts a reply from the knowledge base for review |
| `not_now` | `stop_and_follow_up` | no | Stops the sequence, creates a follow-up task for the date they gave (or in 90 days), drafts a short reply for review |
| `referral` | `approve_referral` | no | Asks for approval (kind `referral`) to add the referred person and enroll them in the same campaign, with every enrollment check; creates a task instead when there is no address |
| `wrong_person` | `stop_and_suggest` | no | Stops the sequence and creates a task listing up to 3 colleagues who may fit better |
| `out_of_office` | `pause_until_return` | no | Pauses the sequence until the first working day after the return date (7 days when no date is given, at most 180) |
| `unsubscribe` | `suppress` | yes | Suppresses the address and the person (and the LinkedIn profile when the answer came on LinkedIn), stops every enrollment of the person |
| `privacy_request` | `privacy` | yes | Suppresses the address, the person and the LinkedIn profile, marks the person do not contact, stops every enrollment, cancels unsent messages and their approvals, flags the thread, opens an urgent problem with the deadline and notifies you at once; never answered automatically, you answer the request ([Privacy requests](#privacy-requests)) |
| `bounce` | `mark_invalid` | yes | Marks the address invalid, suppresses it, stops enrollments. A bounce that refused our sender instead (blocklist, authentication, reputation, rate limit) leaves the person alone: only the sending mailbox's health changes, as for [bounces the sync recognizes](../guides/mailboxes.md#reply-sync-and-bounces), and the thread is flagged `sender_rejected` |
| `negative` | `notify_human` | yes | Stops every enrollment of the person (colleagues too with `stop.on_company_reply`), suppresses the address and the person (and the LinkedIn profile on LinkedIn), notifies you; never answered |
| `auto_reply_other` | `ignore` | no | Resumes the sequence (or stops it and creates a task when the person left the company) |
| `other` | `human` | no | Flags the thread for a human |

Other actions you can assign: `auto_reply` (draft and send without review when confident), `draft_reply`, `human`, `ignore`, `notify_human`. Swapping a default for `auto_reply`, `draft_reply` or `opportunity_and_draft` changes only how the prospect is answered: `not_now` still gets its follow-up task, `referral` its approval and `wrong_person` its better-contact task.

For other real (not automatic) replies the campaign's stop rules apply: with `stop.on_reply` on, the person's enrollments stop, and with `stop.on_company_reply` on, their colleagues' enrollments stop too. Unsubscribe, privacy request, bounce and negative replies stop the person's enrollments whatever these settings say. See [Campaigns](campaigns.md#what-stops-a-sequence).

**Questions the knowledge base cannot answer.** When a `question` finds no match in the knowledge base, no draft is written. The engine opens a knowledge gap (`knowledge.gap_opened`) and flags the thread `question_not_in_knowledge`. Answer the prospect yourself and add the answer to the knowledge base so the next draft can use it.

Change a rule for the whole workspace:

```bash
openoutbound --workspace acme workspaces update --settings '{"replies":{"question":{"action":"auto_reply"}}}'
```

## Privacy requests

A privacy request asks to delete their data (kind `delete`), to see the data you hold (`access`), or where you got their details (`source`). The prechecks know the common wording in English and German, such as "delete my data", "what data do you hold on me", "where did you get my email", "Löschen Sie meine Daten" or "woher haben Sie meine Daten"; the model catches the rest. The engine never answers a privacy request itself, and it acts the same way for a suspicious reply.

| Step | What happens |
| --- | --- |
| Block | Suppresses the address, the LinkedIn profile and the person (reason `do_not_contact`, note `Privacy request (reply msg_...)`) and sets the person to `do_not_contact` |
| Stop | Stops every enrollment, cancels every unsent engine message and its pending approval; no draft is written |
| Close | Skips the person's open tasks (calls, manual steps, follow-ups, promises) and resolves the problems that prompt contacting them (`meeting_to_book`, `promise_overdue`, `stuck`) with resolution `privacy_request` |
| Problem | Opens one urgent `privacy_request` problem for a person, due at the earlier of one calendar month and `compliance.privacy_response_days` (default 30) after it arrived, in UTC (received 1 Feb: due 1 Mar) |
| Tell | Fires `privacy.requested` and notifies you with the deadline |

The request belongs to whoever wrote it. When someone else writes in a lead's thread (a colleague answering all), the engine blocks, stops and closes both the sender (their address, and the person holding it) and the lead, as the request may be about the lead too; the problem, its next step and the event name the sender, and the problem asks you to check whether the request is also about the lead.

The problem names who asked, what and when, the deadline, and where their data came from, for example "Apollo, a business contact database, on 3 Sep 2026", "a contact list (clinics.csv) imported on 1 Sep 2026" or "your company website (https://...)". It also gives the next step and a suggested reply to send from your own mail app:

| Kind | Next step | Suggested reply |
| --- | --- | --- |
| `delete` | Reply, then `manage_leads` action `forget` with the `person_id`, first with `dry_run`; the forget resolves the problem | "Hi Dana, understood. I am deleting your details now and you will not hear from us again." |
| `access` | Look at `get_lead` with `response_format` detailed and send them what you hold | "Hi Dana, here is the information we hold about you: (fill in from the lead record)." |
| `source` | Reply with where their details came from | "Hi Dana, we found your business email address through (the source). Let me know if you would like me to delete it." |

**Reminders.** The daily job `inbox.privacy_reminders` notifies you once when 7 days or fewer remain, and every day once the deadline has passed; the problem title then starts with "Overdue:". Resolved problems get no reminders, and snoozed ones wait until the snooze ends. `forget` resolves the problem for you (resolution `forgotten`); after an access or source answer, resolve it yourself. A deletion request cannot be resolved while the person is still stored: forget them instead. When their data must be kept (a legal duty to keep invoices, say), a person with the `admin` scope resolves it from the CLI with a note saying why (`openoutbound problems resolve --problem-id pb_... --resolution "..."`).

## Reply drafts

Drafts are written by `inbox.reply.draft` (tier `standard`) from the thread, the knowledge base, your company profile and booking link, then checked by rules and by `inbox.reply.check` (tier `fast`). A draft that fails gets one rewrite.

- At most 90 words.
- Links: only your website and your booking link (tagged with the person's booking code, see [tagged booking links](../guides/meetings.md#tagged-booking-links)), each exactly as set: another page or a look-alike address counts as an unknown link.
- Never proposes, accepts, confirms or promises a meeting time (see [the engine never confirms a time](#the-engine-never-confirms-a-time)).
- The checks reject empty text, leftover template text and placeholders, unknown links, the AI talking about itself and amounts that are not in the knowledge base.
- A newer draft in the same thread replaces an older pending one.

`threads draft-reply` (MCP: `reply_to_thread` action `draft`) drafts on demand, with an `instruction` from you or your exact `text`.

## Sending replies

| Who sends | What happens |
| --- | --- |
| A person holding `approve` (the local CLI, a human API key) | `threads send-reply` sends after a random delay from `settings.sending.reply_delay_minutes` (default 3 to 12 minutes) |
| Anyone else (an agent or service key, the local agent, a person without `approve`) | `threads send-reply` creates an approval of kind `reply`; the reply goes out once a person approves |
| The engine, automatically | Only when the category's action is `auto_reply` and every condition below holds |

Asking `threads send-reply` again with the same text in the same thread within 24 hours, for example an agent retrying after a timeout, returns the reply already asked for (or its approval request) with a `note`, instead of making a second one. Text is compared trimmed, with every run of whitespace as one space; a reply that was cancelled, failed or skipped does not count. Calls on one thread take turns, so two calls at the same moment are one reply too. See [Delivery guarantees](delivery-guarantees.md).

Nobody gets a reply after they opted out, were suppressed (email, domain, person or company), were marked do not contact, bounced or were erased, and no reply goes to an address marked invalid or to a person without an address (or LinkedIn profile). `threads send-reply` and `threads draft-reply` refuse with error `suppressed`, for humans and agents alike, before any draft or approval exists. The error names each reason in plain words and its hint says what to do: bad or missing contact data can be corrected (`manage_leads` action `update`) or checked again (`enrich_leads` action `verify`), while an opt-out, a suppression or a do-not-contact mark is final; a dry run of `send-reply` shows the same block in `blocked_reasons`. The automatic pipeline writes no draft for them either: it logs why and records `draft_skipped:<reasons>` in the reply's effects. An approved reply is checked again when the approval is applied and right before it is sent, so an opt-out in between stops it.

An automatic reply is sent only when all of these are true; otherwise it becomes a `reply` approval that lists what blocked it:

- The category is `interested`, `meeting_request`, `question`, `not_now` or `wrong_person`.
- The reply is not suspicious and has no topic that needs a human.
- The draft model did not say the knowledge base lacks the answer.
- The classification confidence is at least 0.8.
- Every check passed, and the checker said `pass` with confidence at least 0.8.
- A reply about scheduling (see [the engine never confirms a time](#the-engine-never-confirms-a-time)) goes out alone only in booking mode `link`, when the final draft contains the booking link and names no day, date or clock time.

Automatic replies also wait for the sending window and carry the AI disclosure line (`settings.compliance.ai_disclosure`: by default for EU/EEA recipients and anyone whose country is unknown, "This reply was written with AI assistance."). A reply that could not be queued for sending within 3 days is marked failed; one already queued on a mailbox that then stops sending waits until the mailbox works again. The kill switch stops all replies.

**When the prospect writes again first.** An automatic reply that has not gone out yet is cancelled when a newer message arrives in the thread, so the newer message is classified and answered on its own. If the newer message gets no answer (an out-of-office, for example), the thread is flagged `auto_reply_cancelled` so a human answers the earlier message. Replies that go to human review are not cancelled this way.

## Threads

A thread is one conversation (`open`, `waiting` or `closed`). After classification, `needs_attention` is set when a human should look, and `thread.needs_attention` fires with the reasons, for example `needs_human` (or `needs_human:<topic>`), `negative_reply`, `question_not_in_knowledge`, `possible_prompt_injection` or `low_confidence`. Sending an answer clears it. `threads list --needs-attention` (MCP: `list_threads`) is the daily review.

Hot replies (interested, meeting requests) reach you as a notification and a draft to approve. The [attention queue](reports.md#the-attention-queue) and `get_operating_state` list those still unanswered after 2 hours, except in threads a person took over (they answer there themselves) and replies whose person has a meeting recorded since: the meeting answered them.

Inbound text is untrusted. Tool outputs mark it `untrusted: true`, and the models that read it have no tools. See [Safety and approvals](safety-and-approvals.md#untrusted-content).

Each thread has an `owner`: `engine` (the default) or `person`. `threads list --owner person` shows the conversations people answer themselves.

## Taking a thread over

When a person answers a conversation themselves, the engine steps back so it never talks over them. A thread is taken over in two ways:

- **On its own:** a reply you write from the mailbox itself turns up in its Sent folder. The sync stores it in the thread as your message (`origin: external`) and takes the thread over. A new email you write to a lead outside any thread starts a thread that you own. See [Mailboxes](../guides/mailboxes.md#emails-you-write-yourself).
- **By hand:** `threads take-over --thread-id thr_...` (MCP: `reply_to_thread` action `take_over`). Add `--dry-run` to see which unsent messages it would cancel.

Taking a thread over:

- cancels the engine's unsent messages in the thread (drafts, pending reviews, approved and scheduled replies) and their approvals;
- stops the person's running sequences (reason `person_took_over`), so follow-ups do not arrive after your answer;
- fires `thread.taken_over` (with `message_id` when your own email triggered it, once for each such email).

While a person owns the thread, new messages from the prospect are still stored, classified and handled by the stop rules, but the engine writes no draft and sends no automatic reply. It flags the thread `thread_owned_by_person` instead, so you see the new message. You can still draft (`threads draft-reply`) and send (`threads send-reply`) replies yourself.

`threads release --thread-id thr_...` (MCP: `reply_to_thread` action `release`) hands the thread back and fires `thread.released`. Nothing is sent right away: the next message from the prospect is drafted and, where the rules allow, answered automatically again. Stopped sequences stay stopped; enroll the person again if you want them.

## Opportunities and meetings

An opportunity moves through `interested`, `meeting_booked`, `won` or `lost`, with value, currency, meeting time and notes. Hot replies create one automatically; `opportunities create`, `update`, `won` and `lost` change it by hand (MCP: `manage_pipeline`). Every change fires `opportunity.updated`. With `crm.mode: built_in` it also syncs to your configured CRM, as it happens or once a day (`crm.timing`); in `agent` mode your agent syncs it (see [CRM and notifications](../guides/crm-and-notifications.md)).

| Stage | Effect |
| --- | --- |
| `interested` | Person status `interested` |
| `meeting_booked` | Person status `meeting`; enrollments stop when `stop.on_meeting` is on |
| `won` | Person status `customer`; every enrollment at the company stops |
| `lost` | Records the lost reason |

### Booking modes

`settings.booking.mode` decides how replies handle meetings:

| Mode | What replies do |
| --- | --- |
| `link` (default) | Replies to interested people and meeting requests offer the booking link: the `booking_url` of the offer the reply is written from (the campaign's offer, else the default or only active offer), else `booking.default_url` |
| `handoff` | The engine never shares a link or proposes times. A meeting request or a reply with a proposed time gets no draft at all. You or your agent book |
| `off` | The engine never offers meetings. Replies are drafted without links, and meeting replies always go to review. Bookings that come in are still recorded |

Outside `link` mode the offer's booking link is also left out of the knowledge the draft is written from.

### The engine never confirms a time

The classifier reads a time the prospect proposed ("Tuesday at 3pm") as `proposed_time`: the text, the start when the date and time are clear, and the timezone. The engine never accepts, confirms or promises a specific time itself; only a person or the booking link can.

- The draft offers the booking link instead and names no day or time ("Happy to talk. Grab a slot that suits you here so it lands on both calendars"), or, without a link, says a time will be confirmed shortly.
- The checker sends back a draft that proposes a time (issue `proposes_time`) or confirms one (issue `confirms_time`).
- A reply counts as scheduling when it is a meeting request or proposes a time, when a message from the prospect since your last one proposed a time, or while the person has an open "Book a meeting" problem.
- A scheduling reply goes out without review only in `link` mode, only when the final draft contains the booking link itself (the same address and path, not a look-alike) and only when it names no day, date or clock time ("Tuesday", "tomorrow", "10:00", "3pm", "see you then"). That last check is a plain word check: a false alarm only means a person reviews the reply. Every other scheduling reply waits for review.
- A proposed time, or a meeting request with no booking link to offer, opens the problem "Book a meeting with <name>" (kind `meeting_to_book`, one per person). Severity: `high` in `handoff` mode or without a link, else `normal`. The problem looks for the link exactly where the draft does, so it never says there is no link while the draft offers one. The remedy: check the calendar, book it, then record it with `manage_meetings` action `record`. Recording or booking a meeting for that person resolves it.

### Meetings

Every meeting is a record with a status (`scheduled`, `held`, `no_show` or `cancelled`). It comes from a booking webhook (Calendly, Cal.com or any tool that can send JSON) or is recorded by hand after someone booked it in a real calendar (`manage_meetings` action `record`). Either way the opportunity moves to `meeting_booked`, the person's sequences stop (`stop.on_meeting`, on by default), their "Book a meeting" problem resolves and the engine's reply drafts that answer a wish to meet (`interested` or `meeting_request` replies) and still wait for review in their threads are cancelled with their approvals (error `meeting_booked`); answers to anything else, a reply a person or the agent wrote or edited, and one already approved are left alone. Booking links the engine writes carry the person's hidden booking code, so a booking matches the right lead even from another address. The [Meetings guide](../guides/meetings.md) covers the settings, connecting a booking tool, recording by hand, no-shows, cancellations and qualified meetings.

## Tasks

Tasks are for humans: follow-ups from `not_now`, referrals without an address, better contacts for `wrong_person`, call steps in campaigns, follow-ups after a no-show or a cancellation, and promises made in our replies (type `promise`). They never send anything. `tasks list --due-before ...`, then `tasks complete` or `tasks skip` (MCP: `manage_tasks`, in the `core` toolset).

## The lead file

Facts from classified replies, promises we make in our replies (tasks of type `promise`) and suggested company holds go to the [lead file](lead-file.md), which the writer and reply drafts read as background. Nothing is kept from suspicious replies, opt-outs, privacy requests, bounces or other automatic mail.

## Tools and commands

| MCP tool | Actions | CLI |
| --- | --- | --- |
| `list_threads` | `list`, `get` | `threads list`, `threads get` |
| `reply_to_thread` | `draft`, `send`, `classify`, `update`, `take_over`, `release` | `threads draft-reply`, `send-reply`, `classify`, `update`, `take-over`, `release` |
| `manage_pipeline` | `list`, `create`, `update`, `won`, `lost`, `sync_crm`, `meeting_webhook` | `opportunities ...`, `crm sync`, `meetings create-webhook` |
| `manage_meetings` | `list`, `get`, `record`, `reschedule`, `cancel`, `mark_held`, `mark_no_show`, `qualify` | `meetings ...` |
| `manage_tasks` | `list`, `create`, `complete`, `skip` | `tasks ...` |
| `review_items` | `list`, `get`, `decide` | `approvals ...` |

Next: [Reports](reports.md) · [CRM and notifications](../guides/crm-and-notifications.md) · [Campaigns](campaigns.md) · [Events](../reference/events.md)
