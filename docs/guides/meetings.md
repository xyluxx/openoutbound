# Meetings

This guide shows how meetings reach the engine: the booking settings, connecting Calendly, Cal.com or another booking tool, recording a meeting booked by hand, and what happens after a meeting, a no-show or a cancellation.

## How it works

- The engine never books calendars and never accepts or confirms a meeting time. Replies offer your booking link, or a person (or your agent) books; see [booking modes](../concepts/inbox.md#booking-modes) and [the engine never confirms a time](../concepts/inbox.md#the-engine-never-confirms-a-time).
- Every meeting is a record: person, opportunity, source (`calendly`, `cal_com`, `generic` or `manual`), the booking tool's id, start and end, status, qualified flag and notes.
- A booking has the same effects whatever its source, a webhook or `meetings record`:
  - the person's opportunity moves to `meeting_booked` with the meeting time (one is created when there is none);
  - their active sequences stop (campaign setting `stop.on_meeting`), their status becomes `meeting`, and your CRM syncs as `crm.*` says;
  - their "Book a meeting" problem resolves and `meeting.booked` fires;
  - the engine's reply drafts that answer a wish to meet (`interested` or `meeting_request` replies) and still wait for review in their threads are cancelled with their approvals (error `meeting_booked`), since they offer the link or ask for a time. Answers to anything else (a question, an objection), text a person or the agent wrote or edited, and replies already approved stay. A reschedule does the same.
- A repeated webhook delivery changes nothing: there is one record per source and booking id. Recording the same person and start again returns the existing meeting, including one a webhook already reported, and a booking tool that reports a meeting you recorded by hand (same person, start within a minute) gives that record its source and booking id instead of adding a second one.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `booking.mode` | `link` | `link`: replies offer the booking link. `handoff`: a person or the agent books. `off`: no meeting offers |
| `booking.default_url` | none | The link replies offer when their offer (the campaign's, else the default or only active offer) has no `booking_url` |
| `booking.tag_links` | `true` | Calendly and Cal.com links carry the person's hidden booking code ([below](#tagged-booking-links)) |
| `booking.assume_held_after_hours` | 24 | A scheduled meeting counts as held this long after its start unless it was cancelled or marked a no-show; `0` waits for an explicit mark (0 to 720) |
| `booking.after_no_show` | `task` | What happens after a no-show: `task`, `draft` or `nothing` ([below](#after-a-no-show-or-a-cancellation)) |
| `booking.after_cancel` | `task` | The same choice after a cancellation |
| `strategy.qualified_meeting` | empty | What counts as a qualified meeting for this client, in plain words |

```bash
openoutbound --workspace acme workspaces update --settings '{"booking":{"mode":"link","default_url":"https://book.example.com/acme/intro"}}'
```

Put a booking link on each offer too (`booking_url`); it wins over `booking.default_url`.

## Connect a booking tool

Create the workspace's secret webhook URL:

```bash
openoutbound --workspace acme meetings create-webhook             # shows the URL once
openoutbound --workspace acme meetings create-webhook --rotate    # new URL; the old one stops working
```

MCP: `manage_pipeline` action `meeting_webhook` (needs `admin`). The URL looks like `https://outbound.example.com/hooks/meetings/mtg_...`; only a hash of it is stored. Paste it into your booking tool and subscribe to these events:

| Tool | Events |
| --- | --- |
| Cal.com | `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `BOOKING_REJECTED` (counts as cancelled), `BOOKING_NO_SHOW_UPDATED` |
| Calendly (a webhook subscription) | `invitee.created` (a reschedule too), `invitee.canceled`, `invitee_no_show.created`, `invitee_no_show.deleted` |
| Anything else | A POST with the generic body below |

The generic body:

```json
{ "email": "dana@harbor-dental.example.com", "ref": "...", "id": "bk_1234", "name": "Dana Reyes", "start_time": "2026-10-06T13:00:00Z", "end_time": "2026-10-06T13:30:00Z", "event": "booked" }
```

| Field | Meaning |
| --- | --- |
| `email`, `ref`, `id` | At least one: the attendee's address, the booking code from a tagged link, or the booking's id in your tool |
| `event` | `booked` (the default), `rescheduled`, `cancelled`, `no_show`, `no_show_undone` or `held` |
| `previous_id` | For a reschedule: the id of the booking it replaces |
| `name`, `start_time`, `end_time` | The attendee's name and the meeting times (ISO 8601) |
| `source` | A label for notes and notifications (default `webhook`) |

How a booking finds its lead: the booking code first (Calendly `tracking.utm_content`, Cal.com `metadata.oo_ref`, generic `ref`), then the email. The booking id (the Calendly invitee URI, the Cal.com `uid`, the generic `id`) ties later reschedules, cancellations and no-shows to the same meeting. Bookings, reschedules, cancellations and no-shows from a booking tool also notify you.

Deliveries can arrive late or out of order, so old news never overwrites newer state:

- Only a reschedule moves a meeting. A repeated `booked` delivery never moves it (a generic tool sends `event: rescheduled` to move one), and a late reschedule never reopens a cancelled meeting.
- A reschedule keeps the booking ids it replaced, so a late delivery about an old id (a retried booking, a cancellation or a no-show) finds the same meeting and changes nothing.
- A cancellation that arrives before its booking is kept as a cancelled meeting (no event, no task, no stage change), so the booking that follows stays cancelled. This needs the cancellation to name the person; one that carries only a booking id cannot be kept.
- If recording a booking stops half way (a restart, say), the next delivery of it finishes the job: stage change, sequence stops, `meeting.booked` and the notification.

| Answer | When |
| --- | --- |
| `200` `{ ok, matched, event, meeting_id, ... }` | Recorded, or ignored (an event the engine does not use) |
| `400` `invalid_json` or `unrecognized_payload` | The body is not JSON, or not a shape the engine knows |
| `404` | Unknown or rotated URL |
| `413` | The body is larger than 256 KB |
| `500` | Something failed on our side; send it again (repeating is safe) |

The URL is the secret: anyone who has it can report bookings for this workspace, and the engine does not check the booking tool's own signature. Keep it in the tool's settings only and rotate it if it leaks.

## Tagged booking links

When the engine puts a booking link into a message for a person (reply drafts, and `{{booking_url}}` in campaign steps and emails), Calendly and Cal.com links carry the person's hidden booking code (`people.booking_ref`, created on first use, unique per workspace):

| Booking tool | Added to the link |
| --- | --- |
| Calendly (`calendly.com`) | `utm_content=<code>` and `utm_source=openoutbound` (another lead's code in `utm_content`, say from a link pasted out of a sent reply, is replaced; any other `utm_content` is left as it is) |
| Cal.com (`cal.com`, `app.cal.com`, `*.cal.com`) | `metadata[oo_ref]=<code>` |
| Any other tool | Nothing |

Both tools send the code back in their webhooks, so a meeting booked by an assistant, or from another address, still matches the right lead. `booking.tag_links: false` turns this off. `{{booking_url}}` resolves in every booking mode: you wrote it into the step yourself. A link pasted into the exact text of a reply goes out as it is, without the code.

## Record a meeting by hand

When a person or your agent books outside a booking tool (a phone call, a proposed time checked against a real calendar), record the meeting after booking it:

```bash
openoutbound --workspace acme meetings record --person-id pe_... --start-at 2026-10-06T15:00:00+02:00 --notes "Booked by phone after she proposed Tuesday afternoon."
```

| MCP action (`manage_meetings`) | CLI | What it does |
| --- | --- | --- |
| `list` | `meetings list` | Meetings, soonest first; filter by status, person and time |
| `get` | `meetings get` | One meeting |
| `record` | `meetings record` | Records a booked meeting (source `manual`) |
| `reschedule` | `meetings reschedule` | Moves it to a new start (the length stays unless you pass the end) |
| `cancel` | `meetings cancel` | Cancels it; `booking.after_cancel` runs |
| `mark_held` | `meetings mark-held` | Marks it held, optionally with `qualified` |
| `mark_no_show` | `meetings mark-no-show` | Marks it a no-show; `booking.after_no_show` runs. `undo` returns it to scheduled |
| `qualify` | `meetings qualify` | Marks it qualified or not |

A meeting can be marked held or a no-show only after it starts. If it took place at another time, reschedule it first. Calendly and Cal.com reschedules, cancellations and no-shows reach the record by themselves.

**Bookings that match no lead.** A booking from someone who is not a lead opens the problem "Meeting booked by <email>, who is not a lead" (kind `unmatched_booking`) and notifies you once. An assistant may have booked for a lead: find the lead and record the meeting for them with the booking's start time. When exactly one such problem has that start and its email is the lead's own address or comes from the lead's own or company domain (never a free mail domain such as gmail.com), the record takes over the booking, so later changes from the booking tool find it, and the problem resolves. If it is not a prospect at all, resolve the problem with `resolve_exception`.

## Statuses

| Status | How a meeting gets there |
| --- | --- |
| `scheduled` | Booked or rescheduled, or a no-show that was undone |
| `held` | Marked held, or counted as held `booking.assume_held_after_hours` after its start by the hourly job `meetings.assume_held` |
| `no_show` | Marked a no-show, or reported by the booking tool |
| `cancelled` | Cancelled in the booking tool or by hand. Only a reschedule by hand (`manage_meetings` action `reschedule`) brings it back |

A reschedule keeps the meeting `scheduled` with the new time and fires `meeting.rescheduled`. A cancellation moves the opportunity back to `interested` unless another meeting is scheduled, and fires `meeting.cancelled`. A booking from before meetings were recorded has no meeting record: its cancellation moves the opportunity back the same way but fires only `opportunity.updated`. A no-show fires `meeting.no_show`, a held meeting `meeting.held`. A cancellation or a no-show never restarts a stopped sequence. With `booking.assume_held_after_hours` at `0`, a meeting still unmarked 48 hours after its start opens a stuck problem (`meeting_unmarked`, see [Relationships](../concepts/relationships.md)).

## After a no-show or a cancellation

`booking.after_no_show` and `booking.after_cancel`:

| Value | What happens |
| --- | --- |
| `task` (default) | A follow-up task for a person, due now: "<name> missed the meeting: follow up" or "<name> cancelled the meeting: follow up" |
| `draft` | A short follow-up draft that answers the person's latest message and offers the booking link for a new time, always for review. Without a message to answer, without a link to offer (booking mode `handoff` or `off`, or no link set), or when a person owns the thread (see [Taking a thread over](../concepts/inbox.md#taking-a-thread-over)), a task instead |
| `nothing` | Nothing |

## Qualified meetings

A meeting can be marked qualified or not: action `qualify`, or `mark_held` with `qualified`. Judge it against `strategy.qualified_meeting`, from what happened in the meeting. The pipeline report counts meetings booked, held, no-shows and cancelled, the held rate and qualified meetings ([Reports](../concepts/reports.md#metric-definitions)); deal stages after the meeting (`won`, `lost`, values) live in `manage_pipeline`.

## Known limits

- The engine reads no calendar: it cannot see free or busy times, and a proposed time needs a person or your agent to check a real calendar.
- The Calendly and Cal.com payloads are read as their public webhook docs describe them and have not been tested against live accounts. Check the answer to the first real delivery (`matched`, `meeting_id`) before you rely on it.

In the sandbox, simulated prospects book through the tagged link in our replies and a few do not show up; `openoutbound --workspace northwind sandbox simulate` delivers pending bookings at once ([Sandbox](../getting-started/sandbox.md)).

Next: [Inbox](../concepts/inbox.md) · [CRM and notifications](crm-and-notifications.md) · [Reports](../concepts/reports.md) · [Events](../reference/events.md)
