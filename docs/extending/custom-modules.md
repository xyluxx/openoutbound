# Custom modules

This page shows how to add a new capability to the engine as a module: operations, an MCP tool, a background job and an approval, with a test.

## What a module is

Each feature of the engine is a module in `src/modules/<name>/`. Its `index.ts` exports `module: EngineModule`, and `src/modules/index.ts` lists every built-in module. A module contributes any of these:

| Field | What it holds |
| --- | --- |
| `name` | Unique module name |
| `operations` | Capabilities made with `defineOperation`. Each one becomes a CLI command, a REST route and an OpenAPI entry, and appears in the reference docs |
| `tools` | MCP tools made with `defineTool`. A tool exposes one operation, or several as `actions` |
| `jobs` | Background work made with `defineJob` |
| `schedules` | Recurring jobs: a cron expression, a job name, and whether to run once per active workspace |
| `eventHandlers` | Reactions to [events](../reference/events.md), made with `onEvent`. Each runs as a durable job |
| `approvalResolvers` | What happens when a human decides an approval of a given kind |
| `httpRoutes` | Public routes outside `/v1` (callbacks, inbound webhooks). They skip API-key auth, so authenticate them yourself |
| `providers` | Extra [providers](write-a-provider.md) |

When the engine starts, it checks every module together and stops with one error that lists every problem: duplicate module names, operation ids, tools, jobs, schedules, event handlers or providers, two operations on the same route, two resolvers for one approval kind, a tool that points at an unknown operation, or a schedule that points at an unknown job. `defineOperation`, `defineTool` and `defineJob` also check names, input fields and examples when the file is imported, so mistakes show up in the first test run.

## Example: a gift after approval

The `gifts` module lets an agent ask for a small gift (a book or coffee) for a warm lead. Nothing ships until a human approves it. It uses the `custom` approval kind, which the engine keeps free for modules like this one.

`src/modules/gifts/index.ts`:

```ts
/**
 * Gifts: a lead gets a small gift only after a human approves it.
 * Example custom module for docs/extending/custom-modules.md.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../core/context.js";
import { notFound } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import {
  type ApprovalResolver,
  awaitingApproval,
  awaitingApprovalOutput,
  defineJob,
  defineOperation,
  defineTool,
  dryRun,
  dryRunOutput,
  type EngineModule,
} from "../../core/operation.js";
import { people } from "../../db/schema/index.js";

const GIFTS = ["book", "coffee"] as const;

/** What the approval carries, checked again when a human decides. */
const giftPayload = z.object({
  type: z.literal("gift"),
  person_id: z.string(),
  gift: z.enum(GIFTS),
});

export const requestGift = defineOperation({
  id: "gifts.request",
  summary: "Ask a human to approve a gift for a lead",
  description:
    "Creates a pending approval to send a small gift (a book or coffee) to one person. Nothing ships until a human approves it with approvals.decide. Use it for warm leads after a positive reply, never for cold prospects. dry_run shows the approval title without creating it.",
  effect: "write",
  input: z.object({
    person_id: idSchema("pe").describe("The person (pe_...)"),
    gift: z.enum(GIFTS).describe("book or coffee"),
  }),
  output: z.union([awaitingApprovalOutput, dryRunOutput(z.object({ title: z.string() }))]),
  http: { method: "POST", path: "/v1/gifts" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    { title: "A book", input: { person_id: "pe_01k6a3v0q8x3m2n4p5r6s7t8v9", gift: "book" } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const [person] = await ctx.db
      .select()
      .from(people)
      .where(and(eq(people.id, input.person_id), eq(people.workspace_id, workspace.id)));
    if (!person) throw notFound("Person", input.person_id);
    const title = `Send a ${input.gift} to ${person.full_name ?? person.email ?? person.id}`;
    if (ctx.request.dryRun) return dryRun({ title });
    const summary = `${title}. Approve to ship it.`;
    const { id } = await ctx.approvals.request({
      kind: "custom",
      title,
      summary,
      payload: { type: "gift", person_id: person.id, gift: input.gift },
      target: { type: "person", id: person.id },
    });
    return awaitingApproval(id, summary);
  },
});

/** Ships an approved gift. A job can run more than once, so it checks before acting. */
export const shipGiftJob = defineJob({
  name: "gifts.ship",
  payload: giftPayload,
  handler: async (ctx, payload) => {
    const [person] = await ctx.db.select().from(people).where(eq(people.id, payload.person_id));
    if (!person || person.custom.gift) return { skipped: true };
    // A real module would call the gift service here.
    await ctx.db
      .update(people)
      .set({ custom: { ...person.custom, gift: payload.gift } })
      .where(eq(people.id, person.id));
    return { shipped: payload.gift };
  },
});

/** The resolver for kind "custom": approve (or edit the gift) queues the job, reject does nothing. */
export const giftResolver: ApprovalResolver = {
  kind: "custom",
  // A decider may swap the gift; any other edit (the person above all) is refused.
  editable: ["gift"],
  apply: async (ctx, approval, decision) => {
    const parsed = giftPayload.safeParse(approval.payload);
    if (!parsed.success) return {};
    if (decision.decision === "reject") return { message: "No gift sent." };
    await ctx.jobs.enqueue("gifts.ship", parsed.data, {
      singletonKey: `gift:${parsed.data.person_id}`,
    });
    return { message: `The ${parsed.data.gift} will ship shortly.` };
  },
};

export const module: EngineModule = {
  name: "gifts",
  operations: [requestGift],
  tools: [
    defineTool({
      name: "request_gift",
      title: "Request a gift",
      description:
        "Asks a human to approve a small gift (a book or coffee) for one lead. Nothing ships before approval. Use it after a positive reply, never for cold prospects.",
      toolset: "leads",
      operation: "gifts.request",
    }),
  ],
  jobs: [shipGiftJob],
  approvalResolvers: [giftResolver],
};
```

How the pieces work together:

1. An agent calls `request_gift` (or someone runs `openoutbound gifts request`). The executor checks the key, the workspace, the scopes (`write`, from the effect) and the input, then runs the handler.
2. The handler stores a pending approval and returns `awaiting_approval`. An identical pending request returns the same approval instead of a new one.
3. A human runs `approvals decide`. The engine calls the resolver registered for the approval's kind.
4. The resolver queues `gifts.ship`. The job runs on the worker, with retries.

`editable` lists the payload fields a decision `edit` may change; without it the approval takes no edits (approve or reject), and the engine refuses an edit to any other field with `validation_failed`, so the person a request names never changes. Only one module can register a resolver for `custom`. If your module needs several kinds of approval, put a `type` field in the payload, as this one does, and branch on it in one resolver.

## Register it

**As a built-in** (in your clone, or in a pull request), import it in `src/modules/index.ts` and add it to the `modules` list. Then:

| Door | What you get |
| --- | --- |
| CLI | `openoutbound gifts request --person-id pe_... --gift book` (flags generated from the input schema, plus `--dry-run`, `--json` and the other common flags) |
| MCP | The `request_gift` tool in the `leads` toolset (`openoutbound mcp --toolsets leads`) |
| REST | `POST /v1/gifts`, and `POST /v1/ops/gifts.request` like every operation |

Run `pnpm generate:reference` to add it to the reference pages.

**In your own program**, pass it to `createEngine`. `modules` replaces the built-in list, so spread it:

```ts
import { createEngine, modules } from "openoutbound";
import { module as gifts } from "./gifts.js";

const engine = await createEngine({ modules: [...modules, gifts] });
```

The `openoutbound` package exports the module contracts (`defineOperation`, `defineTool`, `defineJob`, `onEvent`, `idSchema`, the error helpers and the context types). It does not export the database schema or the test helpers, so a module that reads or writes records, like this one, belongs in the repository. For now the CLI, `openoutbound mcp` and `openoutbound serve` load only the built-in modules.

## Test it

`src/modules/gifts/gifts.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { people } from "../../db/schema/index.js";
import { createTestEngine } from "../../testing/engine.js";
import { seedPerson } from "../../testing/factories.js";
import { modules } from "../index.js";
import { module as gifts } from "./index.js";

it("ships a gift only after a human approves it", async () => {
  const engine = await createTestEngine({ modules: [...modules, gifts] });
  try {
    const workspace = (await engine.call("workspaces.create", { name: "Acme" })) as { id: string };
    const person = await seedPerson({ db: engine.db, workspace });
    const opts = { workspace: "acme" };

    const preview = await engine.call(
      "gifts.request",
      { person_id: person.id, gift: "book", dry_run: true },
      opts,
    );
    expect(preview).toMatchObject({ dry_run: true });

    const request = (await engine.call(
      "gifts.request",
      { person_id: person.id, gift: "book" },
      opts,
    )) as { status: string; approval_id: string };
    expect(request.status).toBe("awaiting_approval");

    await engine.call(
      "approvals.decide",
      { approval_id: request.approval_id, decision: "approve" },
      opts,
    );
    await engine.runJobs();

    const [row] = await engine.db.select().from(people).where(eq(people.id, person.id));
    expect(row?.custom).toMatchObject({ gift: "book" });
  } finally {
    await engine.close();
  }
});
```

If you added the module to `src/modules/index.ts`, call `createTestEngine()` without `modules`: it is already in the list, and listing it twice fails with `duplicate module "gifts"`.

`createTestEngine` runs the real engine on an in-memory database with every migration applied:

| Helper | What it does |
| --- | --- |
| `call(operationId, input, { workspace })` | Runs an operation through the executor, as a human admin with every scope unless you pass `scopes` or `principal` |
| `runJobs()` | Runs due jobs one at a time until none is due (fires due schedules first) |
| `advance(ms)` | Moves the fixed clock forward (it starts at 2026-09-19 12:00 UTC) |
| `fetchRoutes` option | Fake answers for the engine's safe fetch; any other URL throws |
| `dnsRecords` option, `dns.set(name, records)` | Fake MX and TXT records for `ctx.dns`; other names fail with `ENOTFOUND` |
| `close()` | Stops the engine and drops the database |

Seed records with the helpers in `src/testing/factories.ts` (`seedPerson`, `seedCompany`, `seedCampaign` and more).

## The operation contract

| Field | Meaning |
| --- | --- |
| `id` | Dotted snake_case, such as `gifts.request`. The first part is the CLI group |
| `summary`, `description` | One imperative line, then three or four sentences for agents: what, when, when not, caveats |
| `effect` | `read`, `write`, `send`, `spend`, `destructive` or `admin`. Sets the default scopes and the MCP hints |
| `scopes` | Override the scopes the effect implies |
| `input`, `output` | zod schemas. Input keys are snake_case. Never declare `workspace`, `reason`, `dry_run`, `idempotency_key` or `response_format`: the executor adds them; read them from `ctx.request` |
| `dryRun` | `supported`, `default` (previews unless the caller passes `dry_run: false`) or `none` |
| `idempotent` | Safe to repeat with an idempotency key |
| `workspace` | `required`, `optional` or `none` |
| `http`, `cli` | Optional pretty REST route (under `/v1/`) and CLI path |
| `examples` | Valid inputs, checked at import. Used in the docs, CLI help and tool descriptions |
| `handler(ctx, input)` | The work. `ctx` has the database, workspace, principal, config, providers, brain, jobs, events, audit, approvals, usage, vault, safe fetch, DNS lookups (`ctx.dns`), clock, log and the request flags |

## Rules

- **Declare the true effect.** The gate refuses `send` operations while the workspace is paused and `spend` operations once the monthly credit budget is used up. A dry run of a `spend` operation still reaches your handler then, and the gate puts a warning first in its `warnings`.
- **Jobs check for themselves.** Jobs and event handlers run as the system and do not pass through the gate: check the pause switch, suppressions and budgets before you send or spend. They can run more than once, so make them safe to repeat.
- **Dry runs change nothing.** When `ctx.request.dryRun` is true, do not write, send or spend; return `dryRun(preview)`.
- **Ask before acting outside.** Anything that reaches a person or costs money should go through an approval or a clear limit.
- **Outside text is data.** Wrap text from prospects or websites with `wrapUntrusted` in prompts and mark it for agents ([Security](../guides/security.md#prompt-injection)).
- **Errors help.** Throw `OpenOutboundError` with a message that says what happened and a hint that says what to do.
- **Stay in your folder.** A module only edits its own folder, apart from its line in `src/modules/index.ts`.

Event types are fixed for now: a module can listen to any of them, but not add new ones.

Next: [Write a provider](write-a-provider.md) · [Architecture](../architecture.md) · [Safety and approvals](../concepts/safety-and-approvals.md) · [Events](../reference/events.md)
