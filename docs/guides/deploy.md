# Deploy

This guide shows how to run OpenOutbound on a server around the clock: Docker compose with Postgres, HTTPS through a reverse proxy, the base URL, backups, upgrades and running more workers.

Run it on a server once you send real campaigns. Sequences, reply sync, signal monitors and scheduled reports only run while the engine runs, and prospects must reach your unsubscribe links at any time.

## What you need

| Need | Why |
| --- | --- |
| A Linux server with Docker and the compose plugin | Runs the engine and Postgres |
| A domain name pointing at the server, for example `outbound.example.com` | HTTPS, unsubscribe links, OAuth callbacks, webhooks |
| Ports 80 and 443 open | For the reverse proxy and its certificates |

## 1. Start the engine with Postgres

```bash
git clone https://github.com/xyluxx/openoutbound
cd openoutbound
cp .env.example .env
echo "OPENOUTBOUND_SECRET_KEY=$(openssl rand -base64 32)" >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
echo "OPENOUTBOUND_BASE_URL=https://outbound.example.com" >> .env
docker compose up -d
docker compose exec engine node dist/cli/main.js doctor
```

- The engine applies database migrations on start.
- It listens on `127.0.0.1:7331` on the host only; the reverse proxy is the only way in from outside.
- Set `POSTGRES_PASSWORD` before the first start: Postgres keeps the password it was created with.
- Keep a copy of `.env` somewhere safe. Without `OPENOUTBOUND_SECRET_KEY` the stored provider keys, mailbox passwords and OAuth tokens cannot be read.

Details of the compose file are in [Install](../getting-started/install.md#docker-compose-with-postgres).

## 2. Put HTTPS in front

Any reverse proxy works. With [Caddy](https://caddyserver.com/) on the host, which gets certificates by itself, the whole config is:

```text
outbound.example.com {
	reverse_proxy 127.0.0.1:7331
}
```

Requests larger than 10 MB are refused by the engine, so the proxy needs no special body limit beyond that.

## 3. Set the base URL

`OPENOUTBOUND_BASE_URL` is the public https address of the engine, without a trailing slash. The engine uses it for:

- unsubscribe links in every email (`/u/<token>`) and the one-click `List-Unsubscribe-Post` header (https only)
- OAuth redirect URIs for Google, Microsoft and LinkedIn
- the URLs it shows for meeting, CRM facts and signal webhooks
- links in Slack notifications
- the allowed `Origin` for browser calls to `/mcp`

Until it is a public https URL, campaigns with email steps do not launch in real workspaces, and their emails are held (a `sending_blocked` problem in the attention queue) instead of going out without a working unsubscribe link. Change it in `.env` and restart with `docker compose up -d`; held emails go out within 30 minutes. `openoutbound workspaces readiness --workspace <slug>` shows whether anything else stops a real send.

## What must be reachable

| Path | Who calls it | Auth |
| --- | --- | --- |
| `/u/<token>` (GET and POST) | Prospects and mail clients (unsubscribe) | The signed token |
| `/oauth/google/...`, `/oauth/microsoft/...`, `/oauth/linkedin/...` | Your browser, while connecting an account | A signed state |
| `/hooks/unipile`, `/hooks/unipile/auth` | Unipile | `X-OpenOutbound-Secret` header |
| `/hooks/meetings/<token>` | Cal.com, Calendly, your booking tool | The secret URL |
| `/hooks/signals/<token>` | Your CRM or intent tool | The secret URL |
| `/hooks/crm/<token>` | Your CRM workflow, Zapier or n8n (CRM facts) | The secret URL |
| `/v1/...`, `/mcp`, `/openapi.json` | Your agents, scripts and integrations | API key (`/openapi.json` is public) |
| `/health` | Your monitoring | None |

If you do not want the API and MCP on the internet, block `/v1` and `/mcp` at the proxy and reach them over a VPN or an SSH tunnel. The public routes above must stay open for campaigns to work.

## 4. Connect agents and scripts

Create a key per agent or integration inside the container:

```bash
docker compose exec engine node dist/cli/main.js keys create --name "Claude Code" --kind agent
docker compose exec engine node dist/cli/main.js keys create --name "Client A reports" --kind service --workspace client-a
```

Agents connect to `https://outbound.example.com/mcp` with `Authorization: Bearer <key>`; see [Connect your agent](../getting-started/connect-your-agent.md). Your local CLI can talk to the server too: `openoutbound --url https://outbound.example.com --api-key oo_... workspaces list`.

## 5. Back up

```bash
docker compose exec postgres pg_dump -U openoutbound openoutbound > openoutbound-$(date +%F).sql
```

Run it daily (cron), keep copies off the server, and store them encrypted: they contain prospect data and message history. Back up `.env` with them. Restoring is in [Install](../getting-started/install.md#back-up).

## 6. Upgrade

```bash
git pull
docker compose build
docker compose up -d
```

Read [CHANGELOG.md](../../CHANGELOG.md) first and take a backup. Migrations run when the engine starts.

## 7. Run more workers

One engine process runs the HTTP server and a worker that takes 4 jobs at a time. For more throughput, run the server without a worker and add worker processes. This needs Postgres: workers claim jobs with `FOR UPDATE SKIP LOCKED`, so they never take the same job, and each scheduled slot fires once.

Add a `docker-compose.override.yml` next to the compose file:

```yaml
services:
  engine:
    command: ["serve", "--no-worker"]
  worker:
    image: openoutbound:local
    restart: unless-stopped
    command: ["worker"]
    env_file:
      - path: .env
        required: false
    environment:
      DATABASE_URL: postgres://openoutbound:${POSTGRES_PASSWORD:-openoutbound}@postgres:5432/openoutbound
      OPENOUTBOUND_BASE_URL: ${OPENOUTBOUND_BASE_URL:-http://localhost:7331}
    depends_on:
      postgres:
        condition: service_healthy
```

```bash
docker compose up -d --scale worker=2
```

Sending speed is set by mailbox and LinkedIn limits, not by workers. More workers help with large imports, enrichment, research and many workspaces.

## Monitor

- `GET /health` answers 200 when the database is reachable and 503 when it is not. The Docker image has a health check built on it.
- Logs are JSON lines on stderr (`docker compose logs -f engine`); set `LOG_LEVEL` (`debug`, `info`, `warn`, `error`) in `.env`.
- `doctor` checks configuration, the database, providers and mailbox DNS.
- `get_status` and the attention queue show failed jobs, failing webhooks, paused mailboxes and budgets per workspace. Add a notification channel so problems reach you; see [CRM and notifications](crm-and-notifications.md).

## Without Docker

Run `openoutbound serve` from a source install under your process manager (systemd, pm2) with `DATABASE_URL` pointing at Postgres and `HOST=127.0.0.1`. PGlite works on a server too, but only one process can open it, so you cannot add workers, and CLI commands must go through the running server (they do so by themselves on the same machine).

Next: [Security](security.md) · [Install](../getting-started/install.md) · [Configuration](../reference/configuration.md) · [Mailboxes](mailboxes.md)
