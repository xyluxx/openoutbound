# Deliverability playbook

- Meet the Gmail, Yahoo and Microsoft sender rules on every mailbox regardless of volume: SPF, DKIM, aligned DMARC, one-click unsubscribe (RFC 8058), spam complaints under 0.1% (never 0.3%), bounces under 2%.
- Send modest volume from real, clearly branded mailboxes: 2-3 per domain, 30 cold emails a day each after a 6-week ramp, verified addresses only, plain text, no tracking.
- The engine watches bounces, failures, rejections and complaints and pauses a mailbox automatically; the fix is always the cause (list, content, volume), never more domains.

## Contents

- [1. Sender requirements in 2026](#1-sender-requirements-in-2026)
- [2. What the industry thinks of cold email](#2-what-the-industry-thinks-of-cold-email)
- [3. Domains and mailboxes](#3-domains-and-mailboxes)
- [4. Ramp schedule](#4-ramp-schedule)
- [5. List hygiene](#5-list-hygiene)
- [6. Content rules](#6-content-rules)
- [7. Tracking pixels and links](#7-tracking-pixels-and-links)
- [8. Monitoring and auto-pause](#8-monitoring-and-auto-pause)
- [9. When a mailbox is flagged](#9-when-a-mailbox-is-flagged)
- [10. Microsoft 365 and Google Workspace notes](#10-microsoft-365-and-google-workspace-notes)

## 1. Sender requirements in 2026

| Provider | All senders | Bulk senders | Thresholds | Enforcement |
|---|---|---|---|---|
| Gmail ([guidelines](https://support.google.com/a/answer/81126), [FAQ](https://support.google.com/a/answer/14229414)) | SPF or DKIM, valid forward and reverse DNS, TLS, RFC 5322 format, DKIM key 1024 bits or more | 5,000+ messages a day to personal Gmail (permanent status once reached): SPF and DKIM, DMARC (p=none is enough), From domain aligned with SPF or DKIM, one-click unsubscribe plus a visible link | Spam rate under 0.10%, never 0.30%; unsubscribes processed within 48 hours (recommended) | Phased in from Feb 2024; "ramping up" enforcement with temporary and permanent rejections since Nov 2025 |
| Yahoo and AOL ([best practices](https://senders.yahooinc.com/best-practices/)) | SPF or DKIM, spam rate under 0.3%, valid forward and reverse DNS | No published volume threshold: SPF and DKIM, DMARC p=none or stricter, list-unsubscribe (RFC 8058 preferred) plus a visible link | Unsubscribes honored within 2 days | Since Feb 2024; unsubscribe since Jun 2024 |
| Outlook.com, Hotmail, Live | Microsoft recommends valid From and Reply-To, working unsubscribe, list hygiene | 5,000+ messages a day: SPF, DKIM, DMARC p=none or stricter, aligned | - | Rejected with `550 5.7.515` since May 5, 2025 ([dmarcian summary](https://dmarcian.com/microsoft-enforces-spf-dkim-dmarc/)) |
| European providers | GMX and WEB.DE require an aligned DKIM signature and a PTR record ([GMX](https://postmaster.gmx.net/en/requirements-and-recommendations)); Orange requires SPF, DKIM and DMARC, TLS 1.2+ ([Orange](https://postmaster.orange.fr/)) | Orange: over 1,000 a day needs RFC 8058 one-click unsubscribe and a Feedback-ID header | Orange: complaints at 0.6% trigger protections, moving to 0.3% | Current |

Two things to know:
- Gmail's bulk rules cover mail to personal Gmail addresses, not mail to companies on Google Workspace ([FAQ](https://support.google.com/a/answer/14229414)). Most B2B prospects sit on Workspace or Microsoft 365, whose filters use the same signals. OpenOutbound applies the bulk-sender standard to every mailbox anyway: it costs nothing and removes a whole class of rejections.
- No mailbox provider publishes a bounce-rate limit. "Under 2%" is vendor guidance ([Instantly 2026 benchmark](https://instantly.ai/cold-email-benchmark-report-2026)); Smartlead calls 2-4% a warning and over 4% damaging ([Smartlead](https://www.smartlead.ai/blog/cold-email-bounce-rate)). Treat 2% as the line.

What the engine does on every mailbox: checks MX, SPF, DKIM (selector probe) and DMARC with fix hints (`openoutbound doctor`) and again every day, opening a `dns_failed` problem when a record stops passing or turns red (the mailboxes keep sending), sends plain text with a proper Message-ID and threading headers, adds `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` plus a visible unsubscribe line and postal address, and suppresses unsubscribes at once.

## 2. What the industry thinks of cold email

Be honest with users about this. The anti-abuse industry body M3AAWG published a position in November 2025: cold email sent in bulk and dressed up as one-to-one mail, using lookalike domains, many sending accounts, random intervals or AI personalization to avoid spam filters, is abusive; bypassing volume limits, masking sending domains and artificially simulating engagement are "not acceptable in any manner" ([M3AAWG position](https://www.m3aawg.org/sites/default/files/doc_files/m3aawg_position_on_cold_email.2025_0.pdf)). Its sender best practices call artificial warming not recommended and advise warming new domains "low and slow" over about 6 weeks ([M3AAWG BCP, Aug 2026](https://www.m3aawg.org/sites/default/files/doc_files/m3aawg-sender-best-common-practices-aug-27-2026--1-.pdf)). Cold email vendors recommend lookalike domains, mailbox rotation and always-on warmup networks. These positions conflict.

OpenOutbound's stance:
- Send low volumes of researched, relevant, honest email to people with a clear professional reason to hear from you. Identify yourself fully; make opting out effortless; stop at the first sign of harm.
- Pacing (random gaps, daily caps, sending windows) exists to keep volume human-scale and inside provider limits, never to disguise bulk mail or get around a block.
- If hitting a goal would take more than about 3 domains with 3 mailboxes each, the targeting is too broad. Narrow the ICP instead of adding infrastructure.
- Third-party warmup networks simulate engagement. The engine does not include one; the default warmup is a ramp of real sends. Using a network is the user's decision, made knowing the M3AAWG position.

## 3. Domains and mailboxes

Domains:
- Keep cold email off the primary domain, so customer and transactional mail keeps its reputation (vendor consensus, for example [lemlist](https://lemlist.com/blog/how-to-set-up-your-sending-infrastructure-for-cold-email-without-burning-your-domain-)).
- A secondary domain must be clearly yours: the brand name plus a plain word (`getbrand.com`, `brandhq.com`), a redirect to the main website, and the same company name and postal address in the footer. No hyphens, numbers, misspellings or exotic top-level domains; never a domain that imitates someone else's.
- Alternative with more transparency and less isolation: a subdomain of the main domain (`mail.brand.com`), which M3AAWG prefers over lookalike domains.
- New domains: DNS set up and no cold email for at least 2 weeks; lemlist suggests 4. Never use a fresh domain to escape a bad reputation.
- DNS per domain: SPF with only the services that send for it, DKIM 2048-bit, DMARC starting at `p=none` with aggregate reports (`rua`), moving to `p=quarantine` once reports are clean. BIMI needs `p=quarantine` or stricter.

Mailboxes:
- 2-3 mailboxes per domain (OpenOutbound default). Sources range from 1 to about 8, so there is no consensus; 2-3 limits the blast radius of one problem while keeping each domain's volume modest.
- Daily cap: 30 cold emails per mailbox after the ramp (engine default `daily_limit: 30`). Vendor guidance for 2026: lemlist calls 25-35 safer and 40 the maximum; Smartlead says at most 50, with a platform median of 14 ([Smartlead](https://www.smartlead.ai/blog/how-many-cold-emails-per-day)). Replies favor low volume too: mailboxes averaging 1-20 emails a day had a 2.0% median reply rate vs 0.5% at 101-200 a day, across 7,676 mailboxes ([Woodpecker](https://woodpecker.co/cold-email-benchmarks/)). Keep each domain at or under 90 cold emails a day.
- Provider ceilings are far higher (Google Workspace 2,000 messages and 3,000 external recipients a day; Microsoft 365 10,000 recipients a day and 30 messages a minute) and irrelevant: behavior-based filters react long before.
- Real people: a real sender name, photo, signature and a human who reads replies. Mixed providers (some Google, some Microsoft) spread risk.
- Engine pacing: random gaps of 4-12 minutes (`min_gap_seconds` 240, `max_gap_seconds` 720), a per-recipient-domain throttle, sending windows in the lead's timezone, holidays off.

Capacity: steady-state sends are about `daily_new_leads` x email steps. Mailboxes needed = sends per day / 30. See [playbook-sequences.md](playbook-sequences.md).

## 4. Ramp schedule

Per new mailbox. The engine stores this in the mailbox `ramp` and caps sends accordingly; status is `warming` until week 8.

| Week | Cold emails per mailbox per day | What else happens |
|---|---|---|
| 1 | 0 | DNS (SPF, DKIM, DMARC, MX), website redirect, profile photo and signature, `openoutbound doctor` passes, a few real emails to people you know |
| 2 | 0 | Real, low-volume mail and replies only |
| 3 | 5 | Best-fit, freshly verified tier A leads only |
| 4 | 10 | |
| 5 | 15 | |
| 6 | 20 | |
| 7 | 25 | |
| 8 and later | 30 (default cap) | Raise toward 40 only after 4 weeks with bounces under 1%, no complaints and a steady reply rate |

Rules:
- Do not advance a week while bounces are over 2% or any warning is open; after an auto-pause, resume with `restart_ramp` (section 9).
- Pre-warmed mailboxes bought from a vendor start at week 5 and still ramp: the new sending pattern is what filters judge.
- Agents cannot skip ahead on their own: raising a daily limit above 50, or turning off or shortening the ramp of a mailbox that is still warming, waits for a human approval (kind `mailbox_limits`, decided in `review_items`). Lowering a limit or slowing a ramp applies at once.
- This matches the 4-6 week ramps vendors describe ([Instantly 2026](https://instantly.ai/cold-email-benchmark-report-2026)) and M3AAWG's "about 6 weeks" for new domains.

## 5. List hygiene

- Verify every address before its first send. Re-verify at send time when the last check is over 30 days old (vendors range from 30 to 90 days; B2B contacts churn fast). Data from lead databases always gets re-verified.
- Status policy: `valid` sends; `invalid` is suppressed; `risky` and `unknown` are skipped unless a second verifier says valid; `catch_all` follows `sending.catch_all`.
- Catch-all policy (catch-alls are 15-30% of typical B2B lists per [lemlist](https://lemlist.com/blog/email-verification-tools-how-to-choose-accuracy-over-marketing-promises), vendor claim): `skip` (default) or `allow`, which treats them as valid (not recommended). If you must reach catch-alls, send them from a dedicated, fully ramped mailbox at half the daily cap and watch its bounces daily; the engine does not automate that split yet.
- Role addresses (`info@`, `sales@`) are weak B2B targets: prefer a named person; the local-business variant may use a verified `info@` as a fallback. The engine blocks addresses that must never get cold email (`abuse@`, `postmaster@`, `noreply@` and similar).
- Hard bounce: suppress at once. Soft bounce: retry up to 2 times over 72 hours; an address that soft-bounces twice across two weeks is treated as invalid. B2B servers often bounce hours or days later, so late bounces are processed too (M3AAWG BCP).
- Only bounces about the address count (unknown user 5.1.1, disabled mailbox 5.2.1, no such domain). A bounce that refuses the sender (authentication codes such as 5.7.26 or 5.7.515, x.7.28, blocklist, reputation or policy blocks, rate limits) is the sender's problem: it goes to the mailbox's health and the pauses in section 8, never to the recipient's bounce count or the suppression list.
- Never buy lists, never mail harvested addresses of unknown origin; that is how spam traps get hit, and a trap hit outweighs almost any other signal ([Spamhaus](https://www.spamhaus.org/resource-hub/ip-reputation/email-compliance-and-reputation-the-inbox-remembers/)).

## 6. Content rules

- Plain text. No images, no attachments, no link in the first touch, no URL shorteners.
- One consistent From name and address per mailbox; replies go to the same mailbox.
- Minimal signature, then the engine footer (sender identity, postal address, unsubscribe line). Never remove the footer or the unsubscribe headers.
- Personalize to be relevant, never to make identical bulk mail look unique. No spintax.
- Keep copy rules from [playbook-copywriting.md](playbook-copywriting.md): short, one question, no hype phrases.
- A sudden change in content, volume or audience on a mailbox looks like a new sender. Change one thing at a time.

## 7. Tracking pixels and links

Open and click tracking are off by default (`sending.tracking.opens` and `clicks` false).
- Opens are unreliable: Apple Mail Privacy Protection loads remote content, pixels included, in the background whether or not anyone reads the email ([Apple](https://www.apple.com/legal/privacy/data/en/mail-privacy-protection/)), and Apple accounted for about 62% of tracked opens in July 2026 ([Litmus](https://www.litmus.com/email-client-market-share)).
- A pixel adds a remote image to a plain-text-style email, and click tracking rewrites links through a tracking domain whose reputation you share; SURBL even runs a list of click-tracking domains ([SURBL](https://www.surbl.org/lists)).
- Correlation, not proof: in 31M emails sent in 2025, campaigns without open tracking had a 7.4% reply rate vs 4.4% with it ([Hunter](https://hunter.io/the-state-of-cold-email), vendor data). No published test isolates the effect on inbox placement.
- Measure replies and positive replies instead. If a user insists on click tracking, use a custom tracking subdomain (CNAME) on the sending domain, never a shared one, and only in follow-ups that contain a link.

## 8. Monitoring and auto-pause

| Signal | Warn | Auto-pause | Window and minimum | Action after pause |
|---|---|---|---|---|
| Hard bounce rate | 2% | Over 3% | 7 days, 20+ sends | Re-verify the list source; resume with `restart_ramp` |
| Consecutive send failures | 3 | 5 | - | Check credentials, OAuth token, provider status |
| Authentication rejections: Gmail `550 5.7.26`, `5.7.27`, `5.7.30`, `5.7.32`; Microsoft `550 5.7.515` | - | First one | - | Run DNS checks; fix SPF, DKIM, DMARC or alignment |
| Unsolicited-rate blocks: Gmail `421 4.7.28` or `550 5.7.28` | - | First one; pauses the whole domain for 48 hours | - | Cut volume 50%; review targeting and content |
| Provider rate or quota errors (Microsoft 30 per minute, Google daily limits) | - | Pause until the window resets | - | Lower caps; the engine should never hit these |
| Spam complaint rate, where visible (Google Postmaster Tools, Yahoo feedback loop) | 0.1% | 0.3% | 7 days | Stop the campaign; review the list and copy |
| Negative plus unsubscribe replies | 1% of delivered | 2% of delivered (pauses the campaign) | 7 days, 100+ sends | Human review of targeting and copy |
| Domain on Spamhaus DBL or a major URI list | - | Listing detected (pauses the domain) | Daily check | Fix the cause, then request removal (free) at [Spamhaus](https://www.spamhaus.org/blocklists/domain-blocklist/) |
| Reply rate collapse | Under half the mailbox's 30-day average | - | 150+ sends | Check inbox placement with a seed test; reduce volume |
| Reply sync (IMAP) failing | 30 minutes of failed syncs | - | - | Fix the login or server: until then replies, bounces and unsubscribes by reply go unseen |

Gmail codes and their meaning are in Google's [SMTP error reference](https://knowledge.workspace.google.com/admin/support/troubleshooting/gmail-smtp-errors-and-codes). Register sending domains in Google Postmaster Tools; its compliance status dashboard shows authentication, unsubscribe and spam-rate checks with about a day of lag ([Google](https://support.google.com/a/answer/14668346)). Postmaster data only appears at meaningful volume, so for low-volume senders the reply-based signals above are the early warning.

The engine auto-pauses on the bounce, consecutive-failure, authentication-rejection and unsolicited-rate rows. Provider blocks pause every mailbox on the sending domain; an x.7.28 block lifts by itself after 48 hours, the others wait for a human to resume. Mail held by a bounce or block pause waits for its mailbox instead of moving to another sender, so a pause is never routed around. After a person resumes a mailbox, its bounce rate counts only the sends from then on. Reply sync failures show in the attention queue. The other rows are recommended additions for engine builders, and until they ship the agent should check them in the daily review.

## 9. When a mailbox is flagged

1. Pause first. The engine pauses the mailbox and emits `mailbox.paused`; for domain-level signals, pause every mailbox on the domain.
2. Diagnose: `openoutbound doctor` for DNS and authentication; the bounce and rejection log for codes; which campaign, segment and list source the problem sends came from; blocklist checks; Postmaster Tools if available.
3. Fix the cause: bad list source (re-verify or drop it), wrong audience (tighten the ICP), content (links, hype, sameness), or volume (caps too high, ramp skipped).
4. Keep the mailbox alive: replies to existing conversations continue; no new cold sends.
5. Resume with `restart_ramp` (`manage_mailboxes` action `resume`): the ramp starts again today at its start volume (5 a day by default) and goes back up 5 a week, one ramp week at a time.
6. Retire a domain only when the damage is lasting (a DBL listing that returns, or spam placement for weeks after the fix). Do not spin up a replacement with the same list and copy; that repeats the problem and is exactly the behavior M3AAWG calls abusive.

## 10. Microsoft 365 and Google Workspace notes

Microsoft 365 (Exchange Online):
- Basic authentication for IMAP, POP and other protocols is permanently off, so reading replies needs OAuth ([Microsoft](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online)).
- SMTP AUTH with basic authentication: unchanged through December 2026; disabled by default for existing tenants at the end of December 2026 (admins can re-enable); not available by default for tenants created after that; final removal date to be announced in the second half of 2027 ([Microsoft, Jan 2026](https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835)).
- Use OAuth (XOAUTH2): delegated scopes `SMTP.Send`, `IMAP.AccessAsUser.All` and `offline_access`, or app-only `SMTP.SendAsApp` and `IMAP.AccessAsApp` with admin consent and mailbox permissions ([Microsoft](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)). The mailbox must still allow authenticated SMTP; ask the tenant admin.
- Limits: 30 messages a minute and 10,000 recipients a day per mailbox, plus a tenant-wide external recipient limit; the planned 2,000-per-mailbox external limit was cancelled in January 2026 ([limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits), [BleepingComputer](https://www.bleepingcomputer.com/news/microsoft/microsoft-cancels-plans-to-rate-limit-exchange-online-bulk-emails/)). Never send from an `onmicrosoft.com` address: it is capped at 100 external recipients a day.

Google Workspace:
- Plain account passwords stopped working for IMAP and SMTP on March 14, 2025; OAuth is required, with app passwords as the exception ([Google](https://knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth)).
- App passwords still work in 2026 with 2-Step Verification, but Google calls them not recommended, and they are unavailable under Advanced Protection or when an admin blocks them ([Google](https://support.google.com/accounts/answer/185833)). They are the simplest self-host path: the human creates one and adds the mailbox with `openoutbound mailboxes add` in their own terminal, or in a CSV file passed to `manage_mailboxes` `import_csv` by path, never in chat.
- OAuth for mail uses the restricted `https://mail.google.com/` scope. A public app needs verification and a yearly security assessment; unverified apps are capped at 100 users, and Testing-mode authorizations expire after 7 days. Internal-only Workspace apps and domain-wide installs are exempt from the assessment ([Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)). Self-hosters: use an internal app, an admin-trusted app, or a domain-wide delegation service account.
- Limits: 2,000 messages and 3,000 external recipients a day per user (500 each on trials), at most 100 recipients per message over SMTP ([Google](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace)).
