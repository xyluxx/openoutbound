# Sequences playbook

- Five built-in sequences: email-only (4 touches, about 14 days), email plus LinkedIn (6 core touches plus 2 optional), local business (3 touches), event follow-up and closed-lost re-engagement, each with exact steps, waits and reasons.
- Sends go out on working days inside the recipient's local business hours; every follow-up brings a new angle, and any reply, meeting or opt-out stops everything.
- A/B tests change one variable, fix the sample size before starting, measure positive replies (never opens) and stop early only for harm.

## Contents

- [1. Principles](#1-principles)
- [2. Email only, 4 touches](#2-email-only-4-touches)
- [3. Email plus LinkedIn](#3-email-plus-linkedin)
- [4. Local business, 3 touches](#4-local-business-3-touches)
- [5. Event follow-up](#5-event-follow-up)
- [6. Re-engage closed-lost](#6-re-engage-closed-lost)
- [7. Timing](#7-timing)
- [8. Capacity planning](#8-capacity-planning)
- [9. A/B testing](#9-ab-testing)
- [10. When to stop](#10-when-to-stop)

## 1. Principles

What the data says (vendor data from each vendor's own platform):
- The first email carries the most: 58% of replies come from step 1 ([Instantly 2026](https://instantly.ai/cold-email-benchmark-report-2026)); by step, reply rates run 0.59%, 0.32%, 0.30%, 0.34% ([Belkins](https://belkins.io/blog/sales-follow-up-statistics), 7.5M emails).
- Follow-ups still matter: three emails got 6.8% replies vs 3.3% for one ([Hunter 2026](https://hunter.io/the-state-of-cold-email)); steps 3-5 booked 53.5% of email-sourced meetings (Belkins).
- More is not better: the fourth email gets about half the median reply rate of the first, and emails 5-6 about 30% ([Woodpecker](https://woodpecker.co/cold-email-benchmarks/)); four or more follow-ups raised unsubscribe and spam complaint rates more than 3x ([Belkins](https://belkins.io/blog/sales-outreach-strategy), 2024 data).
- Gaps: waiting about 3 days beat both shorter and longer gaps ([Belkins](https://belkins.io/blog/cold-email-outreach-statistics), 2023 data); vendors suggest 2-4 days early in a sequence.
- Contacts per company: emailing 1-2 people per company replied better than 3 or more (Hunter 2026). Keep `contact_cap_per_company` at 2-3 and stagger.

Rules:
- Fewer, better touches. Four emails is the default ceiling for cold outreach; more rarely adds replies and adds complaints.
- Every touch has a job: a new angle, a new proof, a useful resource, or a clean close ([playbook-copywriting.md](playbook-copywriting.md)).
- Waits grow: short early (the first days carry most replies), longer later (give people room).
- Channels support each other; they never repeat the same text.
- The engine counts waits in calendar days and moves a send that lands on a weekend or holiday to the next working day.

## 2. Email only, 4 touches

Template `signal_based_email_4`. The default for B2B tiers A to C.

| Step | Day | Channel | Mode | Angle | Length |
|---|---|---|---|---|---|
| 1 | 0 | Email | New thread | Signal-led problem, one interest question | 50-90 words |
| 2 | 3 | Email | Reply in thread | Proof story from a similar company | 25-70 words |
| 3 | 7 | Email | Reply in thread | Useful resource or insight, offered not attached | 25-70 words |
| 4 | 14 | Email | New thread, new subject | Close the loop: timing or right person | 25-50 words |

Why: step 1 does most of the work; step 2 comes while the first email is still findable; step 3 gives a reason to reply that is not a meeting; step 4 in a new thread gets a fresh look and ends politely.

## 3. Email plus LinkedIn

Template `email_linkedin_6`. For tier A and for personas active on LinkedIn. Needs a connected LinkedIn account and the risk acknowledgment ([playbook-linkedin.md](playbook-linkedin.md)).

| Step | Day | Channel | Action | Notes |
|---|---|---|---|---|
| 1 | 0 | LinkedIn | Profile visit | Optional soft touch |
| 2 | 1 | Email | First touch, new thread | Signal-led |
| 3 | 2 | LinkedIn | Invitation, no note by default | Note only with a real shared context |
| 4 | 4 | Email | Reply in thread: proof story | |
| 5 | 6 | LinkedIn | Message if connected | Condition `linkedin_connected`; otherwise skip to step 6 |
| 6 | 9 | Email | Reply in thread: resource | |
| 7 | 12 | LinkedIn | Like a post under 14 days old | Optional soft touch; skip if none |
| 8 | 16 | Email | New thread: close the loop | |

Why: the visit and invite make the email sender recognizable; the LinkedIn message lands after the proof email, with a different angle; soft touches are optional so the sequence never forces fake engagement.

Evidence is thin and vendor-made: practitioners report multichannel prospects converting at up to 3x single-channel ones ([Belkins](https://belkins.io/blog/sales-outreach-strategy), quoting Jason Bay); cold calls nearly doubled email reply rates ([Gong, 2024](https://www.gong.io/blog/the-hidden-power-of-cold-calling-insights-from-300m-calls)); Hunter's 2026 survey found 50.5% of decision makers prefer LinkedIn and 25% email, a reversal of its 2025 survey. Test the combined sequence against email-only before making it the default.

## 4. Local business, 3 touches

Template `local_business_3`. For clinics, trades, restaurants and other owner-run businesses.

| Step | Day | Channel | Action | Notes |
|---|---|---|---|---|
| 1 | 0 | Email | Observation-led first touch | One specific thing seen on their site, listing or reviews |
| 2 | 4 | Email | Reply in thread: local proof | A similar business nearby, one number from the knowledge base |
| 3 | 10 | Email or task | Close the loop, or a phone call task for tier A | A human makes the call; the engine drafts talking points |

Why: owners read email between appointments and shared inboxes (info@) get triaged by staff, so fewer, more specific touches work better; a phone call often reaches the decision maker faster than a fourth email.

Evidence is thin: no 2025-2026 study covers clinics or trades specifically. The closest data: companies with 0-10 employees replied at 0.72% vs 0.22% at 10,000+, and founders and owners replied 35% more than C-level executives ([Belkins 2026](https://belkins.io/blog/cold-email-response-rates)); cold calling nearly doubled email reply rates in 300M+ calls ([Gong, 2024](https://www.gong.io/blog/the-hidden-power-of-cold-calling-insights-from-300m-calls)). The template is a judgment call built on those.

## 5. Event follow-up

Template `event_follow_up`. Only for people with evidence of attendance: your booth scans or meetings, their session, or the published attendee, speaker or exhibitor list.

| Step | Day | Channel | Action | Notes |
|---|---|---|---|---|
| 1 | Event end + 1 working day | Email | Reference the session, booth or topic | If you met: say what you talked about, accurately; if not: never "great meeting you" |
| 2 | +1 | LinkedIn | Invitation with a short note naming the event | The event is a real shared context |
| 3 | +5 | Email | Reply in thread: a resource tied to the event topic | |
| 4 | +10 | Email | Reply in thread: close the loop | |

Why: memory of the event fades within days, and every other exhibitor emails the same list; the first email must be early and specific.

Evidence: no 2025-2026 data compares 24-hour and 48-hour follow-up; the case for "next working day" rests on older anecdotes and common sense. Measure it in your own campaigns.

## 6. Re-engage closed-lost

Template `re_engage_lost`. Eligibility: lost at least 90 days ago (or after the date they gave), a known lost reason, no negative reply or opt-out, still inside the ICP, and a reason to write now: a new signal, or a product change that answers the lost reason.

| Step | Day | Channel | Action | Notes |
|---|---|---|---|---|
| 1 | 0 | Email, new thread, from the original owner if possible | Honest reference to the past conversation plus what changed | Real history, accurate dates |
| 2 | 5 | Email | Reply in thread: proof that addresses the lost reason | |
| 3 | 12 | Email or task | Close the loop, or a call task | |

Why: this is the one sequence where familiarity is real, so use it, but only with an actual change to talk about. "Just checking if anything changed" is not a reason.

Evidence (practitioner and vendor guidance): time reactivation by the loss reason: bad timing after 60-90 days, budget 30-45 days before the budget cycle resets, lost to a competitor about 90 days before that contract renews ([lemlist, 2026](https://lemlist.com/blog/how-to-reactivate-close-lost-deals-using-call-insights)); triggers such as a past champion joining, a new executive or new funding matter more than the calendar ([UserGems](https://www.usergems.com/blog/closed-lost-re-engagement-playbook)).

## 7. Timing

What the data says (vendor data): Wednesday and Thursday did best (0.48% replies each), 8:00-12:00 local time best (0.54%), late evening worst ([Belkins 2026](https://belkins.io/blog/cold-email-response-rates)); Wednesday peaks, Friday brings the most auto-replies, and sending in the prospect's local time is the main rule ([Instantly](https://instantly.ai/blog/best-time-to-send-cold-email/)); weekend replies ran about 38% lower ([Woodpecker](https://woodpecker.co/cold-email-benchmarks/)); Hunter 2026 found no day-of-week effect. The differences are small next to relevance: working days, local morning, and a human who can answer quickly matter most.

Rules the engine applies:
- Recipient timezone first (`timezone_mode: lead`): the person's timezone, then the company's, then the country default, then the campaign fallback.
- Default window: working days, 08:00-17:00 local (`start_hour`, `end_hour`); workspace holidays and blackout ranges skipped.
- Within the window, favor 08:00-12:00 local when capacity allows; afternoons take the overflow. Avoid Friday afternoons for first touches.
- Mailbox pacing: random gaps of 4-12 minutes between sends per mailbox, a per-recipient-domain throttle, and daily caps with ramp ([playbook-deliverability.md](playbook-deliverability.md)).
- Follow-ups inherit the thread's local time of day, give or take an hour, so they do not all land at 08:00.
- Replies from the engine go out after 3-12 minutes inside working hours ([playbook-replies.md](playbook-replies.md)).

## 8. Capacity planning

Steady-state daily email sends are about `daily_new_leads` x the number of email steps. Example: 20 new leads a day on a 4-email sequence settles near 80 sends a day, which needs 3 mailboxes at 30 a day. Plan senders before raising `daily_new_leads`. Campaign `priority` (0-100) decides which campaign gets a mailbox's capacity when several compete.

## 9. A/B testing

Rules:
1. One variable per test: angle, CTA, opener type, subject, length or send time. Never two at once.
2. Randomize at enrollment with an even split (`variant_seed`); keep everything else identical, including senders and timing.
3. Primary metric: positive reply rate (`interested`, `meeting_request`, `referral`) per delivered first touch, counted 14 days after the last step. Never opens: privacy proxies and our default of no tracking pixel make them meaningless.
4. Fix the sample size before starting (table below). If you cannot reach it within about 6 weeks, test a bigger change or pool similar campaigns.
5. No stopping early for a win. Peeking and stopping on a good day finds false winners.
6. Stop early only for harm: bounce rate over 3%, any spam complaint spike, or negative plus unsubscribe replies at twice the control rate with at least 5 events.
7. Winner: two-proportion z-test p under 0.05, or a Bayesian probability of at least 95% that the variant is better, at the planned sample. Otherwise call it "no difference" and keep the simpler variant. The campaign report (`get_report` type `campaign`) shows per email step the `leader`, its `confidence` (the probability it really is the best) and `enough_data` (every variant has 50 or more sends); that is a floor, not the planned sample.
8. End the test with `create_campaign` action `pick_winner` (`campaign_id`, `step_id`, `variant_key`), dry run first, after the human agrees. Only the winner stays in the step, people mid-sequence keep their place, and the change log records it so its results are tracked. The engine never picks a winner by itself.
9. Test in this order of impact: offer or angle, CTA, opener or personalization type, subject, length, send time.
10. Log each test in the campaign: hypothesis, variable, planned sample, dates, result.

Sample size per variant for 80% power at 5% significance (two-sided):

| Baseline positive reply rate | Detect 1.5x | Detect 2x | Detect 3x |
|---|---|---|---|
| 1% | 7,750 | 2,319 | 769 |
| 2% | 3,826 | 1,141 | 376 |
| 3% | 2,518 | 749 | 245 |
| 5% | 1,471 | 435 | 141 |
| 8% | 882 | 258 | 82 |

Reading it: with 200 per variant at a 3% baseline you can only detect about a 3.3x difference. Small senders should test big swings, or use total reply rate as an early read and confirm with positive replies.

Cross-check: Woodpecker's calculator gives the same order of magnitude (about 1,171 per variant to detect a doubling from a 1.5% baseline) and notes that stopping at the first moment a test hits 95% picks a false winner roughly one time in four ([Woodpecker](https://woodpecker.co/cold-email-ab-test-calculator/)). Advice to test with 100-200 per variant only works for opens or for very large differences.

## 10. When to stop

Per person, the engine stops the sequence on:
- Any reply (`stop.on_reply`), including out-of-office handling (pause, then resume).
- A reply from anyone at the same company (`stop.on_company_reply`), by default.
- A booked meeting (`stop.on_meeting`).
- Bounce, unsubscribe, complaint or negative reply (suppressed everywhere).
- A privacy request (suppressed everywhere, every sequence stops at once).
- A person answering the lead from their own mailbox, or taking the thread over (reason `person_took_over`).
- A CRM fact (customer, an open deal unless `crm.allow_outreach_with_open_deal`, an owned account with `crm.skip_owned_accounts`, do not contact) stops the sequences of the company or person it is about.
- A company hold pauses the sequences at that company until the hold ends; they continue afterwards.
- The last step, then the campaign `end_action` (none, tag or list).

Beyond one sequence:
- `rest_days_after_campaign` (default 30): no new campaign for the person during the rest period.
- `one_active_campaign_per_person`: never two sequences at once.
- After two complete sequences with no reply, park the person for 6 months unless a new signal with intent 60+ appears.
- Stop a whole campaign when its positive reply rate stays under half the workspace average after 300 delivered first touches, or when negative replies exceed 2% of delivered: fix targeting or copy before sending more.
