# Write a provider

This guide shows how to connect a new outside service to OpenOutbound: one provider file, recorded fixtures, and a test that never touches the network.

## How a provider fits in

Every outside service sits behind a slot, a typed interface such as `email_verifier` or `crm` (see [Providers](../concepts/providers.md)). A provider implements one slot for one service. The engine does the rest: it stores keys encrypted, validates the config, picks a provider for each workspace, records usage, enforces budgets and lists the provider in `providers catalog`.

| Slot | Interface | What you implement |
| --- | --- | --- |
| `brain` | `BrainProvider` | `generate(request)`, plus `capabilities` and `defaultModels` |
| `lead_source` | `LeadSourceProvider` | `capabilities`, and any of `searchPeople`, `searchCompanies`, `enrichPeople`, `estimate` |
| `email_finder` | `EmailFinderProvider` | `findEmail(input)` |
| `email_verifier` | `EmailVerifierProvider` | `verify(email)` |
| `research` | `ResearchProvider` | `search(query)`; optional `fetch(url)`, `answer(question)` and `creditsPerCall` |
| `signals` | `SignalProvider` | `supportedSignals` and `collect(target)`; optional `parseWebhook` and `creditsPerCall` |
| `linkedin` | `LinkedInProvider` | `getProfile`, `visitProfile`, `sendInvite`, `sendMessage`, `listRecentPosts`, `reactToPost`, `commentOnPost`; optional account, sync and webhook methods |
| `social` | `SocialPublisher` | `publish(input)`; optional `authUrl` and `exchangeCode` for OAuth |
| `crm` | `CrmProvider` | `upsertContact` and `upsertDeal`; optional `logNote` |

Every instance also has an `id`. The full types, with comments, are in `src/providers/types.ts`. The built-in providers in `src/providers/<slot>/` are good models; `email-verifier/millionverifier.ts` is the closest to the example below.

## The example

This page builds `example_verify`, an email verifier for a made-up service called Example Verify. Its API has two calls:

| Call | Request | Answer |
| --- | --- | --- |
| Verify | `GET /v1/verify?email=...` with the header `X-Api-Key` | `{ "email": "...", "result": "deliverable", "credits_charged": 1 }` |
| Account | `GET /v1/account`, free | `{ "credits": 250 }` |

The `result` words map to the engine's email statuses: `deliverable` is `valid`, `undeliverable` is `invalid`, `accept_all` is `catch_all`, and `risky` and `unknown` keep their names.

The code on this page was type-checked and its tests were run against this version of the engine.

## 1. Write the provider

Create `src/providers/email-verifier/example-verify.ts`:

```ts
/**
 * Example Verify: a made-up email verification API, used as a template for real providers.
 *   GET {base_url}/v1/verify?email=<address>   header X-Api-Key: <key>
 *       -> { "email": "...", "result": "deliverable", "credits_charged": 1 }
 *   GET {base_url}/v1/account                  (free; used by `providers test`)
 */
import { z } from "zod";
import type { OpenOutboundError } from "../../core/errors.js";
import {
  classifyFetchError,
  classifyHttpStatus,
  isFetchError,
  parseRetryAfter,
  providerFailure,
  providerSignal,
} from "../../core/failures.js";
import {
  defineProvider,
  type EmailStatus,
  type EmailVerifierProvider,
  type VerifyEmailResult,
} from "../types.js";

const ID = "example_verify";
const NAME = "Example Verify";

/** Non-secret settings. Defaults apply when nothing is stored. */
export const exampleVerifyConfigSchema = z.object({
  base_url: z.url().default("https://api.verify.example.com"),
  timeout_ms: z.number().int().min(1_000).max(60_000).default(15_000),
});
export type ExampleVerifyConfig = z.output<typeof exampleVerifyConfigSchema>;

/** The provider's result words, mapped to the engine's email statuses. */
const STATUS: Record<string, EmailStatus> = {
  deliverable: "valid",
  undeliverable: "invalid",
  accept_all: "catch_all",
  risky: "risky",
  unknown: "unknown",
};

const verifyResponse = z.object({
  email: z.string(),
  result: z.string(),
  credits_charged: z.number().int().min(0).default(1),
});

/**
 * A failed HTTP answer. `classifyHttpStatus` gives the class (401 auth_invalid, 402
 * quota_exhausted, 429 rate_limited, 5xx unavailable...) and `providerFailure` builds the error
 * with that class's message and hint. Never put the key in a message.
 */
function answerFailure(response: Response): OpenOutboundError {
  const failureClass = classifyHttpStatus(response.status);
  return providerFailure({
    provider: ID,
    name: NAME,
    class: failureClass,
    upstreamStatus: response.status,
    retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
    ...(failureClass === "auth_invalid"
      ? {
          hint: `Store a new key: openoutbound providers set --slot email_verifier --provider ${ID} --secrets '{"api_key":"..."}'`,
        }
      : {}),
  });
}

/**
 * No answer at all: a timeout or a connection that failed. A free call can be retried; a paid
 * call may already have used a credit, so it is never repeated automatically.
 */
function thrownFailure(error: unknown, paid: boolean): unknown {
  if (!isFetchError(error)) return error;
  return providerFailure({
    provider: ID,
    name: NAME,
    class: classifyFetchError(error),
    cause: error,
    ...(paid
      ? {
          retryable: false,
          hint: `The call may already have used ${NAME} credits, so it is not repeated automatically.`,
        }
      : {}),
  });
}

/** An answer that is not what the API documents: never read it as "unknown". */
function malformedAnswer(what: string): OpenOutboundError {
  return providerFailure({
    provider: ID,
    name: NAME,
    class: "malformed",
    message: `${NAME} sent an unexpected answer: ${what}.`,
  });
}

export interface ExampleVerifyInstance extends EmailVerifierProvider {
  /** Free call that checks the key (used by `providers test`). */
  account(): Promise<{ credits: number | null }>;
}

export function createExampleVerify(options: {
  apiKey: string;
  config: ExampleVerifyConfig;
  /** Always the fetch the engine passes in (ctx.fetch), never the global fetch. */
  fetch: typeof globalThis.fetch;
}): ExampleVerifyInstance {
  const base = options.config.base_url.replace(/\/+$/, "");

  async function getJson(path: string, paid = false): Promise<unknown> {
    let response: Response;
    try {
      response = await options.fetch(`${base}${path}`, {
        method: "GET",
        headers: { accept: "application/json", "x-api-key": options.apiKey },
        // Every request has a timeout.
        signal: providerSignal(options.config.timeout_ms),
      });
    } catch (error) {
      throw thrownFailure(error, paid);
    }
    if (!response.ok) throw answerFailure(response);
    try {
      return await response.json();
    } catch {
      throw malformedAnswer("the body is not JSON");
    }
  }

  return {
    id: ID,

    async verify(email: string): Promise<VerifyEmailResult> {
      // Paid: 1 credit per checked address, even when the answer is lost on the way back.
      const body = await getJson(`/v1/verify?${new URLSearchParams({ email })}`, true);
      const parsed = verifyResponse.safeParse(body);
      if (!parsed.success) throw malformedAnswer("no result field");
      return {
        email,
        status: STATUS[parsed.data.result] ?? "unknown",
        reason: parsed.data.result,
        creditsUsed: parsed.data.credits_charged,
      };
    },

    async account() {
      const body = (await getJson("/v1/account")) as { credits?: unknown } | null;
      return { credits: typeof body?.credits === "number" ? body.credits : null };
    },
  };
}

export const exampleVerifyProvider = defineProvider({
  slot: "email_verifier",
  id: ID,
  name: NAME,
  description: "Made-up email verifier used as a template. 1 credit per checked address.",
  docsUrl: "https://docs.verify.example.com",
  configSchema: exampleVerifyConfigSchema,
  secrets: [{ key: "api_key", label: "API key", env: "EXAMPLE_VERIFY_API_KEY", required: true }],
  create: ({ config, secrets, ctx }) =>
    createExampleVerify({ apiKey: secrets.api_key ?? "", config, fetch: ctx.fetch }),
  // Errors thrown here reach `providers test` with their message and hint.
  test: async (instance) => {
    const { credits } = await (instance as ExampleVerifyInstance).account();
    // A key with nothing left does not work: a passing test would end a quota pause.
    if (credits === 0) return { ok: false, message: `${NAME} key works, but no credits are left.` };
    const left = credits === null ? "" : ` (${credits} credits left)`;
    return { ok: true, message: `${NAME} key works${left}.` };
  },
});
```

What each part does:

- **`createExampleVerify`** builds the client from plain values, so tests can call it without an engine.
- **`exampleVerifyProvider`** tells the engine how to build it: which secrets and config it needs, and how to check it.
- **Every request has a timeout**: `providerSignal(timeout_ms)`. Slots whose calls take options (LinkedIn, social) pass a `signal` from the caller; join it with `providerSignal(timeout_ms, options?.signal)` so a cancelled job stops the call.
- **Every failure has a class.** `answerFailure` maps a failed status with `classifyHttpStatus`, `thrownFailure` maps a timeout or a failed connection with `classifyFetchError` (and marks a lost paid call `retryable: false`), and `providerFailure` builds the error with that class's message and hint. The engine reads the class to retry, wait, pause the provider or ask a person; see [Provider failures](../concepts/provider-failures.md).
- **The answer is validated** with zod. An answer of the wrong shape is `malformed`, never an empty result. A result word the code does not know becomes `unknown`, the safe default: the engine does not email `unknown` addresses while `require_verified_email` is on.
- **`creditsUsed`** reports what the call really cost. The engine records it and counts it toward `settings.data.monthly_credit_budget`.
- **`test()`** uses the free account call. It must never spend credits, and it fails when no credits are left.

## 2. Register it

**As a built-in** (in your clone, or in a pull request), add it to the slot's list in `src/providers/email-verifier/index.ts`:

```ts
import type { ProviderDefinition } from "../types.js";
import { exampleVerifyProvider } from "./example-verify.js";
import { millionVerifierProvider } from "./millionverifier.js";
import { reoonProvider } from "./reoon.js";

/** Built-in providers for the "email_verifier" slot. Add each provider module here. */
export const providers: ProviderDefinition<"email_verifier">[] = [
  millionVerifierProvider,
  reoonProvider,
  exampleVerifyProvider,
];
```

The CLI, the MCP server and `serve` now know it:

```text
$ openoutbound providers catalog --slot email_verifier
ID               NAME                    SANDBOX  CONFIGURED
millionverifier  MillionVerifier         false    false
reoon            Reoon Email Verifier    false    false
example_verify   Example Verify          false    false
sandbox          Sandbox email verifier  true     false
```

The list order matters in one case: when no setting is stored and several providers of the slot find their keys in environment variables, the first one in catalog order serves the slot.

**In your own program**, pass it in a module to `createEngine`. `modules` replaces the built-in list, so spread it:

```ts
import { createEngine, modules } from "openoutbound";
import { exampleVerifyProvider } from "./example-verify.js";

const engine = await createEngine({
  modules: [...modules, { name: "my-providers", providers: [exampleVerifyProvider] }],
});
```

Code outside this repository imports the provider API from `openoutbound/plugin` instead of relative paths: `defineProvider`, `OpenOutboundError`, the slot interfaces, types such as `EmailStatus`, and the failure helpers (`providerFailure`, `providerSignal`, `classifyHttpStatus`, `classifyFetchError`, `isFetchError`, `parseRetryAfter`, `failureOf`). The package is not published to npm, so your project depends on a built local clone.

For now the CLI, `openoutbound mcp` and `openoutbound serve` load only the built-in modules. A provider passed to `createEngine` works in that program only. To use it from the CLI or an agent, register it as a built-in.

Provider ids are unique within a slot. Registering the same id twice (for example as a built-in and in a module) stops the engine at start with `Duplicate provider "example_verify" in slot "email_verifier"`.

## 3. Test it without the network

Tests never reach the internet: the Vitest setup file `src/testing/setup-no-network.ts` makes any `fetch`, socket or DNS query for a non-local host throw. You replay recorded answers instead.

Save each answer you want to test as a fixture. Use invented people and `example.com` domains, never real data.

`src/providers/email-verifier/fixtures/example-verify-deliverable.json`:

```json
{ "email": "dana@brightsmile.example.com", "result": "deliverable", "credits_charged": 1 }
```

`src/providers/email-verifier/fixtures/example-verify-accept-all.json`:

```json
{ "email": "info@northgate.example.org", "result": "accept_all", "credits_charged": 0 }
```

Then write `src/providers/email-verifier/example-verify.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { failureOf } from "../../core/failures.js";
import { createFakeFetch, type FakeRequest, type FetchRoute } from "../../testing/fake-fetch.js";
import {
  createExampleVerify,
  exampleVerifyConfigSchema,
  exampleVerifyProvider,
} from "./example-verify.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const KEY = "example-test-key";
const VERIFY = /^https:\/\/api\.verify\.example\.com\/v1\/verify\?/;

function setup(routes: FetchRoute[]) {
  const calls: FakeRequest[] = [];
  const fetch = createFakeFetch(routes, calls) as unknown as typeof globalThis.fetch;
  const verifier = createExampleVerify({
    apiKey: KEY,
    config: exampleVerifyConfigSchema.parse({}),
    fetch,
  });
  return { verifier, calls };
}

describe("example_verify", () => {
  it("maps deliverable to valid and reports the credit", async () => {
    const { verifier, calls } = setup([
      { match: VERIFY, response: { json: fixture("example-verify-deliverable") } },
    ]);
    const result = await verifier.verify("dana@brightsmile.example.com");
    expect(result).toMatchObject({ status: "valid", reason: "deliverable", creditsUsed: 1 });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("email")).toBe("dana@brightsmile.example.com");
    // Every request carries a timeout.
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps accept_all to catch_all", async () => {
    const { verifier } = setup([
      { match: VERIFY, response: { json: fixture("example-verify-accept-all") } },
    ]);
    expect(await verifier.verify("info@northgate.example.org")).toMatchObject({
      status: "catch_all",
      creditsUsed: 0,
    });
  });

  it("reports a rejected key as auth_invalid without leaking it", async () => {
    const { verifier } = setup([{ match: VERIFY, response: { status: 401, json: {} } }]);
    const error = await verifier.verify("dana@brightsmile.example.com").catch((e: unknown) => e);
    expect(failureOf(error)).toMatchObject({ class: "auth_invalid", retryable: false });
    expect(JSON.stringify(error)).not.toContain(KEY);
  });

  it("reports a rate limit with the wait the API asked for", async () => {
    const { verifier } = setup([
      { match: VERIFY, response: { status: 429, headers: { "retry-after": "30" }, json: {} } },
    ]);
    const error = await verifier.verify("dana@brightsmile.example.com").catch((e: unknown) => e);
    expect(failureOf(error)).toMatchObject({
      class: "rate_limited",
      retryable: true,
      retry_after_s: 30,
    });
  });

  it("never reads a wrong answer as unknown", async () => {
    const { verifier } = setup([{ match: VERIFY, response: { json: { ok: true } } }]);
    const error = await verifier.verify("dana@brightsmile.example.com").catch((e: unknown) => e);
    expect(failureOf(error)).toMatchObject({ class: "malformed", retryable: false });
  });

  it("passes the provider test with the free account call", async () => {
    const { verifier } = setup([
      { match: "https://api.verify.example.com/v1/account", response: { json: { credits: 250 } } },
    ]);
    expect(await exampleVerifyProvider.test?.(verifier)).toMatchObject({ ok: true });
  });
});
```

```bash
pnpm exec vitest run src/providers/email-verifier/example-verify.test.ts
```

`createFakeFetch(routes, calls)` records each request in `calls` and answers it from the last route that matches, so later routes override earlier ones. A route matches an exact URL or a RegExp (optionally one `method`) and answers with `{ status, headers, body, json }`, a `Response`, or a function of the request. A request that matches no route throws, so a wrong URL fails the test.

To check the whole path (catalog, stored key, `providers test`), run it inside a test engine. `providerFetch` is the fetch that provider instances get:

```ts
import { expect, it } from "vitest";
import { modules } from "../../modules/index.js";
import { createTestEngine } from "../../testing/engine.js";
import { createFakeFetch } from "../../testing/fake-fetch.js";
import { exampleVerifyProvider } from "./example-verify.js";

it("works through the engine", async () => {
  const providerFetch = createFakeFetch([
    { match: "https://api.verify.example.com/v1/account", response: { json: { credits: 250 } } },
  ]) as unknown as typeof globalThis.fetch;
  const engine = await createTestEngine({
    modules: [...modules, { name: "my-providers", providers: [exampleVerifyProvider] }],
    providerFetch,
  });
  try {
    await engine.call("workspaces.create", { name: "Acme" });
    await engine.call(
      "providers.set",
      { slot: "email_verifier", provider: "example_verify", secrets: { api_key: "test-key" } },
      { workspace: "acme" },
    );
    const result = await engine.call(
      "providers.test",
      { slot: "email_verifier", provider: "example_verify" },
      { workspace: "acme" },
    );
    expect(result).toMatchObject({
      ok: true,
      message: "Example Verify key works (250 credits left).",
    });
  } finally {
    await engine.close();
  }
});
```

If you registered the provider as a built-in, drop the `modules` line: it is already in the catalog.

Use a normal workspace for these checks. Sandbox workspaces always use the sandbox provider of each slot and never call yours.

## 4. Configure and try it

Store a key for a workspace and run the free check. Or put `EXAMPLE_VERIFY_API_KEY` in `.env` to serve every workspace.

```bash
openoutbound --workspace acme providers set --slot email_verifier --provider example_verify \
  --secrets '{"api_key":"<your key>"}' --test
openoutbound --workspace acme providers test --slot email_verifier --provider example_verify
```

A failing check shows the error's message and hint (here with `--json`):

```json
{
  "slot": "email_verifier",
  "provider": "example_verify",
  "ok": false,
  "message": "Example Verify rejected the credentials.",
  "hint": "Store a new key: openoutbound providers set --slot email_verifier --provider example_verify --secrets '{\"api_key\":\"...\"}'",
  "latency_ms": 2
}
```

Enrichment uses the verifier named in `data.enrichment.verifier`, or the first configured one when that is empty:

```bash
openoutbound --workspace acme workspaces update --settings '{"data":{"enrichment":{"verifier":"example_verify"}}}'
```

See [Enrichment](../guides/enrichment.md) for how the verifier fits in the waterfall.

## The definition, field by field

| Field | Required | What it does |
| --- | --- | --- |
| `slot` | yes | The slot this provider serves |
| `id` | yes | snake_case, 2 to 41 characters (`^[a-z][a-z0-9_]{1,40}$`), unique within the slot. `defineProvider` throws on a bad id |
| `name` | yes | Display name in the catalog and in messages |
| `description` | yes | One line for the catalog. Say what it costs per call |
| `docsUrl` | no | Link to the service's API docs |
| `configSchema` | no | A zod schema for non-secret settings (URLs, modes, timeouts). Stored config is parsed with it, so defaults fill in; invalid config fails with `provider_not_configured` and a hint |
| `secrets` | yes | Each `{ key, label, env?, required, description? }`. Values come from the encrypted vault, then from the env var. A missing required secret fails with `provider_not_configured` |
| `sandbox` | no | Only for the built-in sandbox providers. Leave it off |
| `create({ config, secrets, ctx })` | yes | Returns the slot instance (or a promise of one) |
| `test(instance)` | no | A cheap live check for `providers test` and `providers set --test`. Return `ok: false` when the key is refused or no credits are left, and `checked: false` when you cannot check anything for free. Without it, the test only confirms the configuration is complete (`checked: false`). A passing test with `checked` true lifts a pause |
| `health` | no | `false` for a provider that calls no outside service of its own (like `builtin` research): the engine never pauses it. Default `true` |

## What the engine hands your provider

`create` receives `ctx`:

| Field | Use it for |
| --- | --- |
| `fetch` | Calls to the provider's own API. Always use it instead of the global `fetch`: tests replace it, and for settings made by a workspace-bound key the engine swaps in the private-network guard |
| `safeFetch` | URLs that come from data, such as company websites and feeds: private addresses blocked, size and time capped |
| `log` | A logger already tagged with the provider and slot |
| `clock` | The current time. Use it instead of `new Date()` so tests can move time |
| `baseUrl` | The instance's public URL, for webhook and OAuth callback URLs |
| `workspaceId` | The workspace this instance serves, or null for instance-wide use |
| `db` | Database access for built-in sandbox providers only. Plug-ins should not use it |

## Rules

- **Errors.** Build every provider failure with `providerFailure({ provider, name, class })`: it adds `details.failure`, which the job runner, MCP, the CLI and provider health read. Use `classifyHttpStatus` for a failed answer and `classifyFetchError` for a thrown network error, and pass `retryAfterSeconds` (from `parseRetryAfter`) when the API says when to retry. Give a `message` and a `hint` when you can say more than the class's defaults. Where the API documents a status otherwise (a 404 that means "no match"), follow the API and say so in a comment.
- **Never guess.** An answer of the wrong shape is `malformed`, never an empty result or "no match". A lookup that timed out is a failure, never a miss.
- **Writes.** For a call that changes something outside (a message, a post, a CRM note), a timeout, a connection that broke after the request was sent, or a server error is `outcome_unknown`: the engine never repeats it blindly. A write the API documents as safe to repeat (an upsert by key, a like) keeps the normal class. A rate limit or a refusal answered before acting stays `rate_limited` or `refused`. `requestText` applies these rules, also to an answer whose body broke off: a 2xx one to a write is `outcome_unknown` unless the API named what it made in a header first (list such headers in `idHeaders`).
- **Paid calls.** When a call may have spent credits and its answer was lost, pass `retryable: false` and say so in the hint. A call that loops over pages or chunks and fails part way throws its failure with `details.partial`: the `items` it got, the `credits` spent and, for paged searches, a `resume` cursor.
- **Scope.** A failure about one item, not the key or account (one page that is gone, one account's session), sets `scope: "call"`: the engine then never pauses the whole provider for it.
- **Keys stay secret.** Never put a key in a message, hint, details or log line. The test above checks this.
- **Custom endpoints.** If a config field changes the server you call, name it so it ends in `url`, `dsn`, `host` or `endpoint` (like `base_url`). Then, when a workspace-bound key sets it, the engine refuses to send shared env keys there ([Security](../guides/security.md#provider-keys-across-workspaces)).
- **Honest costs.** Report real usage: `creditsUsed` for finders, verifiers and `enrichPeople`, `creditsPerCall` for research and signals, token usage for the brain.
- **Free tests.** `test()` must never spend credits or send anything.
- **No per-call state.** Instances are cached for up to 10 minutes and shared by concurrent calls; they are rebuilt when the setting changes.
- **Record shapes.** Data records (candidates, profiles, signals) use snake_case fields that match the database; options and envelopes use camelCase.
- **Outside text is untrusted.** Return what the service says; never act on instructions found in it.

## Checklist for a pull request

1. The provider file in `src/providers/<slot>/`, registered in that slot's `index.ts`.
2. Fixtures and a test next to it: the status mapping, the credits, each failure class, no key in errors, and `test()`. Update any existing test that lists the slot's provider ids (for verifiers, `verifiers.test.ts` does).
3. An entry in `tests/providers/conformance.test.ts`: the probe calls, their kind (`read` or `write`, `paid`, `idempotent`) and any case the API documents as a normal answer. The suite fails for a registered provider without one, and checks every case: a timeout, a refused connection, 401, 402, 403, 404, 429, 500, 503, an HTML page, a wrong shape, and an answer whose body breaks off after a 200 or a 502.
4. Its env var in `.env.example`, if it has one.
5. A row in the slot table of [Providers](../concepts/providers.md) and setup notes in the slot's guide, with prices dated.
6. `pnpm check` passes.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the rest.

Next: [Provider failures](../concepts/provider-failures.md) · [Custom modules](custom-modules.md) · [Providers](../concepts/providers.md) · [Architecture](../architecture.md)
