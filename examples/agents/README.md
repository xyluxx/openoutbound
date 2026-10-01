# Connect an agent

OpenOutbound speaks MCP two ways:

| Mode | When | How |
|---|---|---|
| **stdio** | One person, one machine. The agent starts `openoutbound mcp`; with `openoutbound serve` running, `mcp` forwards every call to it. | `node /absolute/path/to/openoutbound/dist/cli/main.js --home /absolute/path/to/openoutbound mcp --workspace northwind` |
| **HTTP** | A long-running engine (`openoutbound serve` or Docker), several agents or people. | `http://127.0.0.1:7331/mcp` with `Authorization: Bearer <api key>` |

Every stdio example passes `--home` (the folder where you ran `init`), so it works whatever folder the agent runs in, and `--workspace northwind`, so the agent works in the sandbox. Without `--workspace` its calls land in the empty `default` workspace. Use your real workspace slug once you go live ([Going live](../../docs/getting-started/going-live.md)).

Create an API key for HTTP mode with `openoutbound keys create --name my-agent --kind agent`. Agent keys cannot approve their own work; approvals stay with people.

| Agent | File | Where it goes |
|---|---|---|
| Claude Code | none | `claude mcp add openoutbound -- node /absolute/path/to/openoutbound/dist/cli/main.js --home /absolute/path/to/openoutbound mcp --workspace northwind` |
| Claude Code (HTTP) | none | `claude mcp add --transport http openoutbound http://127.0.0.1:7331/mcp --header "Authorization: Bearer $OPENOUTBOUND_API_KEY" --header "OpenOutbound-Workspace: northwind"` |
| Claude Desktop | [claude-desktop.json](claude-desktop.json) | `claude_desktop_config.json` |
| Codex | [codex-config.toml](codex-config.toml) | `~/.codex/config.toml` |
| Cursor (HTTP) | [cursor-mcp.json](cursor-mcp.json) | `.cursor/mcp.json` |
| VS Code (HTTP) | [vscode-mcp.json](vscode-mcp.json) | `.vscode/mcp.json` |

Replace `/absolute/path/to/openoutbound` with your clone path. Start `openoutbound serve` before the agent: the embedded database allows one process at a time, and with `serve` running the CLI and every agent session share it ([The first hour](../../docs/getting-started/first-hour.md#5-start-the-server-in-its-own-terminal)).

Add the skill too, so the agent knows the outbound playbooks: `npx skills add xyluxx/openoutbound`, or install the Claude Code plugin ([Connect your agent](../../docs/getting-started/connect-your-agent.md#claude-code-plugin) shows how, and which key it needs).
