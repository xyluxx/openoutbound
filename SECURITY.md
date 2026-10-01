# Security policy

OpenOutbound holds sensitive data: API keys, mailbox credentials, prospect data and message history. We take reports seriously.

## Report a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports within 3 business days and to share a fix plan within 10 business days.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

## Scope

In scope: the engine, its REST API, MCP server, CLI, webhook handling, secret storage, sandbox isolation and the built-in providers.

Especially interesting: authentication or scope bypass, cross-workspace data access, secret disclosure, server-side request forgery through the fetcher or webhooks, prompt injection that leads to an action (sending, spending, exporting data), and unsubscribe or suppression bypass.

Out of scope: vulnerabilities in third-party services themselves, and issues that require an already compromised host.

## Hardening checklist for operators

- Set a strong `OPENOUTBOUND_SECRET_KEY` and keep it out of version control.
- Run behind HTTPS and set `OPENOUTBOUND_BASE_URL` to the public URL.
- Give agents their own API keys with the smallest scopes they need. Keep `approve` for people.
- Leave `OPENOUTBOUND_ALLOW_PRIVATE_NETWORK` off unless you need internal webhooks.
- Back up your database; it contains encrypted secrets and your outreach history.
