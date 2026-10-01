# Product

<!-- impeccable:product-schema 1 -->

Scope: the OpenOutbound brand and its GitHub-facing images (README hero, architecture diagram, social preview, logo). Kept in `assets/` so the repository root stays clean.

## Platform

web

## Users

Two audiences, weighted equally (confirmed by the owner):

- Developers who work with AI agents (Claude Code, Codex, Cursor) and want an outbound engine their agent can operate. They meet the project on GitHub, star it, clone it and try the sandbox.
- Agency owners and sales leads who run outbound for one or many clients. They care about booked meetings, sender safety and running many client workspaces from one place.

## Product Purpose

OpenOutbound is an open-source, self-hosted AI SDR engine. It finds leads, reads buying signals, writes and sends email and LinkedIn outreach, handles replies and reports results. It runs on its own around the clock; AI agents, scripts or people steer it.

Success for the brand images: within seconds a visitor knows what it is, why it is different, and wants to try the sandbox.

## Positioning

An engine, not a prompt. Sending limits, approvals, suppression, compliance rules and budgets are enforced by code, so an agent cannot blast invites or email someone who unsubscribed, even if it tries. One operation registry opens four doors (MCP server, Agent Skill, CLI, REST API). Any brain works (Anthropic, OpenAI, OpenRouter, local models, the Claude Code or Codex CLI, or the connected agent), and every outside service is a swappable plug-in.

## Operating Context

- Images appear in the GitHub README (light and dark themes through `<picture>`), as the GitHub social preview card (1280 x 640 PNG), and in the docs.
- Readers see README images about 880 to 1000 px wide on desktop and much narrower on phones.
- Agents work in terminals and chat panes; the engine runs as a local process or a Docker service with Postgres.

## Capabilities and Constraints

- Images must work as a plain `<img>` on GitHub: no scripts and no web fonts at view time. Ship 2x PNGs rendered from HTML sources kept in the repo, or self-contained SVG.
- Every README image needs a light and a dark variant.
- No em dash character anywhere.
- Illustrative content uses invented names and `example.com` domains only (the sandbox workspaces Northwind Analytics and Brightsmile Dental Supply).

## Brand Commitments

- Name: OpenOutbound (confirmed).
- Everything else from the first look is replaced (confirmed): its logo, palette, type and images are anti-references.
- License: Apache-2.0. Current tagline: "The open-source AI SDR engine any agent can drive."
- Look (confirmed by the owner, 2026-09-27): the brand sits alongside Linear and Vercel in dark and Apple and Notion in light. Premium, minimal, crisp type, subtle light effects, lots of white space. Unusual concept worlds were considered and turned down; new work is shown finished, at that craft level, never as rough sketches.

## Evidence on Hand

- Real: the open-source code; 41 MCP tools in 8 toolsets; four doors; a sandbox with two demo workspaces and simulated replies; 8 agent eval scenarios; 33 docs pages; 15 built-in buying signals.
- Absent, never to be fabricated: customers, testimonials, reply-rate or meeting benchmarks, pricing, user logos, star counts.

## Product Principles

1. Safety is enforced by code, never only promised in a prompt.
2. Agents do the work; humans approve what matters.
3. Bring your own parts: brain, mailboxes, data providers, CRM.
4. Honest by default: sandbox first, low volume first, no inflated claims.
