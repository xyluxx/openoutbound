# Strategy, changes and lessons

This page explains the client layer: the strategy page every agent reads first, the change log with undo, change proposals with their approvals and results, and lessons.

Everything here belongs to one workspace. Nothing crosses workspaces: not the page, not the change log, not proposals and not lessons.

## The strategy page

The strategy page is one compact document with everything that decides a client's outreach. Agents should read it at the start of every session, before they write, propose or change anything.

```bash
openoutbound --workspace harbor strategy get
```

MCP: `manage_strategy` action `get`. REST: `GET /v1/strategy`.

| Section | What it holds |
| --- | --- |
| `version` | The latest change version of the workspace (0 before the first change) |
| `company` | Name and website (`settings.company`) |
| `offers` | Active offers: id, name, the first line of the summary, the booking link (the offer's own, else `booking.default_url`) and which one is the default |
| `icps` | Each ICP with a one-line summary of its criteria, the default first |
| `signals` | Enabled built-in signals and custom signals by name (a disabled custom signal is marked `(off)`) |
| `voice` | Language, tone notes, the titles of the never-say rules (knowledge items of kind `rule`) and how many voice samples exist |
| `replies` | What happens for each reply category; locked rules are marked `(locked)` |
| `review` | The default review level and the approval settings, including `agent_changes` |
| `booking` | Every `booking.*` setting |
| `crm` | Every `crm.*` setting |
| `compliance` | Excluded and consent countries, the contact cap per company, rest days after a campaign and the days to answer a privacy request |
| `budgets` | AI and data budgets with what is used and left this month |
| `strategy` | The owner's goals, what counts as a qualified meeting, and standing notes for any agent (`strategy.*`) |
| `lessons` | Up to 10 active lessons, newest first (see [Lessons](#lessons)) |
| `recent_changes` | The last 5 changes: version, area, target, a one-line summary, who made it, when, and the verdict of the proposal behind it |
| `precedence` | Which instructions win when they disagree |

The precedence line is always the same: engine protections, then workspace rules, then campaign settings, then person facts, then task instructions. A task instruction never overrides a suppression, a locked reply rule or a workspace rule.

The page never contains secrets, keys, provider settings or model choices. Set the owner's part with the workspace settings:

```bash
openoutbound --workspace harbor workspaces update --settings '{"strategy":{"goals":"Ten qualified demos a month","qualified_meeting":"Dental group with 5+ clinics, owner attends","agent_notes":"Never touch the Q4 campaign"}}'
```

## The change log

Every change to workspace settings, offers, ICPs and campaigns is recorded, whatever door it came through (MCP, CLI, REST, a proposal or an undo):

| Area | What is compared |
| --- | --- |
| `settings` | Every stored workspace setting, path by path (`booking.mode`, `ai.monthly_budget_usd`) |
| `offer` | Name, summary, details, value props, call to action, booking link, status, default flag and proof items (deleting a proof item for good is recorded as an `offers.update` of each offer that cited it) |
| `icp` | Name, description, criteria, scoring, signal keys and default flag |
| `campaign` | Name, description, goal, offer, ICP, settings and steps (the whole step list is one value) |

Each change gets the next workspace version (1, 2, 3, ...), the changed paths with their values before and after, the operation, the `reason` the caller gave, who made it and through which door, and the proposal behind it. An update that changes nothing is not recorded. Campaign launches and pauses, knowledge items and mailboxes are not in the change log; the audit log has them.

```bash
openoutbound --workspace harbor changes list --area settings
openoutbound --workspace harbor changes list --target-id cmp_... --since 2026-09-01T00:00:00Z
openoutbound --workspace harbor changes get --change-id chg_...
```

MCP: `manage_strategy` actions `changes` and `change`. In a change, a path without a `before` value did not exist before, and a path without an `after` value was removed.

## Undo

`changes undo` sets the paths of one change back to their values before it:

```bash
openoutbound --workspace harbor changes undo --change-id chg_... --dry-run
openoutbound --workspace harbor changes undo --change-id chg_... --reason "Handoff lost meetings"
```

MCP: `manage_strategy` action `undo`.

- The values go back through the same update functions as any change, with the same checks: settings are validated with the settings schema, locked reply rules stay locked, proof items must still exist.
- A setting that did not exist before the change is removed again. Such a change is an update like any other, even when all it did was add a key.
- Steps that still exist keep their id, so people in the sequence keep their place.
- The undo is recorded as a new change (`undo_of` points at the change it reverts), the original is marked undone, and a proposal behind it becomes `reverted`.
- An undo can be undone too. The change it reverted is then in effect again (no longer marked undone, its proposal `applied` again), so it can be undone again later and it blocks undoing older changes to the same paths.
- Undoing a settings change needs the `admin` scope, like changing settings.

Some changes cannot be undone:

| Case | Answer |
| --- | --- |
| The change created or removed an offer or ICP | `unsupported`, with a hint: archive the offer or delete the ICP instead, or recreate it |
| The change was already undone | `conflict`, naming the version that undid it |
| A later change that is still in effect touched the same paths | `conflict`, naming the later version: undo that one first, or set the value directly |
| The undo would unset the default ICP | The ICP stays the default and the answer carries a warning; make another ICP the default instead |

## Proposals

A proposal is a change with its reason: the operation and input it would run, the evidence behind it and the expected outcome.

```bash
openoutbound --workspace harbor changes propose \
  --title "Review every message in Dental groups" \
  --operation campaigns.update \
  --input '{"campaign_id":"cmp_...","settings":{"review_level":"every"}}' \
  --evidence '[{"label":"positive reply rate, last 14 days","value":"0.8%"}]' \
  --expected-outcome "Positive reply rate back above 2% within two weeks" \
  --reason "Two off-brand emails went out last week"
```

MCP: `manage_strategy` action `propose`. The `reason` is required. `review_after_days` (1 to 90, default 14) sets when the results are compared.

A proposal may run one of these operations: `workspaces.update`, `campaigns.update`, `campaigns.pause`, `campaigns.pick_winner`, `offers.create`, `offers.update`, `icps.create`, `icps.update`, `signals.definitions.create`, `signals.definitions.update`, `signals.automations.create`, `signals.automations.update` and `mailboxes.update`. Anything else is refused with `validation_failed` and the list. The input is checked against the operation's schema when the proposal is made. It may not carry the executor's own fields (`workspace`, `reason`, `dry_run`, `idempotency_key`, `response_format`) or credentials: passwords and webhook secrets are set directly, never stored in a proposal.

Who applies at once:

| Proposer | Has the operation's scopes | Result |
| --- | --- | --- |
| A person holding `approve` (local CLI, human key) | Yes | Applied at once |
| Anyone else (agent or service key, the local agent, the engine's jobs, a person without `approve`), `approvals.agent_changes: approve` (default) | Yes | Waits for an approval of kind `change` |
| Anyone else, `approvals.agent_changes: auto` | Yes | Applied at once |
| Anyone | No | Waits for an approval of kind `change` |

Applying a proposal calls the operation through the normal [safety gate](safety-and-approvals.md#the-safety-gate) as the proposer: scopes, input validation, an idempotency key (`proposal:<id>`), the paused check, budgets, the operation's own approvals and the audit log. When a person holding `approve` approved the `change` approval, that decision also covers the operation's own approval (a lower review level, a higher mailbox limit, settings that loosen a gate), so it does not ask them twice. When nobody holding `approve` decided it (`approvals.agent_changes: auto`, or a decider who must ask), the operation's own approval still asks, and the proposal follows it; settings that loosen a gate are then refused. The change log rows it records carry the proposal id, and the proposal stores the last one as its `change_id`. When the operation fails, the proposal becomes `failed` with the error.

| Status | Meaning |
| --- | --- |
| `proposed` | Stored, not decided yet (only for a moment) |
| `awaiting_approval` | Waits for an approval: the `change` approval, or the operation's own when no person holding `approve` decided the change (for example an agent raising a mailbox limit with `approvals.agent_changes: auto`), which the proposal then follows |
| `applied` | The operation ran; results are compared after `review_after_days` |
| `rejected` | Rejected, or its approval expired or was cancelled; nothing changed |
| `failed` | The operation failed; `error` says why |
| `reverted` | Applied, then undone |

List and read them with `proposals list --status awaiting_approval` and `proposals get --proposal-id prop_...` (MCP: actions `proposals` and `proposal`). Decide the approvals like any other; see [Change approvals](safety-and-approvals.md#change-approvals).

## Results and verdicts

A daily job compares the numbers of each applied proposal once `review_after_days` have passed: the same number of days before the change and after it.

| Number | Counts |
| --- | --- |
| `sends` | Outreach the engine sent itself: emails, LinkedIn invites and messages (answers to prospects and emails written outside the engine do not count) |
| `replies` | Human replies (auto-replies, out-of-office and bounces do not count) |
| `positive_replies` | Replies classified `interested` or `meeting_request` |
| `meetings_booked` | Meetings recorded in the window; without meeting records, opportunities that reached `meeting_booked` |
| `meetings_held` | Meetings marked held that started in the window (null without meeting records) |
| `reply_rate`, `positive_reply_rate`, `meeting_rate` | Replies, positive replies and meetings booked per send |

When the proposal changed a campaign, the numbers are the campaign's; otherwise they are the workspace's.

The verdict looks at the positive reply rate, or at the meeting rate when the proposal changed booking settings or a booking link:

| Verdict | When |
| --- | --- |
| `unclear` | Either window has fewer than 30 sends |
| `better` | The rate rose by 20% or more (relative: 2% to 2.4% is +20%) |
| `worse` | The rate fell by 20% or more |
| `flat` | Anything in between |

The outcome (both sets of numbers, the verdict and a one-line note) is stored on the proposal, shown on the strategy page next to the change, and announced with the `proposal.reviewed` event. Before and after is not a controlled test: other changes, holidays and list quality move the numbers too. For a controlled comparison of two versions of an email, use A/B variants in the campaign.

## Lessons

A lesson is what worked for this client, kept in the knowledge base as kind `lesson`: a title, a body, its source, a sample size, its author and an expiry.

```bash
openoutbound --workspace harbor knowledge create --kind lesson \
  --title "Short first emails get more replies" \
  --body "First emails under 60 words got twice the reply rate of longer ones for practice managers." \
  --source-ref "campaign report, September" --sample-size 420 --expires-in-days 60
```

MCP: `manage_knowledge` action `add` with `kind: "lesson"`. `expires_in_days` defaults to 90 (at most 365); `update` with `expires_in_days` renews a lesson from today. Every lesson has an expiry: one ingested with `knowledge ingest --kind lesson` or imported from a setup file without one gets the 90 days too, and so does a stored lesson without one at its next update.

Lessons are guidance, never facts:

- Writers (campaign emails and LinkedIn texts, reply drafts) get up to 5 active lessons in a separate block, "Guidance from past results (not facts to state)", which tells them to use it for angle, length and tone and never to state it, quote it or use its numbers as claims.
- Lessons are never in the grounding facts, the checkers' prompts or the evidence checks, so a draft cannot cite a lesson as a source.
- Search (`knowledge.search`) leaves lessons out unless `kinds` includes `lesson`, and they are never used to answer a prospect's question or to decide that a question has no answer. `knowledge.list` shows them.
- The strategy page shows up to 10 active lessons.
- A daily job archives lessons whose expiry has passed.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `approvals.agent_changes` | `approve` | `approve`: proposals from anyone but a person holding `approve` wait for an owner's approval; `auto`: they apply at once when the proposer has the operation's scopes |
| `strategy.goals` | `""` | The client's outbound goals in plain words |
| `strategy.qualified_meeting` | `""` | What counts as a qualified meeting for this client |
| `strategy.agent_notes` | `""` | The owner's standing instructions for any connected agent |

See the [configuration reference](../reference/configuration.md) for every setting.

Next: [Safety and approvals](safety-and-approvals.md) · [Workspaces](workspaces.md) · [Reports](reports.md)
