# The first hour

This page takes you from a fresh clone to an agent working in the sandbox. You see what the agent proposes, you approve or reject it yourself, and you learn exactly what must be true before anything reaches a real person.

Nothing on this page sends a real email, visits a real LinkedIn profile or spends money. You need no API keys.

Every command below runs from the folder you clone into. Each step says what you should see.

## 1. Prerequisites

| Tool | Version | Check | Get it |
| --- | --- | --- | --- |
| Node.js | 22 or 24 | `node --version` | [nodejs.org](https://nodejs.org) |
| pnpm | 11 | `pnpm --version` | Node 22 or 24: `corepack enable`. Node 25 and later have no Corepack: `npm install -g pnpm@11`. |
| git | any | `git --version` | [git-scm.com](https://git-scm.com) |
| An MCP agent | Claude Code, Codex or any MCP client | `claude --version` or `codex --version` | |

## 2. Clone, install, build

```bash
git clone https://github.com/xyluxx/openoutbound
cd openoutbound
pnpm install
pnpm build
```

You should see `pnpm build` finish without errors. The command line tool is now `dist/cli/main.js`. This page runs it as `node dist/cli/main.js`; if you set up the `openoutbound` command ([Install](install.md#run-the-cli)), use that instead.

## 3. Set up the engine home

<!-- run -->
```bash
node dist/cli/main.js init
```

You should see:

```text
OK    Wrote ... .env (added OPENOUTBOUND_SECRET_KEY, DATABASE_URL, OPENOUTBOUND_BASE_URL)
OK    Database ready (pglite, migrations applied)
OK    Created workspace "default"
Next steps
```

`init` writes `.env` (a random secret key, an embedded database under `.openoutbound/`, the base URL), creates the database and a real but empty workspace called `default`. It never overwrites values you already set. It ends with the next steps, the same ones as this page.

## 4. Create the sandbox

<!-- run -->
```bash
node dist/cli/main.js sandbox
```

You should see:

```text
Sandbox ready: practice workspaces with fake data. Nothing real is ever sent.
Northwind Analytics (sandbox) slug northwind, new
22 companies, 51 people, ... signals, 2 campaigns, 3 mailboxes, 1 LinkedIn account, 4 inbox threads
Brightsmile Dental Supply (sandbox) slug brightsmile, new
```

A sandbox is a workspace where every outside service is fake: lead sources, the email finder and verifier, research, LinkedIn, the mailboxes and the AI brain. Sent emails land in an in-memory outbox, and a prospect simulator answers some of them a few minutes later. Nothing in a sandbox ever reaches a real person or costs money. [The sandbox](sandbox.md) lists what it contains.

This page uses `northwind`: Northwind Analytics, an invented company that sells forecasting software to online shops. See what it holds at any time:

<!-- run -->
```bash
node dist/cli/main.js sandbox status
```

You should see:

```text
Sandbox workspaces: fake data, nothing reaches a real person.
Northwind Analytics (sandbox) slug northwind
```

## 5. Start the server in its own terminal

Open a second terminal in the same folder and start the server. Do this before you start your agent, and leave it running.

<!-- run -->
```bash
node dist/cli/main.js serve
```

You should see:

```text
OpenOutbound is running at http://127.0.0.1:7331 (worker on)
Local CLI and `node dist/cli/main.js mcp` now bridge to this server.
```

Why first: the embedded database allows one process at a time. While `serve` runs, the CLI and the `mcp` command your agent starts find it (through `.openoutbound/server.json`) and send their calls to it, so they all work at once. `serve` also runs the worker: it writes and sends campaign messages, reads replies and runs the prospect simulator. Stop it with Ctrl+C.

## 6. Connect your agent

Every configuration names the engine folder (`--home`) and the sandbox workspace (`--workspace northwind`). Without `--workspace northwind` the agent works in the empty `default` workspace.

Claude Code, from the clone folder:

```bash
claude mcp add openoutbound -- node "$PWD/dist/cli/main.js" --home "$PWD" mcp --workspace northwind
```

Codex, from the clone folder:

```bash
codex mcp add openoutbound -- node "$PWD/dist/cli/main.js" --home "$PWD" mcp --workspace northwind
```

Both lines work as written in bash, zsh, Git Bash and PowerShell. `init` printed them with your paths filled in; on Windows it writes the paths with forward slashes (`C:/code/openoutbound/...`), which Git Bash, PowerShell and cmd all accept.

Any other MCP client: the command is `node`, the arguments are `/absolute/path/to/openoutbound/dist/cli/main.js --home /absolute/path/to/openoutbound mcp --workspace northwind`. Ready-made files for Claude Desktop and Codex are in [examples/agents](../../examples/agents/README.md); [Connect your agent](connect-your-agent.md) covers Cursor, VS Code and HTTP.

You should see the agent list OpenOutbound's tools (`claude mcp list` shows `openoutbound` as connected). Start a new agent session after adding it.

## 7. A short tour

Ask your agent three things, one at a time. Then do your part in the first terminal.

**Read the operating state.** Ask: "Show me the operating state of my OpenOutbound workspace."

<!-- agent: operating-state -->

The agent calls `get_operating_state`. You should see in its answer: Northwind Analytics (sandbox), 2 draft campaigns, 3 active mailboxes, one hot reply waiting and one urgent problem (a prospect asked to have their data deleted).

**Propose a campaign.** Ask: "Enroll the best operations leads in the Signal-triggered ops outreach campaign, show me the launch checklist, then launch it."

<!-- agent: propose-campaign -->

The agent calls `search_leads`, `enroll_leads` (one lead may be skipped: their country needs prior consent), then `launch_campaign` with `dry_run: true` for the checklist: every item passes, and the cost shows $0.00 because the sandbox brain is fake. Then it calls `launch_campaign` for real and gets an approval id instead of a launch: `A person with the approve scope must approve launching "Signal-triggered ops outreach" (review_items). Nothing is sent until then.` The agent cannot approve its own request: the engine refuses it, so the decision is yours.

**Look at what waits.** Ask: "What is waiting for my approval?"

<!-- agent: list-approvals -->

The agent calls `review_items` and shows the launch request.

**Your side.** Everything an agent asks for waits in the approvals queue. List it:

<!-- run -->
```bash
node dist/cli/main.js approvals list --workspace northwind
```

You should see:

```text
apr_... Local agent (agent) Launch campaign "Signal-triggered ops outreach" campaign_launch pending ...
```

Read the request in full (who asked, how many leads and steps, the review level and the launch checklist). Copy the approval id from the list:

<!-- run -->
```bash
node dist/cli/main.js approvals get --workspace northwind --approval-id <approval id>
```

You should see:

```text
kind ... campaign_launch
status ... pending
```

Approve it:

<!-- run -->
```bash
node dist/cli/main.js approvals decide --workspace northwind --approval-id <approval id> --decision approve
```

You should see:

```text
approved 1
```

To say no instead, run the same command with `--decision reject --note "Not this week"`: the campaign stays a draft and the agent sees your note.

**The first emails.** Within a minute or two the running campaign writes the first email for each lead with an email address. A lead without one skips the email steps (the campaign's `missing_data` setting is `skip_step`), so you can see fewer emails than leads; `node dist/cli/main.js operating explain --workspace northwind --person-id <person id>` says why for one lead (`campaigns enrollments --workspace northwind --campaign-id <campaign id>` lists the leads). The review level is `first`: a person approves the first email each lead gets, so each one waits for you. List them:

<!-- run -->
```bash
node dist/cli/main.js approvals list --workspace northwind --kind message
```

You should see:

```text
apr_... Email to ... message pending Step 1 of "Signal-triggered ops outreach" ...
```

If it says `No results.`, wait a minute and run it again. Still nothing? Check that `serve` runs in its own terminal ([step 5](#5-start-the-server-in-its-own-terminal)): the emails are written in the background, and nothing runs there without it. Read one email exactly as it would go out (subject, body, why it says what it says and the automatic check):

<!-- run -->
```bash
node dist/cli/main.js approvals get --workspace northwind --approval-id <approval id>
```

You should see:

```text
title ... Email to ...
subject ... Quick question about ...
```

Approve them, with the ids from the list separated by commas:

<!-- run -->
```bash
node dist/cli/main.js approvals decide --workspace northwind --approval-ids <approval ids> --decision approve
```

You should see one line per email, then the totals:

```text
apr_... Approved ... approved true
failed 0
```

Emails go out inside each lead's send window: Monday to Friday, 8:00 to 17:00 in the lead's timezone. Inside it, each line says `Approved and scheduled inside the recipient's sending window`. Outside it, the line says the window is closed: the emails wait and go out on their own when it opens, as long as `serve` runs.

**What would have been sent.** The worker sends scheduled emails to the simulator, never to a real person. Fast-forward the simulated answers and see what went out:

<!-- run -->
```bash
node dist/cli/main.js sandbox simulate --workspace northwind
```

You should see:

```text
Sandbox northwind
Sent so far, to the simulator (never to a real person): ... emails.
```

The line above it says how many simulated answers arrived now; about one email in five gets one. The count includes the four emails the sandbox starts with. Outside the send window a last line says how many messages wait for it. Read the emails and the conversations:

<!-- run -->
```bash
node dist/cli/main.js messages list --workspace northwind --status sent
node dist/cli/main.js threads list --workspace northwind
```

You should see:

```text
Quick question about ... sent
```

The four emails and threads the sandbox starts with are there too. Until the send window opens, your emails are listed with `--status approved` instead of `--status sent`.

## 8. When does a real send happen?

Never from the sandbox. The engine answers the question for any workspace:

<!-- run -->
```bash
node dist/cli/main.js workspaces readiness --workspace northwind
```

You should see:

```text
Sandbox workspace: nothing it does ever reaches a real person. Use a real workspace to send for real.
```

For the real `default` workspace it lists every blocker, each with the exact command that fixes it:

<!-- run -->
```bash
node dist/cli/main.js workspaces readiness --workspace default
```

You should see:

```text
Nothing can reach a real person yet.
Email: not ready
Blocked Mailbox connected: No real mailbox is connected
Fix: Put MAILBOX_<NAME>_PASSWORD=<app password> in the engine's .env first ... `node dist/cli/main.js mailboxes add --workspace default --email <address> ...
LinkedIn: not ready
Review (first): A person approves the first message each lead gets in a campaign
```

`doctor` checks the whole setup, through the running server, and prints one readiness line per workspace:

<!-- run -->
```bash
node dist/cli/main.js doctor
```

You should see:

```text
Server running at http://127.0.0.1:7331 (pid ...); it owns the PGlite database, so these checks go through it
Sending, northwind: Sandbox workspace: nothing it does ever reaches a real person.
Sending, default: Nothing can reach a real person yet.
```

Your agent sees the same answer as `sending` in `get_status`. [Going live](going-live.md) walks through every condition, in the order you meet them.

## If something goes wrong

| What you see | Why | Fix |
| --- | --- | --- |
| `Error (conflict): Your agent's OpenOutbound session (pid ...) has the local database open` | The agent started before `serve` and opened the embedded database itself. | Close the agent session, start `node dist/cli/main.js serve` in its own terminal, then start the agent again. |
| `serve` stops with `Error (conflict): ... has the local database open` | Same: an agent session or another command holds the database. | Close it, then start `serve` again. |
| `Error (conflict): Port 7331 on 127.0.0.1 is already in use by another program.` | Another program, or another `serve`, uses the port. | Stop it, or run `node dist/cli/main.js serve --port 7332`. The CLI and `mcp` find the new port by themselves. |
| The agent finds no leads, campaigns or approvals | Its MCP command has no `--workspace northwind`, so it works in the empty `default` workspace. | `claude mcp remove openoutbound`, then add it again as in step 6. |
| The agent lists no OpenOutbound tools | The path to `dist/cli/main.js` is wrong, the build is missing, or a second agent session or a CLI command holds the local database: that session stops before it shows any tool, and the lock error appears only in the agent's MCP log. | Run `pnpm build`, then check the path with `claude mcp list` (or `codex mcp list`). Start `node dist/cli/main.js serve` first and leave it running: every session and command then goes through it. |
| `pnpm: command not found` | Node 25 and later have no Corepack. | `npm install -g pnpm@11` (on Node 22 or 24: `corepack enable`). |
| `approvals list --kind message` says `No results.` | The campaign writes the first emails a minute after launch, the launch is not approved yet, or `serve` is not running (nothing runs in the background without it; `doctor` then says `No server is running`). | Start `node dist/cli/main.js serve` in its own terminal if it is not running, wait a minute and list again; check `approvals list --workspace northwind`. |
| `sandbox simulate` says messages wait for their send window | Emails go out Monday to Friday, 8:00 to 17:00 in each lead's timezone. | Nothing: they go out on their own while `serve` runs. If `serve` is not running, start it. |
| Anything else | | Run `node dist/cli/main.js doctor`. Each check prints its fix. |

Next: [Going live](going-live.md) · [Connect your agent](connect-your-agent.md) · [The sandbox](sandbox.md) · [Safety and approvals](../concepts/safety-and-approvals.md)
