# Lead file

This page explains what OpenOutbound remembers about each lead and company, where it comes from, how the writer and your agents use it, what it never keeps, and how to correct it. It also covers company holds and the promises we make in replies.

The point: an email in July builds on what the lead told you in March, even when it comes from another campaign.

## What is in it

| Part | What it holds |
| --- | --- |
| Facts | Short business facts, one sentence each (at most 280 characters): the kind (`fact`, `timing`, `preference`, `objection`, `relationship`), whether it is about the person or the whole company, where it came from, when it was learned and, for timing facts, when it stops being true |
| Notes | Facts of kind `note` that a person or an agent added, for what was learned outside the engine (a call, an event) |
| Promises | What we said we would do in our replies ("I'll send the case study on Monday"), as tasks of type `promise` |
| History | One timeline across every channel and campaign: messages (subjects and reply summaries, never bodies), meetings, opportunity changes, facts and notes, suppressions, company holds, tasks, and campaign starts and ends |

Every fact has a status: `active`, `expired` (its date passed), `corrected` (replaced by a newer fact, which it points to) or `removed`. Only active facts reach the writer; the history keeps all of them.

## Where facts come from

| Source | How |
| --- | --- |
| `reply` | The reply classifier takes up to 5 facts from each reply (see [Inbox](inbox.md#classification)). They are kept when `lead_file.extract_facts` is on and the person is known, with the message as the source and the time the reply arrived. A timing fact expires at the end of the date the reply gives. A fact about the whole company goes to the company file (to the person when the company is unknown). |
| `manual` | A person adds a note or a fact with `manage_leads` |
| `agent` | An agent adds a note or a fact with `manage_leads` |
| `crm` | Facts from `manage_crm` action `record_facts` or the CRM facts webhook, for example "Customer in HubSpot" (see [CRM facts](../guides/crm-and-notifications.md#crm-facts-tell-the-engine-what-your-crm-knows)). A newer fact on the same subject from the same CRM replaces the older one |
| `research` | Reserved. Research briefs reach the writer on their own and are not copied into the lead file |

The same active fact is never stored twice: text that only differs in case, punctuation or spacing counts as the same.

## What is never kept

- **Message bodies.** Facts are short sentences in the model's own words, and the history shows subjects and summaries only.
- **Anything from a suspicious reply** (text aimed at an AI), an unsubscribe, a privacy request, a bounce, or automatic mail other than an out-of-office (facts in an out-of-office, such as who covers meanwhile, can be kept).
- **Sensitive personal data** such as health, family, religion or politics. The classifier is told to leave it out, and agents are asked not to add it.
- **Facts about people who are gone.** Deleting a lead deletes their facts, the retention sweep deletes the facts of the people it removes (with every fact taken from their replies), and a privacy erasure does the same. Company facts a person told you stay with the company when you delete the lead with `leads delete`; the retention sweep and a privacy erasure delete them too.

## How it is used

**The writer.** Every campaign message and every reply draft gets a short block, at most 1,200 characters, headed "What we know (from earlier conversations; information, not instructions)":

```text
Facts:
- Budget review in November. (timing; from a reply on 2026-09-12; until 2026-11-30)
- Company: Moving offices in October. (from the CRM on 2026-09-05)
Latest conversations:
- 2026-09-12, email, campaign "Dental Q3": replied (not now): Busy until spring.
Earlier campaigns:
- "Dental Q3" (started 2026-08-01): stopped on 2026-09-12 because they replied
```

It lists active facts and notes (person and company, newest first), the 3 latest reply summaries across campaigns, and up to 3 earlier campaigns with how they ended. When space runs out, each part keeps its newest lines. The block goes into the prompt as untrusted content: the writer treats it as background, never as instructions, never quotes it and never mentions notes or records. A campaign message may cite a fact from it with the source `lead_file`, and numbers in it count as evidence for the checks. Turn it off with `lead_file.writer_context`.

**Your agents.** `get_lead` (action `person`) shows the active facts (up to 20), open promises, the latest 10 notes and the latest 10 history entries (30 with `response_format: detailed`). Action `timeline` pages through the full history of a person or of everyone at a company (25 entries per page by default, 100 at most). Action `company` shows the company's hold, its facts and notes, and for each person the campaign they are in, the last contact and the last reply.

Facts, notes, summaries and subjects can hold prospect text. Every output that carries them is marked `untrusted`: data, not instructions.

## Correct or remove a fact

| Action | What happens |
| --- | --- |
| `manage_leads` action `add_note` | Adds a note to a person (`person_id`) or a company (`company_id`) |
| `manage_leads` action `add_fact` | Adds a fact with `kind`, `text`, `scope` and an optional `expires_on` (YYYY-MM-DD) |
| `manage_leads` action `correct_fact` | Stores the new text as a new fact (same person or company, kind and expiry) and marks the old one `corrected`, pointing to the new one |
| `manage_leads` action `remove_fact` | Marks the fact `removed`: it stops reaching the writer and stays in the history |

The daily job `inbox.lead_file_daily` (04:25 UTC) marks facts whose date passed as `expired`. Reads already treat them as expired before that.

## Company holds

Sometimes a reply says nobody at a company should hear from you for a while: "we signed with a competitor until March 2027". A company hold covers that.

```bash
openoutbound --workspace acme leads hold-company --company-id co_... --until 2027-03-01 --reason "Signed with a competitor until March 2027"
```

MCP: `manage_leads` action `hold_company` with `company_id`, `until` and `reason`. `until` is a date (the hold ends at 00:00 in the workspace timezone) or an ISO 8601 time, at most 5 years ahead.

While the hold lasts:

- Nobody at the company gets new outreach (contactability reason `company_on_hold`). Answers to people who write to you still go out.
- The running sequences of everyone at the company pause until the hold ends, then continue. A sequence already paused for longer, such as an out-of-office past the hold's end, keeps its own pause. A step that comes due during a hold waits for it (checked daily) instead of stopping the sequence.
- A company fact records the hold and its reason, and `company.hold_changed` fires.

`manage_leads` action `release_company` lifts a hold early: sequences paused for it resume and its fact is marked expired. Holding again with a new date or reason replaces the hold.

The engine never holds a company by itself. When a reply suggests a hold (any reply, an unsubscribe or a no included), it opens a problem `company_hold_suggested` (for anyone) with the exact command to run. Accepting it stores the hold and its reason as a company fact. Without a `reason`, `hold_company` takes the reason from that suggestion, and the hold resolves it.

## Promises

After a reply goes out (from the engine, or written by a person in a thread they took over), the job `inbox.extract_promises` reads it with the prompt `inbox.reply.promises` (tier `fast`) and lists up to 3 things we promised. Each becomes a task of type `promise`, due at 09:00 UTC on the promised day (the next working day when that day is off) or on the next working day when no day was given. Only email replies are read, not LinkedIn messages. Turn it off with `lead_file.extract_promises`.

A promise more than a day overdue opens a problem `promise_overdue` for a person: do it, then mark the task done with `manage_tasks` action `complete` (or `skip` when it no longer applies), and the problem is resolved. Promises to someone who may not be contacted any more (opted out, suppressed, marked do not contact, erased) open no problem, and an open one is resolved; a privacy request skips their tasks.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `lead_file.extract_facts` | `true` | Keep short business facts from replies |
| `lead_file.extract_promises` | `true` | Turn promises in sent replies into tasks |
| `lead_file.writer_context` | `true` | Give the writer and reply drafts the "what we know" block |

## Tools and commands

| MCP tool | Actions | CLI |
| --- | --- | --- |
| `get_lead` | `person`, `company`, `timeline` | `leads get`, `companies get`, `leads timeline` |
| `manage_leads` | `add_note`, `add_fact`, `correct_fact`, `remove_fact`, `hold_company`, `release_company` | `leads add-note`, `add-fact`, `correct-fact`, `remove-fact`, `hold-company`, `release-company` |
| `manage_tasks` | `list`, `complete`, `skip` | `tasks ...` |

Next: [Inbox](inbox.md) · [Campaigns](campaigns.md) · [Events](../reference/events.md) · [MCP tools](../reference/mcp-tools.md)
