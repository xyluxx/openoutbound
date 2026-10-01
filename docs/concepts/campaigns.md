# Campaigns

This page explains how a campaign works: its steps, who gets enrolled, how each message is written and checked, when a human reviews it, how the sequencer sends it, and what stops a person's sequence.

A campaign is a sequence of steps (emails, LinkedIn actions, waits, conditions, tasks, webhooks) that runs for each enrolled person. Nothing is sent until the campaign is launched, and every message passes the [safety gate](safety-and-approvals.md).

## The life of a campaign

| Status | How it gets there | What runs |
| --- | --- | --- |
| `draft` | `campaigns create` | Nothing. Edit, enroll, preview. |
| `active` | `campaigns launch` (or an approved launch request) | The sequencer starts queued people and runs their steps |
| `paused` | `campaigns pause` | Nothing new for this campaign. Emails and LinkedIn actions already queued wait until it resumes; email answers to prospects in the inbox still go out (LinkedIn answers in the campaign's conversations wait too). |
| `completed` | `campaigns stop`, or automatically after `schedule.end_at` once nobody is left in progress | Nothing. History and stats stay. |
| `archived` | `campaigns archive`, or `campaigns delete` on a campaign with history | Nothing. Hidden from active lists. |

`campaigns delete` removes a draft that never sent anything. `campaigns duplicate` copies settings and steps into a new draft. `campaigns save-as-template` stores the steps and writing settings for reuse (senders are left out).

## Start from a template

`campaigns templates` lists the five built-in sequences and the templates saved in the workspace. Pass the key as `--template` to `campaigns create`. Each delay counts from the previous step.

| Key | Steps (delay in days) | Use it for |
| --- | --- | --- |
| `signal_based_email_4` | Email (0), reply (3), reply (4), new thread (7) | The default for B2B: a signal-led first touch, proof, a resource, close the loop |
| `email_linkedin_6` | Profile visit, email, invite without a note, email, condition "connected", LinkedIn message, email, like a post, email | People active on LinkedIn |
| `local_business_3` | Email (0), reply (4), new thread (6) | Clinics, trades, restaurants and other owner-run businesses |
| `event_follow_up` | Email (0), invite with a note (1), reply (4), reply (5) | People with evidence they attended an event |
| `re_engage_lost` | Email (0), reply (5), reply (7), with review level `every` | Deals lost at least 90 days ago, with a real change to talk about |

All built-in templates have the goal `meeting` and write every email with the `free` style (the AI writes the whole text).

```bash
openoutbound --workspace acme campaigns create --name "Dental groups, Q4" \
  --template signal_based_email_4 --offer-id off_... \
  --settings '{"senders":{"mailbox_ids":["mbx_..."]},"daily_new_leads":15}'
```

## Steps

A campaign has 1 to 30 steps. Each step has a `type`, a delay after the previous step (`delay_days` 0-365 plus `delay_hours` 0-23) and a `config`.

| Type | What it does | Config |
| --- | --- | --- |
| `email` | Sends an email | `mode` (`new_thread` or `reply` in the same thread), `style` (`exact`, `guided`, `free`), `subject`, `body`, `instruction`, `variants`, `max_words` (20-400, default 90) |
| `linkedin_invite` | Sends a connection invite; skipped if already connected or invited | `note` (`none`, `exact`, `guided`, `free`), `text`, `instruction` |
| `linkedin_message` | Messages a connection; waits for the connection (checked every 12 hours, gives up after 14 days) | `style`, `text`, `instruction` |
| `linkedin_comment` | Comments on a post from the last 14 days; skipped when there is none | `instruction`, `review` (`always`, the default, or `level`) |
| `linkedin_like` | Likes a post from the last 14 days | none |
| `linkedin_visit` | Visits the profile | none |
| `wait` | Only waits | none |
| `condition` | Jumps to `then_step` or `else_step` (forward only; `null` means the next step) | `if`: `has_email`, `has_linkedin`, `linkedin_connected`, `signal_present` (with `signal_key`), `replied`, `custom` (with `custom_field`, optional `custom_value`) |
| `task` | Creates a task for a human, due now | `task_type`, `title`, `notes` |
| `webhook` | POSTs a signed request to your URL (10 second timeout, 3 attempts, then the step is skipped) | `url`, `secret_id` |

Writing styles:

| Style | Who writes | Checks |
| --- | --- | --- |
| `exact` | Your template, with variables filled in | Deterministic checks only |
| `guided` | Your template; the AI fills each `[[ai: ...]]` slot | Deterministic checks and the checker model |
| `free` | The AI writes the whole message from the step's `instruction` and the campaign's writing settings | Deterministic checks and the checker model |

Template variables: `{{first_name}}`, `{{last_name}}`, `{{company}}`, `{{title}}`, `{{city}}`, `{{sender_name}}`, `{{offer}}`, `{{booking_url}}` and `{{custom.<key>}}`, with a fallback as `{{first_name|there}}`. A variable with no value and no fallback skips the message (`missing_variable`).

When a step cannot run for a person (no email address, no LinkedIn URL), `settings.missing_data` decides: `skip_step` (default) moves on, `skip_lead` stops that person's enrollment.

To edit steps on a running campaign, pass the full step list to `campaigns update` and keep each existing step's `id`, so people mid-sequence keep their place. Edits only affect steps they have not reached yet.

## Enroll people

`campaigns enroll` adds people by ids, a list or a people filter as queued enrollments (up to 5,000 per call). Run it with `--dry-run` first: it returns the counts and skip reasons without enrolling anyone.

| Skip reason | Why |
| --- | --- |
| `already_enrolled` | Already in this campaign |
| `active_in_other_campaign` | In another active campaign and `compliance.one_active_campaign_per_person` is on (default) |
| `rest_period` | Finished another campaign less than `compliance.rest_days_after_campaign` days ago (default 30) |
| `company_cap_reached` | The company already has `compliance.contact_cap_per_company` people in progress (default 3) |
| `missing_data:email`, `missing_data:linkedin_url` | The first step needs data the person lacks, and `missing_data` is `skip_lead` |
| `missing_data:all_channels` | No way to reach the person on any step |
| `not_contactable:<code>` | Suppressed, unsubscribed, bounced, excluded country, consent required, unverified email and so on |
| `not_found` | The id does not exist |

The first 100 skipped people are listed with their reason. Contactability is checked again right before every send.

## The writing pipeline

Every message with text is written in the background by the job `campaigns.generate_message`, the same way `campaigns preview` does it:

1. **Context.** The person and company, the latest research brief (if one exists), the top 3 active signals, a grounding pack from the knowledge base for the campaign's offer, earlier messages in the enrollment and the sender. Prospect data and web content go into the prompt as untrusted content.
2. **Draft.** The writer model (`campaign.email.write`, `campaign.linkedin.write` or `campaign.email.fill_slots`, tier `standard`) writes the text and says why: the angle, the sourced facts and the signals it used.
3. **Deterministic checks.** Length, subject, banned phrases, unresolved variables and placeholders, links, exclamation marks, more than one question, all caps, dashes, emoji, and numbers or facts without a source.
4. **Checker model.** `campaign.email.check` (tier `fast`, temperature 0) returns `pass`, `revise` or `fail` with a confidence. A `pass` with any failed deterministic check becomes `revise`.
5. **One rewrite** when the verdict is not `pass`, then the checks run again.

The context also holds what you know about the lead from earlier conversations, in every campaign: active facts, the latest reply summaries and how earlier campaigns ended (see [Lead file](lead-file.md)). The writer stays consistent with it and may cite it with the source `lead_file`.

Limits the checks enforce:

| Message | Length | Links |
| --- | --- | --- |
| Email | The step's `max_words`; an AI-written first touch needs at least 35 words | First touch: none, unless the step text has a URL or `{{booking_url}}`. Follow-ups: 1. |
| Subject | 2 to 5 words (a one-word subject you wrote yourself only gets a warning), no fake `Re:` or `Fwd:` | |
| Invite note | At most 200 characters | None |
| LinkedIn message | At most 60 words | First touch: none. Later: 1. |
| Comment | 20 to 60 words | None |

The banned phrase list holds about 100 phrases common in spam and AI-sounding copy, plus phrases you ban in `writing.rules` (quoted phrases in rules that start with "avoid", "never", "don't", "no" or "ban"). When writing fails more than 3 times, the message fails with `generation_failed`; the step is tried again an hour later, and after a second failed attempt the person's enrollment fails.

**A/B tests.** Give an email step `variants` (`key`, `subject`, `body`, `instruction`) and turn on `settings.ab_test.enabled`. Each person always gets the same variant, and people split evenly. `campaigns get` shows the numbers per step and variant. See [Pick an A/B winner](#pick-an-ab-winner) for how to end a test.

**Teach.** `campaigns teach` turns corrections (original and corrected text, or a note) or edited drafts into up to 5 short writing rules per call. They are added to `settings.writing.rules` (the last 50 are kept) and every later draft and check follows them. The change is recorded in the change log (operation `campaigns.teach`), so `changes undo` can take the rules back. Archived and completed campaigns cannot learn: duplicate them and teach the copy.

### Pick an A/B winner

The campaign report (`get_report` with type `campaign`, or `reports get --type campaign --campaign-id cmp_...`) compares the variants of each email step:

| Field | Meaning |
| --- | --- |
| `variants[].meetings`, `meeting_rate` | People who got that variant in that step and later booked a meeting (a meeting record that is not cancelled, or for older data an opportunity that reached `meeting_booked` and has no meeting record), for this campaign or with no campaign named, per people reached |
| `ab_metric` | What the test is judged on: `settings.ab_test.metric` (`positive_reply_rate` by default, `reply_rate` or `meeting_rate`) |
| `leader` | The variant most likely to be the best on that metric. Null until `enough_data` |
| `confidence` | The probability (0 to 1) that the leader really is the best, from a Beta-Binomial comparison of the variants that were sent. It is computed with a fixed seed, so the same numbers always give the same answer. Null until `enough_data` |
| `enough_data` | `true` once every variant has at least 50 sends. Before that there is no leader: a variant nobody got yet is never ranked |

Variants in the step that nobody got yet are listed with zeros. The Markdown report adds an "A/B tests" table per campaign.

When a leader has enough data and a confidence you trust (0.9 or more is a common bar), end the test:

```bash
openoutbound --workspace acme campaigns pick-winner --campaign-id cmp_... --step-id stp_... --variant-key B --dry-run
openoutbound --workspace acme campaigns pick-winner --campaign-id cmp_... --step-id stp_... --variant-key B
```

In MCP it is `create_campaign` action `pick_winner`. It rewrites the step so only the winner remains: the winner's subject, body and instruction move into the step (the step's own text fills anything the variant did not set) and `variants` is removed. It goes through the same code as `campaigns update`, so it works on live campaigns and people mid-sequence keep their place. When the test does not have enough data yet, or the variant you keep is not the report's leader, the answer (and the dry run) carries a warning, but the pick is made: a person may choose. Messages already written with another variant are not rewritten: `pending_other_variants` counts them, and `manage_messages` can cancel or regenerate them. The engine never picks a winner by itself.

## Preview before you launch

`campaigns preview` runs the whole pipeline for 1 to 10 sample people (default 3, the best-fit enrolled people unless you pass ids, a list or a filter) and one step (default the first step with text). For each person it returns the subject, body, variant, the why (angle, facts with sources, signals, brief) and the check verdict with issues. It spends AI budget but stores and sends nothing. Its dry run shows the people and the estimated cost ($0.012 per person).

## Review

Each campaign has a review level (`settings.review_level`, default from `settings.approvals.default_review_level`, which defaults to `first`). A message that needs review becomes an approval of kind `message`; the enrollment waits in `waiting_review`. Lowering the level (`every` to `first` to `unsure`) by anyone but a person holding `approve` waits for an approval of kind `review_level`, while the other changes of the same update apply at once; raising it never waits. Switching a LinkedIn comment step from `review: "always"` to `"level"` lowers review the same way: the step keeps `always` until a person approves the `review_level` approval that names it.

| Level | A message with text waits for a human when |
| --- | --- |
| `every` | Always |
| `first` | No earlier message with text in this enrollment has been approved or sent |
| `unsure` | The checker's verdict is not `pass`, or its confidence is below 0.7 |

At every level, a message that failed its checks goes to review, and comment steps with `review: "always"` go to review. A new text from anyone but a person holding `approve` (`messages update`) goes to review too, also for a message a person already approved: it is back in `pending_review` with a new approval and is not sent meanwhile. A person holding `approve` who changes an approved message keeps it approved, unless the new text fails its checks. The approval applies the text it shows (with the reviewer's edits), never a later change. Messages without text (visits, likes, invites without a note) never do.

| Decision | Result |
| --- | --- |
| Approve (optionally with `subject` and `body` edits) | The message is scheduled |
| Reject | The message is cancelled, the step is skipped, the sequence continues |
| Expired (after `settings.approvals.expire_days`) | The step is skipped |

See [Safety and approvals](safety-and-approvals.md#approvals) for deciding approvals.

## Launch

`campaigns launch --dry-run` returns the pre-launch checklist, each failing item with a fix, and the estimated daily AI cost. Launch fails while any item has the status `fail`.

| Item | Key | Status when it is not met |
| --- | --- | --- |
| Steps are valid | `steps_valid` | fail |
| Has email or LinkedIn steps | `channel_steps` | warn |
| Active mailboxes (email steps) | `mailboxes` | fail |
| Replies are read: every sender mailbox has IMAP (sandbox mailboxes pass) | `reply_sync` | fail |
| Active LinkedIn accounts (LinkedIn steps) | `linkedin_accounts` | fail |
| Sending capacity for `daily_new_leads` | `capacity` | warn |
| Offer (when one is set, it must exist and be active) | `offer` | fail |
| Something to write from (an offer or writing instructions for AI steps) | `content_source` | fail |
| Leads to contact (enrolled people, or a saved search or automation that names the campaign) | `enrollment_source` | warn |
| Postal address set in `settings.company.postal_address` (email steps; always required) | `postal_address` | fail |
| Unsubscribe link: `OPENOUTBOUND_BASE_URL` is a public https address (email steps; sandbox workspaces and sandbox mailboxes pass) | `unsubscribe_link` | fail |
| Sender company name | `company_name` | warn |
| Sending window (days set, start hour before end hour) | `schedule` | fail |
| AI brain (AI-written steps wait until one is configured) | `brain` | warn |
| Workspace is running | `workspace_active` | warn |

Three of these protect prospects:

- **Reply sync.** Without IMAP, replies, bounces and unsubscribe-by-reply are never seen, so stop rules cannot fire and people who answered would keep getting steps. Add the IMAP server with `mailboxes update`, or take the mailbox out of `settings.senders.mailbox_ids`.
- **Postal address.** Every cold email must carry a postal address (CAN-SPAM, GDPR), so launch fails without one.
- **Unsubscribe link.** Unsubscribe links and the `List-Unsubscribe-Post` header need a base URL that recipients can reach. With a local base URL such as `http://localhost:7331`, a campaign with email steps does not launch in a real workspace, and an email that would go out without its link anyway (the address changed after the launch) is held: it stays scheduled, is checked again every 30 minutes, and a `sending_blocked` problem says what to do. Replies to people who wrote to you still go out. Set `OPENOUTBOUND_BASE_URL` and restart `openoutbound serve`; see [Deploy](../guides/deploy.md#3-set-the-base-url).

When someone who must ask for approvals launches (an agent or service key, the local agent, a person without `approve`) and `settings.approvals.agent_launch_requires_approval` is true (default), the launch becomes an approval of kind `campaign_launch`; approving it activates the campaign as the request showed it. When the campaign's settings, steps, offer, senders or enrolled people changed after the request, approving answers `conflict` and launches nothing: launch again for a new request. A new launch request replaces an older pending one.

## The sequencer

The job `campaigns.tick` runs every minute for each workspace that is not paused. Each tick:

1. Starts queued enrollments: at most `daily_new_leads` (default 20) per day, oldest first, only between `schedule.start_at` and `schedule.end_at`. The day is counted in `schedule.timezone`.
2. Runs due steps, up to 200 per tick, by campaign `priority` (0-100, default 50), then by due time.
3. Completes campaigns whose `schedule.end_at` has passed and that have nobody left in progress.

Emails go through the mailbox planner: sending window (`schedule.days`, `start_hour` to `end_hour`, in the lead's timezone by default), the workspace's working days, holidays and blackout ranges, and each mailbox's limits. See [Mailboxes](../guides/mailboxes.md). LinkedIn actions follow the account's limits; see [LinkedIn](../guides/linkedin.md).

After a message is sent, the next step is timed from the send. A failed send is retried after an hour; after 2 failed attempts the enrollment fails. A hard bounce stops the enrollment.

## What stops a sequence

| Event | What happens | Setting |
| --- | --- | --- |
| The person replies | Their enrollments pause while the reply is classified (up to 24 hours). A real reply then stops them (reason `replied`); with `stop.on_reply` off they resume. Automatic replies resume the sequence unless the person left the company. See [Inbox](inbox.md). | `stop.on_reply` |
| Someone at the same company replies or books a meeting | Colleagues' enrollments stop too (reason `company_replied` or `company_meeting_booked`) | `stop.on_company_reply` |
| A meeting is booked | Enrollments stop (reason `meeting_booked`) | `stop.on_meeting` |
| The opportunity is won | Enrollments at the company stop | always |
| Unsubscribe | All of the person's enrollments stop | always |
| A privacy request | All of the person's enrollments stop (reason `privacy_request`), they are suppressed everywhere and their unsent messages are cancelled. See [Inbox](inbox.md#privacy-requests). | always |
| A person takes the thread over (answers from their own mailbox, or `threads take-over`) | The person's enrollments stop (reason `person_took_over`) and the engine's unsent messages in the thread are cancelled. See [Inbox](inbox.md#taking-a-thread-over). | always |
| The CRM says customer, open deal, owned account or do not contact | Enrollments at the company stop (reasons `crm_customer`, `crm_open_deal`, `crm_owned`, `crm_do_not_contact`); do not contact for one person stops only theirs. See [CRM facts](../guides/crm-and-notifications.md#crm-facts-tell-the-engine-what-your-crm-knows). | `crm.allow_outreach_with_open_deal`, `crm.skip_owned_accounts` |
| A negative or hostile reply | All of the person's enrollments stop (reason `negative`), and the address and person are suppressed; colleagues stop too with `stop.on_company_reply` | always |
| Hard bounce | The enrollment stops | always |
| Out-of-office reply | The enrollment pauses until the person is back | always |
| The company is put on hold | Enrollments of everyone at the company pause until the hold ends; a step that comes due during the hold waits for it. See [Lead file](lead-file.md#company-holds). | always |

All three `stop` settings default to `true`. At the end of the last step, the enrollment completes and `settings.end_action` runs once (add a tag, or add to a list), also for people whose remaining steps were removed by a step edit.

## Tools and commands

| MCP tool | Actions | CLI |
| --- | --- | --- |
| `get_campaigns` | `list`, `get`, `templates`, `enrollments` | `campaigns list`, `get`, `templates`, `enrollments` |
| `create_campaign` | `create`, `update`, `pick_winner`, `duplicate`, `delete`, `save_as_template` | `campaigns create`, `update`, `pick-winner`, `duplicate`, `delete`, `save-as-template` |
| `preview_campaign` | `preview`, `teach` | `campaigns preview`, `teach` |
| `launch_campaign` | `launch`, `pause`, `resume`, `stop`, `archive` | `campaigns launch`, `pause`, `resume`, `stop`, `archive` |
| `enroll_leads` | `enroll`, `unenroll` | `campaigns enroll`, `unenroll` |
| `manage_messages` | `list`, `get`, `update`, `regenerate`, `cancel`, `resolve_unknown` | `messages list`, `get`, `update`, `regenerate`, `cancel`, `resolve-unknown` |

Every input field is in the [MCP tools reference](../reference/mcp-tools.md) and the [CLI reference](../reference/cli.md). Every setting is in the [configuration reference](../reference/configuration.md#campaign-settings).

Next: [Inbox](inbox.md) · [Mailboxes](../guides/mailboxes.md) · [LinkedIn](../guides/linkedin.md) · [Reports](reports.md)
