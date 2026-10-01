# LinkedIn playbook

- LinkedIn has no open API for outreach, and its User Agreement bans automated invitations, messages and engagement; enforcement rose through 2025-2026, so automation stays off until the human accepts the account risk.
- When enabled, the engine enforces conservative per-account limits (15 invites a day and 80 a week, 40 messages, 60 visits, 30 likes, 10 human-reviewed comments), a ramp for new accounts, working hours and random gaps.
- Win on relevance, not volume: a trusted profile, short honest invites, a useful message after acceptance, and comments a human would sign.

## Contents

- [1. Risk statement](#1-risk-statement)
- [2. Safe limits](#2-safe-limits)
- [3. Ramp for new accounts](#3-ramp-for-new-accounts)
- [4. Working-hours behavior](#4-working-hours-behavior)
- [5. Invitations: note or no note](#5-invitations-note-or-no-note)
- [6. Message after acceptance](#6-message-after-acceptance)
- [7. Comments and likes](#7-comments-and-likes)
- [8. Profile checklist](#8-profile-checklist)
- [9. Signs of restriction and recovery](#9-signs-of-restriction-and-recovery)
- [10. What the engine enforces](#10-what-the-engine-enforces)

## 1. Risk statement

The facts:
- No open outreach API. LinkedIn's Invitations and Messages APIs are for approved partners only, partner messages must follow a specific member action, and the Sales Navigator partner program is not taking new partners ([Invitations API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/invitations), [Messages API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages), [Sales Navigator](https://learn.microsoft.com/en-us/linkedin/sales/)). Self-serve access covers sign-in and posting on the member's own behalf ([getting access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access)).
- The terms ban automation. Section 8.2 of the [User Agreement](https://www.linkedin.com/legal/user-agreement) (effective Nov 3, 2025) forbids bots or other unauthorized automated methods to add contacts, send messages, comment, like or share; the [prohibited software page](https://www.linkedin.com/help/linkedin/answer/a1341387) extends this to automation tools and extensions. Providers such as Unipile work through the member's own session, not an official API ([Unipile](https://www.unipile.com/send-invitations-using-linkedin-api-from-your-software-application/), vendor page).
- Enforcement is rising. LinkedIn sued Proxycurl, which shut down in July 2025 ([Nubela](https://nubela.co/blog/goodbye-proxycurl/)); a final consent judgment in Sept 2026 bars ProAPIs from scraping, fake accounts and bots ([The Record, Sept 2026](https://therecord.media/linkedin-wins-court-order-blocking-mass-scraping)); LinkedIn's site script checks browsers for 6,000+ extension IDs ([BleepingComputer, Apr 2026](https://www.bleepingcomputer.com/news/security/linkedin-secretly-scans-for-6-000-plus-chrome-extensions-collects-data/)); detected inauthentic activity rose 46% in H1 2026 ([Social Media Today, Sept 2026](https://www.socialmediatoday.com/news/linkedin-increases-push-against-inauthentic-activity/829385/)). Detection models read the type, order and timing of each account's actions; uniform traffic stands out ([LinkedIn Engineering](https://www.linkedin.com/blog/engineering/trust-and-safety/using-deep-learning-to-detect-abusive-sequences-of-member-activi)).
- The Marketing APIs are not a workaround: member data from them may not be used to find prospects, create leads, enrich a CRM or be combined with other data ([restricted uses](https://learn.microsoft.com/en-us/linkedin/marketing/restricted-use-cases)).

What this means for OpenOutbound:
- LinkedIn steps run through a provider (Unipile for now) inside the user's own logged-in account. That is automation LinkedIn's terms prohibit, whatever the limits. Limits lower the chance of detection; they do not make it compliant.
- The channel stays off until the human turns it on and accepts the risk in writing. The agent asks; it never enables LinkedIn on its own.
- Only the user's own real account. Never buy, rent or share accounts, never create profiles, never automate an account the user cannot afford to lose.
- OpenOutbound never scrapes LinkedIn and never exports profile data. It only acts (visit, invite, message, like, comment) on people already in the workspace from other sources.
- Zero-risk alternative: `task` steps. The engine drafts the note or message and creates a task; the human sends it by hand. Recommend this for small volumes and for accounts that matter.

## 2. Safe limits

Defaults per LinkedIn account. The engine never exceeds them; lowering them is always allowed.

| Action | Per day | Per week | Notes |
|---|---|---|---|
| Invitations | 15 | 80 | Auto-withdraw after 21 days without acceptance |
| Invitation notes, free account | - | 3 per month | 200 characters; Premium has no monthly cap |
| Messages (1st-degree connections only) | 40 | - | Includes follow-ups and replies |
| Profile visits | 60 | - | 1-2 days before an invite, never the same minute |
| Likes | 30 | - | Posts under 14 days old only |
| Comments | 10 | - | Always human reviewed by default |

Why these numbers: LinkedIn publishes none. It applies a weekly invitation limit to free and paid accounts alike, and hitting it usually blocks invitations for about a week ([LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/a550555)). It names the triggers: many invitations in a short time, and many invitations ignored, left pending or marked as spam ([LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/a551012)). Vendor guidance in 2026 ranges from 15-25 invitations a day and 80-100 a week ([Expandi](https://expandi.io/blog/linkedin-connections-limit/), [HeyReach](https://www.heyreach.io/blog/manage-multiple-linkedin-accounts), [lemlist](https://help.lemlist.com/en/articles/8514157-linkedin-connection-requests-limits-best-practices-avoiding-restrictions)) up to 80-100 a day ([Unipile](https://developer.unipile.com/docs/provider-limits-and-restrictions)); lemlist caps messages and visits at 30 a day each. All vendor claims. The defaults sit at the cautious end on purpose, because the same account also carries the user's own manual activity.

## 3. Ramp for new accounts

Use the ramp when the account is under 90 days old, has under 150 connections, has had no activity for 30 days, is automated for the first time, or is coming back from a restriction. Vendors describe similar ramps (lemlist starts near 5 invites a day and adds 2 a day; HeyReach suggests 10-15 a day for the first 2 weeks on accounts under 6 months old).

| Week | Invites per day (week cap) | Messages per day | Visits per day | Likes per day | Comments per day |
|---|---|---|---|---|---|
| 1 | 5 (25) | 15 | 20 | 10 | 3 |
| 2 | 8 (40) | 25 | 35 | 15 | 5 |
| 3 | 12 (60) | 30 | 50 | 20 | 8 |
| 4 and later | 15 (80) | 40 | 60 | 30 | 10 |

Hold the current level (do not advance) if acceptance is under 20% over the last 50 invites or any warning appears. After a restriction, restart at week 1 only after 7 days of manual-only use.

## 4. Working-hours behavior

- Only in the account's timezone, Monday to Friday, 08:30-18:00 by default, workspace holidays off.
- Random gaps of 2-12 minutes between actions, no bursts, a longer break around lunch.
- Vary daily totals by about 20% instead of hitting the cap at the same time every day.
- Order per person: visit, invite 1-2 business days later, message 1-3 business days after acceptance.
- The user's manual activity shares the same allowance. On heavy manual days, lower the automated caps.
- Stop at the first warning, CAPTCHA or verification prompt (section 9).

## 5. Invitations: note or no note

What the data says (vendor data): across 15.1M touchpoints in 2025, invitations with a note were accepted 25.3% of the time vs 27.6% without, but led to more replies, 8.2% vs 5.3% ([Belkins, Jun 2026](https://belkins.io/blog/linkedin-outreach-study)). AI-written templates got about 12% lower acceptance than human-written ones ([Expandi H2 2026](https://expandi.io/state-of-linkedin-outreach-h2-2026/)). Free members can add a note to only 3 invitations a month, 200 characters each ([LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/a563153)); older help pages still say 5, and 300 characters for Premium.

Default rule:
- Free account: no note by default. Save the 3 monthly notes for real hooks.
- Premium account: a short note (under 200 characters) when a real hook exists: the same event, their public content, a referral, a mutual connection who agreed to be named. No hook, no note.
- Never pitch, link or ask for a meeting in a note. Its only job is to make accepting feel natural. Write it like a person, not a template.
- Watch acceptance: under 20% over 100 invites points to targeting or profile problems. Pause invites and review.
- Keep pending invitations low: auto-withdraw after 21 days. After a withdrawal, LinkedIn blocks a re-invite to the same person for up to 3 weeks ([LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/a568295)); the engine waits longer.
- LinkedIn sorts incoming invitations into Focused and Other partly on authenticity signals, so a weak profile can hide an invite entirely ([LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/a542708)).

Good note (78 characters): "Saw your RevOps Days panel on forecast calls. Would be glad to stay connected."
Bad note: "Hi! I help companies like yours 10x pipeline with AI. Open to a quick call?"

## 6. Message after acceptance

- Wait 1-3 business days after acceptance. Most acceptances come within a day, so an instant message reads as automation.
- No "thanks for connecting" boilerplate and no pitch in the first message.
- Say why you connected, add one useful point, ask one easy question. Under 60 words, plain, no links in the first message.
- Same rules as email: evidence for every claim about them, no flattery, no fake familiarity ([playbook-copywriting.md](playbook-copywriting.md)).
- Never send the same text on email and LinkedIn. If an email is in flight, the LinkedIn message adds a different angle.
- At most 3 messages without a reply, 5-7 business days apart; vendor data shows 3-message sequences beating 5 or more ([Expandi H2 2026](https://expandi.io/state-of-linkedin-outreach-h2-2026/)). Inside the combined email and LinkedIn sequence, one message is enough.
- Any reply on either channel stops both.

Example (41 words): "Hi Priya, thanks for accepting. Your panel point about forecast calls turning into data arguments stuck with me. Some teams fix it by sending a list of deals without next steps the morning before. Is that a problem your team still has?"

## 7. Comments and likes

Comments are public and carry the user's name, so they are always human reviewed by default (`review: always`).

LinkedIn's [Professional Community Policies](https://www.linkedin.com/legal/professional-community-policies) ban artificially boosted engagement, including engagement pods, and section 8.2 covers automated comments and likes. In August 2026 LinkedIn began testing reports of low-effort AI content; flagged posts got about 40% fewer views ([Social Media Today, Aug 2026](https://www.socialmediatoday.com/news/linkedin-says-1m-people-have-reported-ai-slop/828465/)). A generic AI comment now costs reach as well as reputation.

A good comment:
- Adds something: a specific point, an experience, a number from the knowledge base, or a respectful question.
- Is 20-60 words, with no pitch, no link, no product mention and no tagging.
- Answers what the post actually says, so readers can tell the commenter read it.

Never:
- Generic praise ("Great insights!", "Love this!").
- Comments on sensitive posts: layoffs, job loss, illness, bereavement, politics, religion.
- More than 1 comment per person per week, or more than 2 per person in one sequence.
- Commenting on many posts of the same person in a short span.

Likes: only posts under 14 days old that the user would genuinely endorse. A like on a two-year-old post looks automated.

## 8. Profile checklist

Prospects check the sender's profile before accepting or replying, and trust signals affect whether an invitation is even seen. Fix the profile before any outreach:
- Real name and a recent, clear photo of the person's face.
- Headline says who you help and the outcome, in plain words ("Helping dental clinics answer every patient call"), not a list of titles.
- Banner that restates the offer or shows proof, readable on mobile.
- About: three short paragraphs (who you help, how, proof), then how to reach you.
- Featured: one case study or useful resource, not a sales deck. Creator mode is gone since 2024, but Featured and the follow button remain for everyone.
- Current role linked to the company page, with a one-line description.
- Custom profile URL, correct location, contact info matching the email signature.
- Same name, photo and title as the email signature, so the channels reinforce each other.
- Recent activity: a post or a thoughtful comment each week.
- Verification: free identity and workplace verification; LinkedIn says verified members get about 60% more profile views ([LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/a1359065), LinkedIn's own claim).

## 9. Signs of restriction and recovery

LinkedIn says automated activity can lead to a temporary or permanent restriction, and access returns after an on-screen identity check ([LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/a1340522)). An automation notice states when the account unlocks once the tool is turned off ([LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/a1340567)). Identity checks use a government ID through Persona ([LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/a1342692)).

Warning signs:
- Security checks, CAPTCHAs or forced logouts.
- An invitation limit message, or notices about "automated activity" or "prohibited software".
- A request for identity verification.
- A "restricted" notice, or actions failing through the provider.
- A sudden drop in acceptance rate (vendors flag a fall of more than 20% week over week), or messages that do not deliver.

What the engine does: stops all actions for the account, sets status `restricted`, emits `linkedin.account_restricted` and notifies the human.

What the human does:
1. Keep automation off. Log in manually and complete any verification yourself. Never automate verification.
2. Do not create a new account to get around a restriction; that breaks the terms again and risks a permanent ban.
3. After access returns, use the account manually for at least 7 days.
4. Withdraw old pending invitations.
5. Find the cause: a volume spike, low acceptance, identical messages, many ignored invites, actions outside working hours.
6. Resume at ramp week 1 with the cause fixed, or keep LinkedIn in task mode.
7. If the restriction is permanent, appeal once through LinkedIn support and accept the outcome.

## 10. What the engine enforces

- Per-account daily and weekly caps with the ramp, working hours in the account timezone, random gaps of 2-12 minutes, weekends off.
- The free-account note cap (3 per month) and note length (200 characters free, 300 Premium).
- Invites auto-withdrawn after 21 days; no re-invite of a withdrawn or declined person for at least 30 days; messages only to 1st-degree connections (otherwise the step follows `missing_data`).
- Comments always go to human review unless the workspace changes it knowingly.
- Stop and alert on restriction signals; the account stays `restricted` until a human resumes it.
- LinkedIn suppressions (`type: linkedin`) and person suppressions apply to every LinkedIn action.
- A reply on any channel stops the person's sequence on all channels.
- No scraping, no profile exports, no data from LinkedIn's Marketing APIs used for prospecting.
