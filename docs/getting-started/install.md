# Install

This page covers the two ways to run OpenOutbound (from source, or with Docker and Postgres), where your data lives, how to update and how to back up.

Trying it for the first time? Follow [The first hour](first-hour.md) instead: the same install, then the sandbox and your agent, step by step.

OpenOutbound is not published to npm. Both ways start from a clone of <https://github.com/xyluxx/openoutbound> (Apache-2.0).

| Way | Database | Good for |
| --- | --- | --- |
| From source | Embedded Postgres (PGlite) in a folder, or any Postgres | One person, one machine, trying things, agent-run sessions |
| Docker compose | Postgres 18 in a container | A server that runs 24/7, several agents or people |

## From source

Requirements:

| Tool | Version | How to get it |
| --- | --- | --- |
| Node.js | 22 or 24 (CI also tests the current release, 26) | [nodejs.org](https://nodejs.org) |
| pnpm | 11 | Node 22 or 24: run `corepack enable` once. Node 25 and later ship without Corepack: `npm install -g pnpm@11`. |
| git | any | [git-scm.com](https://git-scm.com) |

```bash
git clone https://github.com/xyluxx/openoutbound
cd openoutbound
pnpm install
pnpm build
node dist/cli/main.js init
node dist/cli/main.js doctor
```

`init` does three things and prints next steps:

1. Writes `.env` with `OPENOUTBOUND_SECRET_KEY` (32 random bytes), `DATABASE_URL=pglite://.openoutbound/pglite` and `OPENOUTBOUND_BASE_URL=http://localhost:7331`. Existing values are kept.
2. Creates and migrates the database.
3. Creates a workspace called `default` when none exists.

The next steps are printed in the form you started `init` with: `pnpm openoutbound <command>` after `pnpm openoutbound init`, `node dist/cli/main.js <command>` after `node dist/cli/main.js init` (the full path when you started it from another folder), with `--home <dir>` when you set up another folder. `doctor` writes its fixes the same way.

`doctor` checks Node.js, the engine home, the config, the base URL, the secret key, the database and migrations, workspaces, providers per slot, mailbox DNS and whether each workspace can send for real, and prints a fix for each problem. While `serve` runs it does the database checks through the server. When no server runs on PGlite, it says that campaigns, sends, reply sync and the sandbox simulator only run while `serve` runs: a warning while a launched campaign, a message to send or a queued job waits. `doctor --workspace <slug>` lists every blocker of one workspace with its fix ([Going live](going-live.md)). It exits with code 1 when a check fails.

### Run the CLI

The command is `dist/cli/main.js`. Pick one way to call it:

| Way | Command | Notes |
| --- | --- | --- |
| Direct | `node /path/to/openoutbound/dist/cli/main.js <command>` | Always works. |
| Shell alias (bash, zsh) | `alias openoutbound="node /path/to/openoutbound/dist/cli/main.js"` | Add the line to `~/.bashrc` or `~/.zshrc`. |
| PowerShell function | `function openoutbound { node C:\path\to\openoutbound\dist\cli\main.js @args }` | Add the line to your `$PROFILE`. |
| Linked command | Run `npm link` once inside the clone, after `pnpm build` | Puts `openoutbound` on your PATH (npm's global bin folder). Remove it with `npm unlink -g openoutbound`. |
| From source, no build | `pnpm openoutbound <command>` inside the clone | Runs TypeScript through `tsx`; slower to start. |

The rest of the docs write `openoutbound <command>`.

### JSON flags in Windows PowerShell 5.1

Some flags take JSON, such as `--settings '{"company":{"postal_address":"..."}}'` or `--secrets '{"api_key":"..."}'`. Windows PowerShell 5.1, the PowerShell that ships with Windows, removes the double quotes inside an argument before node gets it, so the engine receives `{company:{postal_address:...}}` and refuses it. Write the JSON to a file and pass the file name after `@` instead:

```powershell
Set-Content settings.json '{"company":{"postal_address":"12 Example Street, Austin, TX 78701, USA"}}' -Encoding UTF8
openoutbound workspaces update --workspace harbor --settings '@settings.json'
```

Keep the single quotes around `'@settings.json'`: PowerShell reads a bare `@` as the start of a splat. A relative path starts from the folder you run the command in. Every JSON flag takes a file this way (`--secrets '@secrets.json'`, `--input '@input.json'`), in every shell. Bash, zsh and Git Bash pass the JSON as printed.

### Postgres instead of PGlite

PGlite keeps the database in a folder and allows one process at a time. Use Postgres when you want the server and extra workers side by side, or managed backups. Set `DATABASE_URL` in `.env`:

```bash
DATABASE_URL=postgres://user:password@db.example.com:5432/openoutbound
```

Then run `openoutbound db migrate` (or just start the engine: it applies pending migrations on start). There is no built-in tool to copy a PGlite database into Postgres, so choose before you import real data.

### Start the server

```bash
openoutbound serve
```

`serve` runs the REST API (`/v1`), the OpenAPI document (`/openapi.json`), MCP over HTTP (`/mcp`), public routes (unsubscribe pages, OAuth callbacks, inbound webhooks) and the worker for jobs and schedules, all in one process. It listens on `127.0.0.1:7331` by default.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port <port>` | `PORT` or 7331 | Port to listen on |
| `--host <host>` | `HOST` or 127.0.0.1 | Address to bind; use 0.0.0.0 in containers |
| `--no-worker` | worker on | Serve HTTP only; run `openoutbound worker` elsewhere |
| `--cors-origin <origin...>` | CORS off | Allow browser calls from these origins |
| `--rate-limit <n>` | 600 | Requests per minute per API key |

While `serve` runs on PGlite it owns the database. Other local commands (`openoutbound workspaces list`, `openoutbound mcp`) notice the running server through `.openoutbound/server.json` and send their calls to it instead of opening the database.

### One process at a time on PGlite

PGlite cannot share its folder between processes, so the engine locks it. The first process that opens the database writes `.openoutbound/pglite.lock` with its process id and command. Any other process that tries to open it stops with a `conflict` error that names the process and the way out. The usual case is an agent session started before `serve`:

```text
Error (conflict): Your agent's OpenOutbound session (pid 18180, started with "mcp --workspace northwind") has the local database open, and the embedded database allows one process at a time.
Hint: Close the agent session (or stop pid 18180), start `openoutbound serve` in its own terminal, then start the agent again: the CLI and `openoutbound mcp` both connect to the running server by themselves. If no such process runs any more, delete /path/to/openoutbound/.openoutbound/pglite.lock.
```

`doctor` shows the same message instead of its database checks.

A lock left behind by a process that has exited is taken over on the next start.

| You want | Do this |
| --- | --- |
| An agent session and CLI commands at the same time | Run `openoutbound serve`. The CLI and `openoutbound mcp` then send their calls to it. |
| Two agent sessions at once | Same: run `serve` first. |
| `serve --no-worker` plus separate `openoutbound worker` processes | Use Postgres. |

## Docker compose with Postgres

The repository ships a `Dockerfile` (Node 24, runs `serve`) and a `docker-compose.yml` with two services: `postgres` (Postgres 18) and `engine`.

```bash
git clone https://github.com/xyluxx/openoutbound
cd openoutbound
cp .env.example .env
echo "OPENOUTBOUND_SECRET_KEY=$(openssl rand -base64 32)" >> .env
docker compose up -d
docker compose exec engine node dist/cli/main.js doctor
```

What the compose file sets for you:

| Setting | Value |
| --- | --- |
| `DATABASE_URL` | the `postgres` service (overrides `.env`) |
| `HOST`, `PORT` | `0.0.0.0`, `7331` inside the container |
| Published port | `127.0.0.1:7331` on the host only |
| `POSTGRES_PASSWORD` | `openoutbound` unless you set it in `.env` |
| Data | named volume `pgdata` |

Every other variable comes from `.env` (provider keys, `OPENOUTBOUND_BASE_URL`, and so on). Set `POSTGRES_PASSWORD` in `.env` before the first start if the machine is shared.

Run CLI commands inside the container:

```bash
docker compose exec engine node dist/cli/main.js keys create --name my-agent --kind agent
docker compose exec engine node dist/cli/main.js sandbox
```

Agents connect over HTTP: `http://127.0.0.1:7331/mcp` with `Authorization: Bearer <api key>`. See [Connect your agent](connect-your-agent.md). To put the server on the internet with HTTPS, read [Deploy](../guides/deploy.md).

## Where your data lives

The engine home is the folder that holds `.env` and `.openoutbound/`. The CLI finds it in this order: `--home <dir>`, then `OPENOUTBOUND_HOME`, then the current folder if it has `.env` or `.openoutbound/`, then the clone folder if it has them, then the current folder.

| Path | What it holds |
| --- | --- |
| `.env` | Configuration, including `OPENOUTBOUND_SECRET_KEY` |
| `.openoutbound/pglite/` | The embedded database (default `DATABASE_URL`) |
| `.openoutbound/pglite.lock` | Written while a process has the embedded database open: its process id and command |
| `.openoutbound/server.json` | Written while `serve` runs: URL, process id and two local-only keys for local tools |
| Your Postgres | Everything, when `DATABASE_URL` is a `postgres://` URL |
| stderr | Logs, as JSON lines (`LOG_LEVEL`, default `info`) |

The database holds workspaces, leads, messages, the audit log and every stored secret. Provider keys, mailbox passwords, OAuth tokens and webhook secrets are encrypted with `OPENOUTBOUND_SECRET_KEY` (AES-256-GCM). Without that key they cannot be read.

## Back up

Back up two things together: the database and `.env` (or at least `OPENOUTBOUND_SECRET_KEY`).

| Setup | Backup | Restore |
| --- | --- | --- |
| PGlite | Stop `serve`, `worker` and agent sessions, then copy `.openoutbound/pglite/` | Stop the engine, put the folder back |
| Postgres | `pg_dump --format=custom -f openoutbound.dump "$DATABASE_URL"` | `pg_restore --clean -d "$DATABASE_URL" openoutbound.dump` |
| Docker compose | `docker compose exec postgres pg_dump -U openoutbound openoutbound > openoutbound.sql` | `docker compose exec -T postgres psql -U openoutbound openoutbound < openoutbound.sql` |

Store backups encrypted. They contain prospect data and message history.

## Update

From source:

```bash
git pull
pnpm install --frozen-lockfile
pnpm build
```

Then restart `serve` (and `worker`, if you run it separately). Migrations apply on start; `openoutbound db migrate` applies them without starting anything.

Docker compose:

```bash
git pull
docker compose build
docker compose up -d
```

Read [CHANGELOG.md](../../CHANGELOG.md) before you update.

Next: [Connect your agent](connect-your-agent.md) · [The sandbox](sandbox.md) · [Deploy on a server](../guides/deploy.md) · [Configuration reference](../reference/configuration.md)
