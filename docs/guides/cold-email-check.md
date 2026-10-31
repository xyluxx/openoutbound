# Cold email check

This guide shows the live check the engine makes right before the first email to a person: what it asks, what it does with the answer, the three settings, where a held person shows up, and how to get a free key.

## The short version

1. It is on by default and needs no setup: without a key, [Precleared](https://precleared.dev) allows 10 checks a day per network. Store a free key for 100 a day (25 after 14 days).
2. Only `ok_to_email` goes out. `consent_needed`, `blocked` and `unknown` skip the email with the provider's reason, next step and receipt; a check that cannot run holds the email and opens one problem that says why.
3. Set `compliance.cold_email_check.sender_country` to where the sending business is based (`GB` by default), and `mode` to `warn` or `off` if you do not want the hold.

This is decision support, not legal advice. The check applies the published rules to the facts it can find; whether you may email someone remains your call and your counsel's.

## What it checks

Whether a cold email is allowed often turns on facts that are not in the address: a UK recipient may be a limited company (PECR lets you email it) or a sole trader (an individual, who needs to consent first); a Canadian or Australian address may be emailed only when it was published for that purpose. The engine's own rules ([Compliance playbook](../../skills/openoutbound/references/playbook-compliance.md)) decide from the ccTLD, the company name and the recorded source. They still run first and cost nothing. The cold email check then asks the compliance provider for everything they let through: Precleared looks the recipient up live (Companies House, the domain, the company's website) and applies UK PECR and GDPR, US CAN-SPAM, Canada's CASL, Germany's UWG, France's CPCE, Australia's Spam Act, Ireland's ePrivacy Regulations and the Dutch Telecommunicatiewet.

One check per person, right before the first email, as the last step of the [send gate](../concepts/safety-and-approvals.md#checks-before-every-send): after the suppressions, the mailbox, the window and the daily cap, so a check is only spent on an email that would go out now. Never checked: replies, reply-mode steps, follow-ups (an email to the person went out in the last 30 days), and sandbox workspaces (nothing in the sandbox reaches the network).

The provider receives the address, your sender country, how the engine got the address (`published` when the page that publishes it is recorded, `bought` for a lead database or a paid finder, else `unknown`; the engine never assumes an address was published), the company name and the person's name (to find the company in a register; the provider does not store them), the Companies House number when `custom.company_number` is set on the company, and the recipient's country when the lead has one. When it has none, the ccTLD is passed as a hint only.

| Verdict | What the engine does |
| --- | --- |
| `ok_to_email` | Sends. The receipt id stays with the person (`email_clearance` in `get_lead`) |
| `consent_needed` | Skips the email (`not_contactable: cold_email_consent_needed` with the reason, the next step and the receipt). The person stays held for 30 days unless `custom.consent` is recorded or the lead's facts change |
| `blocked` | Skips the email, held for 30 days; consent does not lift it |
| `unknown` | A fact could not be established (is it a company or a sole trader?). Skips this email; the next email to the person asks again, so add the missing facts first |
| The check could not run | Mode `hold`: the email stays scheduled and is checked again (after the wait the provider asked for, else 30 minutes), and one `sending_blocked` problem per workspace carries the provider's words and the fix. Mode `warn`: logged, sent |

A definite verdict (anything but `unknown`) is reused for 30 days for the same address and the same facts, so a sequence costs one check and a held person does not spend one per step. A changed fact (a country, a company name or number, the sender country) asks again.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `compliance.cold_email_check.mode` | `hold` | `hold`: send only on `ok_to_email`, hold everything else, including when the check cannot run. `warn`: log the verdict and send anyway. `off`: never ask |
| `compliance.cold_email_check.sender_country` | `GB` | Where the sending business is based: `GB`, `US` or `AE`. Set it per client workspace |
| `compliance.cold_email_check.provider` | `precleared` | The compliance provider id |
| `PRECLEARED_API_KEY` (env) or `providers set` | none | Optional key for a bigger allowance |

```bash
openoutbound --workspace acme workspaces update --settings '{"compliance":{"cold_email_check":{"sender_country":"US"}}}'
openoutbound --workspace acme workspaces update --settings '{"compliance":{"cold_email_check":{"mode":"warn"}}}'
```

MCP: `manage_workspaces` action `update` (needs `admin`); an agent suggests the change with `manage_strategy` action `propose`.

## Keys and allowances

Without a key Precleared allows 10 checks a day per network. A free key gives 100 a day for 14 days, then 25 a day; GBP 15 a month keeps 100 a day, and packs add checks that never expire. Get a key at [precleared.dev/get-key](https://precleared.dev/get-key), then store it for the instance or one workspace:

```bash
openoutbound providers set --slot compliance --provider precleared --secrets '{"api_key":"pc_live_..."}'
openoutbound providers test --slot compliance --provider precleared
```

or put `PRECLEARED_API_KEY=pc_live_...` in `.env`. When the keyless allowance is used up (`daily_limit`), the key has no checks left (`payment_required`) or the key is rejected, the engine pauses the provider with one `provider_down` problem ([Provider failures](../concepts/provider-failures.md)), the held emails open the `sending_blocked` problem with Precleared's own message, and both close by themselves once a check succeeds.

## Where a held person shows up

- `get_lead`: `person.email_clearance` (verdict, reason, next step, receipt id, when) and `contactable.email.reasons` (`cold_email_consent_needed`, `cold_email_blocked`); `relationship.blockers` says it in words with the fix, as do `explain_blocker` and `get_next_actions`.
- The skipped message: `manage_messages` action `list` shows status `skipped` with `not_contactable: cold_email_...` and the provider's reason, next step and receipt.
- Enrollment: a person held by a stored verdict is refused like any other person who may not be emailed.
- `get_problems`: `sending_blocked` (held because the check could not run) and `provider_down` (a rejected key, the allowance used up).
- The log: one line per check with the verdict and the receipt id; in mode `warn`, a warning for every verdict that did not clear the address.

To release a held person, follow the next step: record `custom.consent` with `manage_leads` action `update` only when you really have consent, add `custom.company_number` on the company when Companies House knows it, or set the person's country. The next email asks again when a fact changed.

## Receipts

Every answer carries a signed receipt id, kept on the person and in the skipped message's reason. Precleared keeps the receipt so a check can be shown to a client, an auditor or a regulator later; it does not store the company and person names sent with a check.
