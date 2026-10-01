# AI brain

This guide shows how to choose and set up the AI brain: the model that writes, checks, classifies and researches for the engine. It covers every brain provider, model tiers and how to change them, costs, the CLI subscription options, and the agent brain.

## Pick a brain

| Provider id | What it uses | Setup | Cost tracking | Good for |
| --- | --- | --- | --- | --- |
| `anthropic` | Claude through the Anthropic API | `ANTHROPIC_API_KEY`; models are preset | Exact, from the price table | The default choice. Works with just the key. |
| `openai` | OpenAI through the Responses API | `OPENAI_API_KEY`; models are preset | Not tracked ($0 in budgets) | Teams on OpenAI |
| `openrouter` | Models from many vendors through one key | `OPENROUTER_API_KEY`; models are preset (Claude through OpenRouter) | Exact, reported by OpenRouter | Trying several models; one bill |
| `gemini` | Gemini through Google's OpenAI-compatible endpoint | `GEMINI_API_KEY`; models are preset | Not tracked | Teams on Google |
| `openai_compatible` | Any OpenAI-compatible server: Ollama, LM Studio, vLLM, Groq, DeepSeek, Together, Mistral | `providers set` with a preset or base URL, plus model names | Not tracked | Local or self-hosted models, no data leaves your network |
| `claude_cli` | Your own Claude subscription through the `claude` CLI | `claude` installed and logged in on the engine machine | Not tracked | Personal use: one person, one machine |
| `codex_cli` | Your own ChatGPT plan through the `codex` CLI | `codex` installed and logged in | Not tracked | Personal use |
| `agent` | The agent connected over MCP does the AI work | `providers set --slot brain --provider agent` | None | No model keys at all; slow, the agent must be running |

With no brain at all, everything that does not need AI still works (sending your own text with `exact` steps, reply sync, reports). Background jobs that need AI wait until a brain is configured instead of failing; see [No brain yet](#no-brain-yet). Sandbox workspaces use a fake brain; see [below](#sandbox).

## Tiers

Every prompt asks for a tier, and each provider maps tiers to models:

| Tier | Used by default for |
| --- | --- |
| `fast` | Checking drafts (`campaign.email.check`, `inbox.reply.check`), classifying replies (`inbox.reply.classify`), promises in sent replies (`inbox.reply.promises`), learning rules (`campaign.teach`), signal classification (`signals.items.classify`, `signals.website_change.classify`, `signals.custom.evaluate`), report summaries (`reports.summary`), column mapping for imports (`leads.import_map_columns`), ICP refinement (`leads.icp_refine`), team pages (`enrichment.extract_team`) |
| `standard` | Writing (`campaign.email.write`, `campaign.email.fill_slots`, `campaign.linkedin.write`, `inbox.reply.draft`, `content.post.draft`), research briefs (`research.brief`), knowledge bootstrap (`knowledge.bootstrap`) |
| `deep` | Nothing by default. Use it in overrides for the prompts where quality matters most. |

When a provider has no model for a tier, it falls back: `fast` to `standard` then `deep`; `standard` to `deep` then `fast`; `deep` to `standard` then `fast`.

## Set up each provider

Provider settings work per workspace or instance-wide (`--level instance`, or no workspace). `--config` replaces the whole stored config, so pass every field you want to keep. Check the result with `openoutbound brain test`.

### Anthropic

```bash
openoutbound providers set --slot brain --provider anthropic --secrets '{"api_key":"sk-ant-..."}' --test
```

Or just `ANTHROPIC_API_KEY` in `.env`. Default models: `fast` claude-haiku-4-5, `standard` claude-sonnet-5, `deep` claude-opus-5.

| Config | Default | Meaning |
| --- | --- | --- |
| `models` | see above | `{"fast":"...","standard":"...","deep":"..."}` |
| `base_url` | `https://api.anthropic.com` | For a proxy or gateway |
| `max_concurrency` | 8 | Parallel calls per process (1 to 64) |
| `effort` | `low` for `fast`, model default otherwise | Per tier: `low`, `medium`, `high`, `xhigh`, `max` |
| `cache_system_prompt` | `true` | Prompt caching for the system prompt |

### OpenAI, OpenRouter, Gemini

The key alone is enough: `OPENAI_API_KEY`, `OPENROUTER_API_KEY` or `GEMINI_API_KEY` in `.env`, or stored with `providers set`. Each has default models (checked 2026-09-27):

| Provider | `fast` | `standard` | `deep` |
| --- | --- | --- | --- |
| `openai` | gpt-6-luna | gpt-6-sol | gpt-6-astra |
| `openrouter` | anthropic/claude-haiku-4.5 | anthropic/claude-sonnet-5 | anthropic/claude-opus-5 |
| `gemini` | gemini-3.5-flash-lite | gemini-3.8-flash | gemini-3.8-flash |

To use other models, set `models` in the provider config; tiers you leave out keep their default:

```bash
openoutbound providers set --slot brain --provider openai --secrets '{"api_key":"sk-..."}' \
  --config '{"models":{"fast":"<small model id>","standard":"<main model id>","deep":"<best model id>"}}' --test
openoutbound providers set --slot brain --provider openrouter --secrets '{"api_key":"..."}' \
  --config '{"models":{"standard":"<vendor>/<model>"}}' --test
openoutbound providers set --slot brain --provider gemini --secrets '{"api_key":"..."}' \
  --config '{"models":{"standard":"<gemini model id>"}}' --test
```

You can store the config with `providers set` and keep the key in `.env`.

| Provider | Extra config |
| --- | --- |
| `openai` | `base_url`, `organization`, `project`, `max_concurrency` (8), `reasoning_effort` per tier (`fast` defaults to low) |
| `openrouter` | `max_concurrency` (8), `max_tokens_headroom` (8000). Structured output is routed only to model hosts that support it. |
| `gemini` | `max_concurrency` (4), `max_tokens_headroom` (8000) |

### Local and other compatible servers

```bash
# Ollama on this machine
openoutbound providers set --slot brain --provider openai_compatible \
  --config '{"preset":"ollama","models":{"standard":"<model name>"}}' --test

# vLLM or any other server
openoutbound providers set --slot brain --provider openai_compatible \
  --config '{"preset":"custom","base_url":"http://localhost:8000/v1","models":{"standard":"<model name>"}}' --test
```

| Preset | Base URL | Key | Structured output | Concurrency |
| --- | --- | --- | --- | --- |
| `ollama` | `http://localhost:11434/v1` | none | JSON schema | 1 |
| `lmstudio` | `http://localhost:1234/v1` | none | JSON schema | 1 |
| `groq`, `deepseek`, `together` | the vendor's | `--secrets '{"api_key":"..."}'` | JSON object | 4 |
| `mistral` | the vendor's | `--secrets '{"api_key":"..."}'` | JSON schema | 4 |
| `custom` | your `base_url` | optional | JSON object | 2 |

The key for this provider is stored with `providers set`; there is no env var for it. If a server rejects JSON schema output, the engine switches that model to JSON object mode and retries once. Every answer is validated against the prompt's schema either way, and a bad answer gets one repair call. Small local models often fail that validation: test with `brain test` and `campaigns preview` before you rely on one.

`test` checks that the server answers and lists the configured models.

### Claude and Codex subscriptions (CLI, personal use)

These run the official CLI on the engine machine with your own login:

```bash
openoutbound providers set --slot brain --provider claude_cli --test    # needs `claude` logged in (/login)
openoutbound providers set --slot brain --provider codex_cli --test     # needs `codex login` or CODEX_API_KEY
```

Read this before you use them:

- **Personal use only.** Anthropic allows you to sign in to the unmodified `claude` CLI with your own subscription. It does not allow third parties to offer claude.ai login or to route requests through subscription credentials on other people's behalf. So use `claude_cli` for yourself, on your machine, not for a team or clients; use an API key for that. OpenAI's docs also recommend API keys for automation. (Checked 2026-09-27.)
- OpenOutbound never reads your credentials. It runs the CLI in an empty temporary folder with tools, MCP servers and web search off, and removes its own secrets and database URL from the CLI's environment.
- One call at a time, up to 10 minutes each. A day of campaigns can queue a lot of calls.
- Cost is not reported, so these calls count $0 toward the AI budget. Your plan's own usage limits apply: a call that hits one fails with `usage_limit` (and the reset time), and background jobs try again when the limit resets, or after an hour when the message gives no reset time.
- `test` only checks that the command runs (`--version`), not that you are logged in. Run `brain test` to be sure.

| Config | `claude_cli` | `codex_cli` |
| --- | --- | --- |
| `command` | Path to `claude` (default: on PATH; on Windows the native `claude.exe`) | Path to `codex` (default: on PATH) |
| `models` | Aliases per tier, default `haiku`, `sonnet`, `opus` | Per tier; default is Codex's own default model |
| Other | `max_turns` (1-10, default 3), `timeout_ms` (default and max 10 minutes) | `reasoning_effort` per tier (`fast` defaults to low), `timeout_ms` |

### The agent brain

With `agent`, the agent connected over MCP (Claude Code, Codex, any client) does the AI work. No model keys are needed.

```bash
openoutbound --workspace acme providers set --slot brain --provider agent
```

How it works:

1. When the engine needs AI (a draft, a classification, a brief), it creates an **agent task** with the instructions, the input and the JSON schema of the answer, and the job waits.
2. The MCP server adds the `agent_brain` toolset once an enabled `agent` brain is configured: `get_agent_tasks` (actions `list` and `get`) and `submit_agent_task`. Restart stdio sessions after configuring it.
3. The agent lists open tasks, reads one, answers with JSON that matches `output_schema` (or a `decline_reason`), and the waiting job resumes.
4. Tasks expire after `expire_hours` (default 168, one week); an hourly job cleans them up.

Tell your agent something like "Work through my OpenOutbound agent tasks" during a session. Nothing AI-related moves while no agent answers. Task input can contain prospect text in `<untrusted_content>` blocks, which the agent must treat as data. A call made outside a job (for example `campaigns preview`) returns `approval_required` with the task id: answer the task, then repeat the call.

The agent brain suits trying OpenOutbound with no keys and low volumes. For campaigns that run every day, use an API brain, or set a [backup brain](#backup-brain) so replies are sorted even when no agent is around.

## Change models for one task

`settings.ai.task_models` overrides the model per prompt id or per tier, for one workspace:

```bash
openoutbound --workspace acme workspaces update --settings '{"ai":{"task_models":{
  "campaign.email.write": {"provider":"anthropic","model":"claude-opus-5"},
  "fast": {"model":"claude-haiku-4-5"}
}}}'
```

Each entry is `{ provider?, model?, tier? }`. The engine looks for the prompt id first, then the tier name, then uses the prompt's own tier on the workspace's brain. An entry that names a provider uses that provider for the prompt; one without a provider applies to the default brain. To remove an entry, set it to `{}`.

Other AI settings: `ai.language` (default `en`), `ai.tone_notes` (added to writing prompts) and `ai.monthly_budget_usd`. See the [configuration reference](../reference/configuration.md#workspace-settings).

## Backup brain

Set a second brain that answers when the main one cannot:

```bash
openoutbound --workspace acme workspaces update --settings '{"ai":{"fallback_provider":"openrouter"}}'
```

The backup must be a brain provider configured for the workspace (see [Set up each provider](#set-up-each-provider)). When a call on the main brain fails after its own retries for a reason on the provider's side, the same call runs once on the backup brain, with the same output schema, checks and repair call. The backup uses its own model for the tier, or the model of a `task_models` entry that names it. Usage and cost are recorded against the backup, and the log line names both brains.

| The backup answers after | The backup never answers after |
| --- | --- |
| A rejected key (`auth`, `forbidden`), a missing model (`model_not_found`), `quota`, `rate_limited`, `overloaded`, a plan limit (`usage_limit`), server errors, timeouts, network errors, an answer that is not the API's format (`malformed_response`: a wrong `base_url`, a proxy page), a CLI that fails or is missing, an expired agent task, a provider that is not configured | Invalid answers (`invalid_output`, after the repair call), inputs that are too large (`too_large`, `context_window`), `max_tokens`, `refusal`, rejected requests (`bad_request`), a task the agent declined, the AI budget |

`brain test` never falls back: it checks the workspace brain itself (or the provider or model you name), so a broken main brain fails the test even when a backup is set. Other calls that force a provider or a model, and sandbox workspaces on the fake brain, never fall back either. If the backup fails too, the error names both brains, with `details.fallback_provider` and `details.fallback_reason`, and it is retryable when either failure is.

### Replies do not wait for an absent agent

With the agent brain as the main brain and a backup set, sorting a reply (prompt `inbox.reply.classify`) waits for the agent at most `ai.agent_timeout_minutes` (default 30, from 5 to 1440). Then the engine closes the agent task as expired with a note, and the backup brain sorts the reply, so an interested prospect does not wait hours for an answer. Every other prompt waits for the agent as before. A late `submit_agent_task` on the closed task returns `conflict` with the note, and `get_agent_tasks` shows it as `expired_note`.

```bash
openoutbound --workspace acme workspaces update --settings '{"ai":{"fallback_provider":"anthropic","agent_timeout_minutes":20}}'
```

### When a brain is down

A failure that retrying cannot fix (a rejected key, a used-up quota, a missing model or CLI, an answer that is not the API's format, a brain provider that is not configured) opens a `brain_down` problem in the attention queue: severity high, for a person, remedy "Fix the brain settings with manage_providers, then test_brain". There is one problem per provider and model (dedupe key `brain_down:<provider>:<model>`, or `brain_down:<provider>` for a provider that is not configured, since no model was chosen); when the same failure happens again, the open problem is updated instead of adding another. The next successful call with that provider and model resolves it, including a passing `brain test` of that model, so a model that fails for one task stays reported while other models of the provider work. Any successful call on the provider resolves a not-configured problem. A workspace with no brain configured at all gets one problem titled "No AI brain is configured" (dedupe key `brain_down:none`), and the first answer from any brain resolves it. The problem says whether the backup brain answers meanwhile.

### No brain yet

A background job that needs AI (writing a message, sorting a reply, a research brief) while the workspace has no usable brain (none configured, or the configured one is missing its key, and no backup answers) does not fail:

- The job waits with the status `waiting` on `brain:configured:<workspace id>` and uses no attempt. The `brain_down` problem above tells a person.
- A job that pays a provider for what the brain reads (a research brief's web searches) or after it (the address checks of `find_contacts`) checks for a brain before the first paid call, so waiting costs nothing. When such a job waits for the agent's answer or is retried, it reuses or skips what it already paid for: research its searches, `find_contacts` the companies it finished.
- Setting a brain with `manage_providers` action `set` (slot `brain`) wakes the waiting jobs of the workspace, or of every workspace for an instance-level brain. They then run as usual: a launched campaign writes and sends its messages.
- A waiting job also checks again every hour, so a brain set another way (an environment variable and a restart) is picked up too.
- Calls that are not background jobs, such as a campaign preview or `brain test`, fail at once with `provider_not_configured` and a hint.

```bash
openoutbound --workspace acme providers set --slot brain --provider anthropic   --secrets '{"api_key":"..."}' --test        # wakes the jobs waiting for a brain
```

## Costs and budgets

Every brain call is recorded with its tokens and, when known, its cost. The engine knows the price of these models (list prices checked 2026-09-27, USD per million tokens):

| Model | Input | Output |
| --- | --- | --- |
| claude-haiku-4-5 | 1 | 5 |
| claude-sonnet-5 | 2 | 10 |
| claude-opus-5 | 5 | 25 |
| claude-opus-5-5 | 4 | 20 |
| claude-fable-5-1 | 10 | 50 |

Cache writes cost 1.25 times input and cache reads 0.1 times input (less for the last two models). OpenRouter reports the exact cost of each call. Everything else (OpenAI, Gemini, compatible servers, the CLIs, the agent) is recorded with an unknown cost and counts $0.

`settings.ai.monthly_budget_usd` stops brain calls with `budget_exceeded` once the month's counted spend reaches it. When it is reached, every brain call stops, including ones that cost nothing. `get_status` warns at 80%. The costs report shows spend by provider and prompt, and says how many calls had no price; see [Reports](../concepts/reports.md).

A rough idea: the launch checklist estimates $0.012 of AI per lead per AI-written step. Your real cost depends on models, prompt length and rewrites; run `campaigns preview` and read the costs report.

## Test and troubleshoot

```bash
openoutbound --workspace acme brain test                       # fast tier on the workspace brain
openoutbound --workspace acme brain test --tier standard --provider openrouter
openoutbound --workspace acme providers list --slot brain      # which provider serves the workspace, and why
```

`brain test` (MCP: `test_brain`, needs `admin`) sends a tiny structured prompt and reports provider, model, latency and whether the answer came back intact, with the error and fix on failure. With the agent brain, the first run creates a test task (`agent_task_id`) and says the connected agent must answer it; once the agent has answered with `submit_agent_task`, run `brain test` again to check the answer. `providers test --slot brain` shows the real reason when a provider cannot even be built (a missing key, a bad config).

| Behavior | Value |
| --- | --- |
| Timeout per attempt | 10 minutes (campaign message generation stops after 3 minutes) |
| Retries | 3 attempts for temporary errors (rate limits, overload, timeouts, server errors), backoff from 1 second up to 20 seconds; a `Retry-After` over 60 seconds fails the call at once, and its job tries again after that wait |
| Invalid answers | One repair call, then `provider_error` with reason `invalid_output` |
| Fallback | Only with `ai.fallback_provider` set: one run on the backup brain after a provider-side failure (see [Backup brain](#backup-brain)) |

Error reasons you may see in `details.reason`: `auth`, `forbidden`, `model_not_found`, `quota`, `rate_limited`, `overloaded`, `server_error`, `timeout`, `network`, `context_window`, `max_tokens`, `refusal`, `invalid_output`, `malformed_response`, `cli_not_found`, `cli_error`, `usage_limit`, `declined`, `expired`. Each error also carries `details.failure` with the class every provider uses (for example `auth` is `auth_invalid` and `quota` is `quota_exhausted`); see [Provider failures](../concepts/provider-failures.md).

## Sandbox

Sandbox workspaces use a fake brain: deterministic sample answers, no network, no cost. Set `settings.sandbox.use_real_brain` to `true` on a sandbox workspace to see your real brain's writing on fake leads (it then counts toward the AI budget).

Next: [Providers](../concepts/providers.md) · [Campaigns](../concepts/campaigns.md#the-writing-pipeline) · [Connect your agent](../getting-started/connect-your-agent.md) · [FAQ](../faq.md)
