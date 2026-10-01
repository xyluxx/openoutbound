# Custom signals

This guide shows how to write your own buying signal in plain English, so monitors look for what predicts a deal for you, with examples you can copy.

Use a custom signal when none of the [15 built-in signals](../concepts/signals.md#the-catalog) captures it. To change a built-in (its weight, half-life or detection), use `signals definitions update` instead.

## How a custom signal is checked

1. A monitor runs its collectors on a company and gathers evidence: changed pages, job posts, news, feed items, your inbound messages.
2. The pages your signal names in `urls` are read too (at most 5).
3. The brain reads up to 15 sources (1,500 characters each) and answers: matched or not, the evidence URL, the line that proves it, a strength from 0 to 1 and a short summary. The prompt is `signals.custom.evaluate`, tier `fast` unless you set `standard`.
4. A match must quote a URL from the sources, or it is discarded. A strength below `min_strength` (default 0.5) scores 0.
5. When nothing changed since the last check, the brain is not called again.

So a custom signal costs one brain call per company per run, only when its evidence changed. It spends AI budget, not data credits.

## Create one

```bash
openoutbound --workspace acme signals definitions create \
  --key new_clinic_location \
  --name "Opened a new clinic location" \
  --description "The practice announced or opened an additional clinic location in the last 60 days. New sites need equipment and supplies." \
  --instructions "Counts: a new address on the locations page, or news of an opening. Does not count: a renovation, a move, or a location announced over 60 days ago." \
  --collectors website_changes,news_gdelt --urls /locations,/contact \
  --weight 55 --half-life-days 45
```

MCP: `manage_signals` action `define_custom`.

| Field | Meaning | Default |
| --- | --- | --- |
| `key` | snake_case id, 2 to 64 characters; cannot be a built-in key | required |
| `name` | Short label shown in feeds and notifications | required |
| `description` | What counts and why it matters (10 to 2,000 characters) | required |
| `instructions` | How to judge evidence: what qualifies and what does not | the description |
| `collectors` | Which collectors' evidence to read (1 to 12) | `website_changes`, `news_gdelt`, `rss` |
| `keywords` | Words the brain should look for (up to 50) | none |
| `urls` | Pages to read for every company: `/careers`, `https://{domain}/blog` or a full URL (up to 5) | none |
| `weight` | Score at full strength when new, 1 to 100 | 40 |
| `half_life_days` | Days until the score halves, 1 to 365 | 30 |
| `min_strength` | Weaker matches score 0 | 0.5 |
| `tier` | `fast` (cheaper) or `standard` (for subtle rules) | `fast` |

Then make sure a monitor runs the collectors your signal reads: a custom signal only sees evidence from the collectors the monitor runs, plus its own `urls`. Monitors look for every enabled signal unless you set `signal_keys`.

## Write a good one

- **One observable event.** "Opened a new location" can be seen on a page. "Is ready to buy" cannot.
- **A time window.** Say "in the last 60 days". The model is told to respect time windows and exclusions.
- **Say what does not count.** Most false positives come from near misses: a move is not an opening, a job repost is not a new role.
- **Point at the right pages.** If the evidence lives on `/locations` or `/press`, list those URLs. Evidence the collectors never fetch cannot match.
- **Pick the collector that sees it.** Job posts: `job_boards`. Announcements: `news_gdelt` and `rss`. Page content: `website_changes` or `urls`.
- **No sensitive traits.** The prompt refuses health, religion, politics, union membership, sexuality and family life. Target business events only.
- **Start conservative.** Keep `min_strength` at 0.5 and the weight modest, check the feed for a week, dismiss false positives, then tune. The [signals report](../concepts/reports.md) shows whether the signal leads to replies.

## Examples

| Key | Description | Collectors and URLs | Weight / half-life |
| --- | --- | --- | --- |
| `new_clinic_location` | The practice announced or opened an additional location in the last 60 days | `website_changes`, `news_gdelt`; `/locations` | 55 / 45 |
| `switching_payroll` | The company says it is replacing or evaluating its payroll provider, in a job post, blog post or news in the last 90 days | `job_boards`, `rss`, `news_gdelt` | 60 / 30 |
| `new_warehouse` | The company opened or announced a new warehouse or fulfillment center in the last 90 days | `news_gdelt`, `rss`, `website_changes` | 50 / 60 |
| `pricing_page_launch` | The company published a pricing page or changed plans in the last 30 days | `website_changes`; `/pricing` | 35 / 21 |
| `security_hire` | A job post for the first security or compliance role (no such team before) | `job_boards`; `/careers` | 45 / 45 |

## Current limits

- Paid provider ids (`predictleads`, `crustdata`) in a custom signal's `collectors` add nothing: custom signals only read the free collectors' evidence and their `urls`.
- In sandbox workspaces the web collectors are skipped and `urls` are read from the sandbox's pages instead of the web. Every sandbox company has a home page (`/`) and an about page (`/about`), so a custom signal that lists one of those can match there; other paths find nothing.

Next: [Signals](../concepts/signals.md) · [Research and signals](research-and-signals.md) · [Campaigns](../concepts/campaigns.md)
