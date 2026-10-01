# Contributing to OpenOutbound

Thanks for helping. This guide gets you from clone to pull request.

## Set up

Requirements: Node.js 22 or 24 and pnpm 11 (on Node 22 or 24 run `corepack enable` once; Node 25 and later ship without Corepack, so run `npm install -g pnpm@11`).

```bash
git clone https://github.com/xyluxx/openoutbound && cd openoutbound
pnpm install
pnpm check        # lint, typecheck, tests, text, link and settings-doc checks
pnpm openoutbound --help
```

No external services are needed for development. Tests run on an in-memory Postgres (PGlite) and never touch the network.

## Project layout

| Path | What lives there |
|---|---|
| `src/core` | Contracts and the engine kernel: operations, safety gate, jobs, events, settings |
| `src/db` | Database schema (Drizzle) and clients for Postgres and PGlite |
| `src/modules/<name>` | One folder per feature: operations, jobs, prompts, tests |
| `src/providers/<slot>` | Plug-ins for external services, one file per provider |
| `src/cli`, `src/http`, `src/mcp` | The doors: CLI, REST API, MCP server |
| `src/sandbox` | The fake world used by `openoutbound sandbox` and tests |
| `skills/openoutbound` | The Agent Skill and its playbooks |
| `docs` | User documentation |
| `evals` | Agent evaluation scenarios and harness |
| `assets` | Brand images, rendered from the HTML in `assets/src` with `node scripts/render-brand.mjs` |

## How changes are shaped

- **Operations are the unit of behavior.** Add or change an operation with `defineOperation` in the owning module. The MCP server, CLI, REST API and reference docs are generated from it, so you rarely touch the doors.
- **Providers are plug-ins.** Implement the slot interface from `src/providers/types.ts`, add recorded fixtures and a contract test, and document setup in `docs/guides`. See [Write a provider](docs/extending/write-a-provider.md).
- **Safety lives in the engine.** Limits, suppression, approvals and budgets are enforced in code paths, never only in prompts or docs.
- **Every door answers the same.** `tests/e2e/permission-parity.test.ts` calls every operation through every door (the engine, REST, remote and embedded MCP, the stdio bridge and the CLI) and checks scopes, workspace boundaries, dry runs and approvals. A new operation must pass it: give it an example, declare `boundPrincipals` when it has no workspace, and list it in `NOT_IN_MCP`, `NOT_IN_CLI` or `NOT_IN_REST` with the reason when a door does not take it.
- **One approval rule.** A new gate (a change that waits for an approval for some callers) decides with `mustRequestApproval(principal)` from `src/runtime/approval-rule.ts` and goes in `APPROVAL_GATES` with a fixture; the parity test fails until it does. An operation that needs the `send` scope or changes what a person approved (`EDITS_APPROVED`) is such a gate, or is listed in `NOT_A_GATE` with the reason it never asks.
- **Prompts are code.** They are versioned with `definePrompt`, validated against a schema, and covered by tests.
- **Agents are users too.** When you change tool descriptions, prompts or the MCP layer, run the agent evals: `pnpm evals --runner scripted --scenario all` (no network, about 30 seconds), and a real agent runner when you can. See [evals/README.md](evals/README.md).

## Conventions

- TypeScript strict, ESM, relative imports with `.js` extensions, kebab-case file names, one concept per file.
- Tests sit next to the code as `*.test.ts`. Cover edge cases, not only the happy path.
- Errors say what happened and what to do next.
- Invented names and `example.com` domains only in fixtures and docs. No real people, customers or secrets.
- Do not use the em dash character anywhere. `pnpm check` enforces it.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(leads): add Hunter domain search`.

## Pull requests

1. Open an issue first for large changes, so we can agree on the shape.
2. Keep pull requests focused. Include tests and docs updates.
3. Run `pnpm check` before pushing, plus `pnpm generate:reference` when operations changed and `pnpm exec tsx scripts/generate-settings-docs.ts` when settings changed (`pnpm check` fails when the settings tables are stale).
4. Describe what changed, why, and how you tested it.

## Reporting bugs and security issues

Use the issue templates for bugs and ideas. Report security issues privately, as described in [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the [Apache-2.0 license](LICENSE).
