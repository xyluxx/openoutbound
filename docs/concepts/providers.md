# Providers

This page explains provider slots, how the engine picks a provider for a workspace, and how to configure providers with the CLI, MCP or environment variables.

## Slots

Every outside service sits behind a typed interface called a slot. Each slot can have several providers. All of them are optional: the engine runs without any, and an operation that needs a missing slot fails with `provider_not_configured` and a hint naming the fix. Background jobs that need a missing brain wait for one instead (see [No brain yet](../guides/ai-brain.md#no-brain-yet)).

| Slot | Used for | Built-in providers | Guide |
| --- | --- | --- | --- |
| `brain` | Writing, checking, classifying, research briefs, custom signals | `anthropic`, `openai`, `openrouter`, `gemini`, `openai_compatible`, `claude_cli`, `codex_cli`, `agent` | [AI brain](../guides/ai-brain.md) |
| `lead_source` | Finding people and companies | `apollo`, `google_maps` | [Lead sources](../guides/lead-sources.md) |
| `email_finder` | Finding email addresses | `icypeas`, `findymail`, `hunter`, `prospeo` | [Enrichment](../guides/enrichment.md) |
| `email_verifier` | Verifying email addresses | `millionverifier`, `reoon` | [Enrichment](../guides/enrichment.md) |
| `research` | Web search and page reading for briefs | `parallel`, `exa`, `tavily`, `firecrawl`, `builtin` | [Research and signals](../guides/research-and-signals.md) |
| `signals` | Paid signal data and inbound signal webhooks | `predictleads`, `crustdata`, `webhook` | [Research and signals](../guides/research-and-signals.md) |
| `linkedin` | LinkedIn actions (visit, like, comment, invite, message) | `unipile` | [LinkedIn](../guides/linkedin.md) |
| `social` | Publishing LinkedIn posts | `linkedin_official`, `unipile` | [LinkedIn](../guides/linkedin.md#posting) |
| `crm` | Pushing contacts and deals | `hubspot`, `pipedrive`, `webhook` | [CRM and notifications](../guides/crm-and-notifications.md) |

Every slot also has a `sandbox` provider that only sandbox workspaces use (for the brain it is called `fake`). Some capabilities need no provider at all: the website contact crawler, the six built-in signal collectors, and sending through your own mailboxes (SMTP and IMAP are part of the email module, not a slot).

List what is available and whether it is configured:

```bash
openoutbound providers catalog
openoutbound providers catalog --slot research --response-format detailed   # adds each config schema
```

## How the engine picks a provider

For each slot and workspace the engine builds an ordered list:

1. **Workspace settings**: providers configured for this workspace, highest `priority` first.
2. **Instance settings**: providers configured for the whole instance, highest `priority` first.
3. **Environment variables**: providers whose required secrets are all present as env vars (for example `EXA_API_KEY`), in catalog order.
4. **Not configured**: the operation fails with `provider_not_configured`.

Rules worth knowing:

- Most operations use the first provider in the list. If it fails, the call fails: there is no automatic switch to the next one. Two exceptions: the email finder waterfall (see [Enrichment](../guides/enrichment.md)) and the brain's backup, `ai.fallback_provider` (see [Backup brain](../guides/ai-brain.md#backup-brain)).
- A provider that rejects its key, is out of credits or lacks a permission is paused for the workspace until it is fixed, with a `provider_down` problem. See [Provider failures](provider-failures.md).
- A disabled setting (`enabled: false`) hides that provider at lower levels too, so a workspace can switch off an instance-wide or env provider.
- Providers without required secrets (such as `builtin` research) are used only when you configure them; env vars cannot select them.
- Each secret is read from the stored setting first, then from its env var. So you can store a config at workspace level and keep the key in `.env`.
- One exception protects shared keys: when a workspace-bound key (for example a client's admin key) sets a provider's config with a custom endpoint (`base_url`, `dsn`, a host or URL field), that setting must store its own secrets. Env keys are never sent to such an endpoint, and its traffic goes through the private-network guard. The instance owner setting the config again lifts this.
- Sandbox workspaces ignore all of this and always use sandbox providers (for the brain, the fake brain, unless `settings.sandbox.use_real_brain` is on).
- Instances are cached for up to 10 minutes and rebuilt as soon as the setting changes.

See which provider serves each slot, and why:

```bash
openoutbound --workspace acme providers list
```

The output shows the level (`workspace`, `instance`, `env` or `sandbox`), the non-secret config, which secrets are set and which are missing. Secret values are never returned by any operation.

## Configure a provider

With the CLI (local admin, or a key with the `admin` scope):

```bash
# Instance-wide (no workspace): every workspace can use it
openoutbound providers set --slot research --provider exa --secrets '{"api_key":"..."}' --test

# One workspace only, with a config and a priority
openoutbound --workspace acme providers set --slot research --provider tavily \
  --secrets '{"api_key":"..."}' --config '{"search_depth":"advanced"}' --priority 10

# Check it (never spends credits)
openoutbound --workspace acme providers test --slot research

# Stop using it at this level
openoutbound --workspace acme providers remove --slot research --provider tavily
```

| `providers set` field | Meaning |
| --- | --- |
| `slot`, `provider` | Which provider (ids from `providers catalog`) |
| `level` | `workspace` (default when a workspace is given) or `instance` |
| `secrets` | Secret values by key, for example `{"api_key":"..."}`. Encrypted in the vault, never returned. An empty string removes a secret. |
| `config` | Non-secret settings, validated against the provider's schema. Replaces the stored config. |
| `enabled` | `false` keeps the setting but stops using the provider |
| `priority` | -100 to 100, higher wins; waterfalls use this order |
| `test` | Run the provider's connection check after saving |

The same actions exist as the MCP tool `manage_providers` (toolset `admin`) and as REST routes (`PUT /v1/providers/{slot}/{provider}`). Agent keys lack the `admin` scope by default, so agents can read the catalog and test providers but not change them.

## Environment variables

Env vars are the quickest setup for a single-client install. Put them in `.env` and restart:

| Env var | Provider |
| --- | --- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` | AI brain (see [AI brain](../guides/ai-brain.md)) |
| `APOLLO_API_KEY`, `GOOGLE_MAPS_API_KEY` | Lead sources |
| `ICYPEAS_API_KEY`, `FINDYMAIL_API_KEY`, `HUNTER_API_KEY`, `PROSPEO_API_KEY` | Email finders |
| `MILLIONVERIFIER_API_KEY`, `REOON_API_KEY` | Email verifiers |
| `PARALLEL_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY` | Research |
| `PREDICTLEADS_API_KEY` + `PREDICTLEADS_API_TOKEN`, `CRUSTDATA_API_KEY` | Signals |
| `UNIPILE_DSN` + `UNIPILE_API_KEY` | LinkedIn and posting through Unipile |
| `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET` | Posting with the official LinkedIn API |
| `HUBSPOT_ACCESS_TOKEN`, `PIPEDRIVE_API_TOKEN` | CRM |

The [configuration reference](../reference/configuration.md#provider-environment-variables) lists every variable, including the ones that are not provider keys. In an agency setup, prefer stored per-workspace settings: env vars apply to every workspace.

## When a provider fails

Every provider error says what went wrong in `details.failure`: a class such as `rate_limited` or `auth_invalid`, whether the engine may retry it by itself (`retryable`), and how long to wait. Jobs retry what can be retried and stop at once on the rest. A rejected key, a used-up quota or a missing permission pauses the provider for the workspace and opens a `provider_down` problem; `get_status` shows each slot's health. See [Provider failures](provider-failures.md) for every class and how a pause ends.

## Costs and budgets

Paid providers record usage (tokens and dollars for the brain, credits for data providers). Two monthly budgets per workspace stop spending when reached: `settings.ai.monthly_budget_usd` and `settings.data.monthly_credit_budget`. See [Safety and approvals](safety-and-approvals.md#budgets) and the costs report in [Reports](reports.md).

## Write your own

A provider is one file: `defineProvider({ slot, id, name, secrets, configSchema, create, test })`. See [Write a provider](../extending/write-a-provider.md).

Next: [Provider failures](provider-failures.md) · [AI brain](../guides/ai-brain.md) · [Research and signals](../guides/research-and-signals.md) · [Write a provider](../extending/write-a-provider.md)
