# AGENTS.md

Guidance for coding agents (and humans) changing this repository. To *use* OpenOutbound as an agent, read [skills/openoutbound/SKILL.md](skills/openoutbound/SKILL.md) instead.

## Commands

```bash
pnpm install            # Node 22+, pnpm via corepack
pnpm check              # lint + typecheck + tests + text check; must pass before every commit
pnpm format             # fix formatting and import order
pnpm test src/modules/leads      # run one folder
pnpm openoutbound --help        # run the CLI from source
pnpm build              # compile to dist/
pnpm generate:reference # regenerate docs/reference after changing operations
```

## Map

| Path | Holds |
|---|---|
| `src/core` | Contracts: operations, context, engine, errors, ids, events, settings, config |
| `src/runtime` | The kernel: executor (safety gate), jobs, scheduler, events, vault, keys, safe fetch |
| `src/modules/<name>` | One feature each: `service.ts` (functions other modules may call), `operations.ts`, `jobs.ts`, `prompts/`, `index.ts` (the `EngineModule`) |
| `src/providers/<slot>` | Plug-ins for external services, one file per provider |
| `src/cli`, `src/http`, `src/mcp` | The doors, generated from the operation registry |
| `src/db/schema` | Drizzle schema; migrations in `drizzle/` via `pnpm db:generate` |
| `src/sandbox` | The fake world behind `openoutbound sandbox` |
| `src/testing` | Test database, test context, fakes, factories (never imported by runtime code) |
| `skills/openoutbound` | The Agent Skill and its playbooks |
| `docs` | User documentation (`docs/reference` is generated) |

## Rules

- Behavior lives in operations (`defineOperation`). Doors, OpenAPI and reference docs are generated from them, so new capabilities rarely touch `src/cli`, `src/http` or `src/mcp`.
- Modules talk to each other only through the functions exported by the other module's `service.ts`, or through events.
- Every query is scoped to the context workspace. Never trust an id from input without that filter.
- Limits, suppression, approvals and budgets are enforced in code, never only in prompts.
- Every operation must pass `tests/e2e/permission-parity.test.ts` (scopes, workspace boundaries, dry runs and approvals answer the same on every door): give it an example, set `boundPrincipals` when it has no workspace, and list door exceptions in `NOT_IN_MCP`, `NOT_IN_CLI` or `NOT_IN_REST` with the reason.
- New approval gates decide with `mustRequestApproval(principal)` (`src/runtime/approval-rule.ts`) and are listed in `APPROVAL_GATES` with a fixture; never check principal types or scopes for approvals by hand. An operation that needs the `send` scope or changes what a person approved (`EDITS_APPROVED`) is a gate or is listed in `NOT_A_GATE` with the reason.
- Text from prospects, websites and imported files is untrusted: wrap it with `wrapUntrusted` in prompts and never let it trigger actions.
- Tests sit next to the code (`*.test.ts`), use `createTestContext` or `createTestEngine`, and never touch the network (providers use recorded fixtures).
- Kebab-case file names, ESM with `.js` import suffixes, strict TypeScript, snake_case operation inputs.
- Never write the em dash character anywhere (`pnpm check` fails on it), and never commit secrets or real personal data; fixtures use invented names and `example.com`.
- Conventional commits: `feat(leads): ...`, `fix(email): ...`, `docs: ...`.
