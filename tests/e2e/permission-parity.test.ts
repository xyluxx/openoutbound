/**
 * Permission parity (spec 2): every operation answers a permission question the same way through
 * every door. One real engine (`createTestEngine`, the real executor) serves all of them: the
 * engine call itself, REST (the RPC route and the operation's own route), MCP over HTTP, the
 * embedded MCP server, the stdio bridge, the CLI pointed at the server and the CLI in process.
 * For every operation and every door that exposes it:
 *
 * - a key without one of the operation's scopes gets `forbidden` naming that scope;
 * - a key bound to workspace A naming workspace B gets `forbidden`, and instance-level
 *   operations (`workspace: "none"`) follow their `boundPrincipals` policy;
 * - `dry_run: true` gets the engine's answer: `unsupported` for a write without a preview, a
 *   dry run for operations that have one, and reads ignore it;
 * - every gated operation (APPROVAL_GATES) asks an agent for approval; that agent cannot decide
 *   its own request, nor one from a key it created, and a decision cannot edit the request
 *   onto another target;
 * - every operation that needs the send scope, or can change what a person approved
 *   (EDITS_APPROVED), is a gate or says in NOT_A_GATE why it never needs to ask.
 *
 * Inputs are the operations' own examples with their ids swapped for real ones from the sandbox
 * workspace A. Adding an operation: give it an example (or a fixture in FIXTURES); when it has
 * no MCP tool, CLI command or REST route, list it in NOT_IN_MCP, NOT_IN_CLI or NOT_IN_REST with
 * the reason; when it can wait for an approval for one caller but not another, it goes in
 * APPROVAL_GATES with a fixture and its gate uses `mustRequestApproval`. When it needs the send
 * scope or changes what a person approved and never asks, it goes in NOT_A_GATE with the reason.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { and, asc, eq, getTableColumns, is, isNotNull } from "drizzle-orm";
import { type PgColumn, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliDeps } from "../../src/cli/context.js";
import type { CliIO } from "../../src/cli/io.js";
import { runCli } from "../../src/cli/program.js";
import { ALL_SCOPES, type Principal } from "../../src/core/context.js";
import type { Engine } from "../../src/core/engine.js";
import type { Scope, Via } from "../../src/core/enums.js";
import {
  type AnyOperation,
  awaitingApprovalOutput,
  operationCliPath,
  operationScopes,
} from "../../src/core/operation.js";
import * as schema from "../../src/db/schema/index.js";
import { createHttpApp } from "../../src/http/app.js";
import { errorPayload } from "../../src/mcp/errors.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { serveBridgeStdio } from "../../src/mcp/stdio.js";
import { createTestEngine, type TestEngine } from "../../src/testing/engine.js";

// --- Guard lists ------------------------------------------------------------------------------

/** Operations without an MCP tool, with the reason. */
const NOT_IN_MCP: Record<string, string> = {
  "keys.create": "API keys are managed from the CLI and REST only, so an agent cannot mint keys",
  "keys.list": "API keys are managed from the CLI and REST only",
  "keys.revoke": "API keys are managed from the CLI and REST only",
  "jobs.list": "an operator view; agents follow the jobs they start with get_job",
  "jobs.cancel": "an operator action; agents follow the jobs they start with get_job",
  "audit.list": "the audit log is for operators (CLI and REST)",
  "signals.webhook_tokens.create":
    "webhook tokens are secrets for other systems, set up by an operator",
  "signals.webhook_tokens.list": "webhook tokens are set up by an operator (CLI and REST)",
  "signals.webhook_tokens.revoke": "webhook tokens are set up by an operator (CLI and REST)",
};

/** Operations without a CLI command, with the reason. */
const NOT_IN_CLI: Record<string, string> = {};

/** Operations without their own REST route (they keep POST /v1/ops/{id}), with the reason. */
const NOT_IN_REST: Record<string, string> = {};

/**
 * Operations with a preview whose dry run may answer with the real result, because there is
 * nothing to do, with the reason. Every other one answers a dry run or an error.
 */
const DRY_RUN_PLAIN_ANSWERS: Record<string, string> = {
  "messages.resolve_unknown":
    "a send already settled the way asked answers with the settled message and changes nothing",
};

/** Inputs for operations without an example (examples are preferred). */
const FIXTURES: Record<string, (world: World) => Record<string, unknown>> = {};

interface GateFixture {
  input: (world: World, attempt: number) => Record<string, unknown>;
  /** The call's reason field, when the operation needs one. */
  reason?: string;
}

/**
 * Operations that wait for an approval for someone who must ask (`mustRequestApproval`) and
 * apply directly for a person holding approve, with an input that reaches the gate in A.
 */
const APPROVAL_GATES: Record<string, GateFixture> = {
  "campaigns.launch": { input: (w) => ({ campaign_id: w.fixtures.launchCampaignId }) },
  "campaigns.update": {
    input: (w) => ({
      campaign_id: w.fixtures.reviewCampaignId,
      settings: { review_level: "unsure" },
    }),
  },
  "mailboxes.update": {
    input: (w) => ({ mailbox_id: w.fixtures.mailboxId, daily_limit: 120 }),
  },
  "posts.schedule": {
    input: (w) => ({ post_id: w.fixtures.postId, scheduled_for: "2026-09-29T08:30:00-05:00" }),
  },
  "posts.publish": { input: (w) => ({ post_id: w.fixtures.postId }) },
  "posts.resolve_unknown": {
    input: (w) => ({ post_id: w.fixtures.unknownPostId, outcome: "republish" }),
  },
  "messages.resolve_unknown": {
    input: (w) => ({ message_id: w.fixtures.unknownMessageId, outcome: "resend" }),
  },
  "messages.update": {
    // A person rejects each request, which cancels the message: every door edits its own one.
    input: (w, attempt) => ({
      message_id: w.fixtures.approvedMessageIds[attempt % w.fixtures.approvedMessageIds.length],
      body: `Hi, a new text no person has read (${attempt}). Worth a short call this week?`,
    }),
  },
  "threads.send_reply": {
    input: (w) => ({
      thread_id: w.fixtures.threadId,
      text: "Thanks, Thursday works. I will send an invite.",
    }),
  },
  "signals.automations.create": {
    input: (w, attempt) => ({
      name: `Unattended enroll ${attempt}`,
      filters: { definition_keys: ["job_change"], has_email: true },
      actions: [{ type: "enroll", campaign_id: w.fixtures.launchCampaignId, max_people: 1 }],
      require_approval: false,
    }),
  },
  "signals.automations.update": {
    input: (w) => ({ rule_id: w.fixtures.ruleId, require_approval: false }),
  },
  "changes.propose": {
    input: () => ({
      title: "Hand meetings to the owner",
      operation: "workspaces.update",
      input: { settings: { booking: { mode: "handoff" } } },
    }),
    reason: "Interested leads ask for a person",
  },
};

/**
 * Every source file that creates approvals: the gated operations it serves, or why it is not a
 * gate (the same request for every caller, or a background job with no caller).
 */
const APPROVAL_SOURCES: Record<string, { gates: string[] } | { notAGate: string }> = {
  "src/modules/campaigns/operations/lifecycle.ts": { gates: ["campaigns.launch"] },
  "src/modules/campaigns/review-level.ts": { gates: ["campaigns.update"] },
  "src/modules/campaigns/sequencer/channel-step.ts": { gates: ["messages.update"] },
  "src/modules/content/operations.ts": { gates: ["posts.schedule", "posts.publish"] },
  "src/modules/content/resolve-unknown.ts": { gates: ["posts.resolve_unknown"] },
  "src/modules/email/limits-approval.ts": { gates: ["mailboxes.update"] },
  "src/modules/email/unknown-operations.ts": { gates: ["messages.resolve_unknown"] },
  "src/modules/inbox/draft.ts": {
    notAGate: "reply drafts wait for review for every caller (threads.draft_reply, inbound jobs)",
  },
  "src/modules/inbox/referral.ts": {
    notAGate: "the inbox job asks before contacting a referred person; no caller",
  },
  "src/modules/inbox/thread-operations.ts": { gates: ["threads.send_reply"] },
  "src/modules/leads/saved-searches.ts": {
    notAGate: "ask_first saved searches ask for every caller and on schedules",
  },
  "src/modules/signals/automations/actions.ts": {
    notAGate: "automation actions with require_approval ask when they fire; no caller",
  },
  "src/modules/signals/automations/approval.ts": {
    gates: ["signals.automations.create", "signals.automations.update"],
  },
  "src/modules/strategy/proposals.ts": { gates: ["changes.propose"] },
};

/**
 * Operations that can change the text, target, timing or reach of something a person approved:
 * an approved message or post, a launched campaign, an automation that enrolls without approval,
 * a mailbox's approved limit, an applied change. Stopping one (cancel, pause, unenroll, delete)
 * sends nothing and is not listed. Each is in APPROVAL_GATES or NOT_A_GATE.
 */
const EDITS_APPROVED = [
  "campaigns.enroll",
  "campaigns.pick_winner",
  "campaigns.teach",
  "campaigns.update",
  "changes.undo",
  "mailboxes.update",
  "messages.regenerate",
  "messages.resolve_unknown",
  "messages.update",
  "posts.publish",
  "posts.resolve_unknown",
  "posts.schedule",
  "posts.update",
  "signals.automations.update",
];

/**
 * Operations that need the send scope or change what a person approved (EDITS_APPROVED) but
 * never ask anyone for approval, with the reason. Everything else that does is a gate.
 */
const NOT_A_GATE: Record<string, string> = {
  "campaigns.enroll":
    "adds people to a campaign: their messages follow its review level, and a launch request counts who was enrolled when it was asked",
  "campaigns.pick_winner":
    "keeps one of the texts the step already had; messages already written keep their text and new ones follow the review level",
  "campaigns.resume":
    "continues a campaign a person launched or approved; its messages still follow the review level",
  "campaigns.teach":
    "adds writing rules for messages not written yet, which follow the review level",
  "changes.undo":
    "writes through the same update functions, whose gates run for the caller (a lower review level waits, settings that loosen a gate are refused)",
  "messages.regenerate":
    "discards the text and writes a new one, which goes through the review level like any new message; the old approval never covers it",
  "posts.update":
    "a new text or account sends an approved or scheduled post back to draft, out of its approval; a new time keeps the approved text",
  "workspaces.resume":
    "lifts the kill switch on what was already allowed to go out before the pause; it needs the send scope",
};

// --- Doors ------------------------------------------------------------------------------------

const DOORS = [
  "engine",
  "rest_rpc",
  "rest_route",
  "mcp_remote",
  "mcp_embedded",
  "mcp_bridge",
  "cli_bridge",
  "cli_local",
] as const;
type Door = (typeof DOORS)[number];

const BASE_URL = "http://127.0.0.1:7331";
const ROOT = resolve(import.meta.dirname, "../..");

/** Who calls: the plain API key and the principal it authenticates to. */
interface Caller {
  key: string;
  principal: Principal;
}

interface Common {
  workspace?: string;
  dryRun?: boolean;
  reason?: string;
}

type Answer =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: string; details: Record<string, unknown> };

interface World {
  engine: TestEngine;
  app: ReturnType<typeof createHttpApp>["app"];
  a: { id: string; slug: string };
  b: { id: string; slug: string };
  /** A person's key holding every scope, not bound to a workspace. */
  owner: Caller;
  /** An agent key holding every scope, bound to A. */
  agent: Caller;
  /** A key that agent created, holding every scope, bound to A. */
  minted: Caller;
  /** Unbound agent keys holding every scope but one. */
  lacking: Record<Scope, Caller>;
  /** Example id prefix (cmp, thr, ...) to the first real id of that kind in A. */
  ids: Map<string, string>;
  fixtures: {
    launchCampaignId: string;
    reviewCampaignId: string;
    mailboxId: string;
    postId: string;
    /** A post whose publish got no clear answer (status unknown). */
    unknownPostId: string;
    /** An email whose send got no clear answer (status unknown). */
    unknownMessageId: string;
    /** Step emails a person approved, two per door (the agent's and the minted key's edit). */
    approvedMessageIds: string[];
    threadId: string;
    ruleId: string;
  };
  tools: Map<string, { name: string; action: string | null }>;
  cliDir: string;
}

let world: World;
const closers: Array<() => Promise<void>> = [];
/** Cells a door cannot express, printed at the end. */
const skipped = new Map<string, string>();

function routeTo(app: World["app"]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    app.fetch(new Request(input, init))) as typeof fetch;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}

async function capture(run: () => Promise<unknown>): Promise<Answer> {
  try {
    return { ok: true, value: asRecord(await run()) };
  } catch (error) {
    const payload = errorPayload(error);
    return { ok: false, code: payload.code, details: payload.details ?? {} };
  }
}

/** The normalized answer compared across doors: outcome, code, missing scope or reason. */
function summarize(answer: Answer): string {
  if (answer.ok) {
    const value = answer.value;
    if (value.status === "awaiting_approval" && typeof value.approval_id === "string") {
      return "awaiting_approval";
    }
    return value.dry_run === true ? "dry_run" : "ok";
  }
  const { missing_scope: scope, reason } = answer.details;
  if (typeof scope === "string") return `${answer.code} missing_scope=${scope}`;
  if (typeof reason === "string" && ["forbidden", "unsupported"].includes(answer.code)) {
    return `${answer.code} reason=${reason}`;
  }
  return answer.code;
}

/** The input for an operation: its first example with real ids from A, else its fixture. */
function inputFor(op: AnyOperation): Record<string, unknown> | null {
  const example = op.examples[0]?.input;
  if (example !== undefined) return hydrate(example) as Record<string, unknown>;
  const fixture = FIXTURES[op.id];
  return fixture ? fixture(world) : null;
}

const EXAMPLE_ID = /^([a-z]{2,5})_[0-9a-z]{26}$/;

function hydrate(value: unknown): unknown {
  if (typeof value === "string") {
    const prefix = EXAMPLE_ID.exec(value)?.[1];
    return (prefix && world.ids.get(prefix)) ?? value;
  }
  if (Array.isArray(value)) return value.map(hydrate);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrate(item)]));
  }
  return value;
}

/** Why a door does not take an operation, or null when it does. */
function notExposed(door: Door, op: AnyOperation): string | null {
  if (door.startsWith("mcp_") && !world.tools.has(op.id)) return NOT_IN_MCP[op.id] ?? "no tool";
  if (door.startsWith("cli_") && NOT_IN_CLI[op.id]) return NOT_IN_CLI[op.id] ?? null;
  if (door === "rest_route" && !op.http) return NOT_IN_REST[op.id] ?? "no route";
  return null;
}

async function call(
  door: Door,
  who: Caller,
  op: AnyOperation,
  input: Record<string, unknown>,
  common: Common,
): Promise<Answer> {
  switch (door) {
    case "engine":
      return capture(() =>
        world.engine.call(op.id, input, {
          principal: who.principal,
          ...(common.workspace ? { workspace: common.workspace } : {}),
          ...(common.dryRun !== undefined ? { dryRun: common.dryRun } : {}),
          ...(common.reason ? { reason: common.reason } : {}),
        }),
      );
    case "rest_rpc":
      return viaRest(who, "POST", `/v1/ops/${op.id}`, { ...input, ...commonFields(common) });
    case "rest_route":
      return viaRoute(who, op, input, common);
    case "mcp_remote":
    case "mcp_embedded":
    case "mcp_bridge":
      return viaMcp(door, who, op, input, common);
    case "cli_bridge":
    case "cli_local":
      return viaCli(door, who, op, input, common);
  }
}

function commonFields(common: Common): Record<string, unknown> {
  return {
    ...(common.workspace ? { workspace: common.workspace } : {}),
    ...(common.dryRun !== undefined ? { dry_run: common.dryRun } : {}),
    ...(common.reason ? { reason: common.reason } : {}),
  };
}

async function viaRest(
  who: Caller,
  method: string,
  path: string,
  body: Record<string, unknown> | null,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const response = await world.app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${who.key}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = asRecord(await response.json().catch(() => ({})));
  if (response.ok) return { ok: true, value: parsed };
  return {
    ok: false,
    code: typeof parsed.code === "string" ? parsed.code : `http_${response.status}`,
    details: asRecord(parsed.details ?? {}),
  };
}

/** The operation's own route: path parameters from the input, the rest as query or body. */
async function viaRoute(
  who: Caller,
  op: AnyOperation,
  input: Record<string, unknown>,
  common: Common,
): Promise<Answer> {
  const http = op.http;
  if (!http) throw new Error(`${op.id} has no route`);
  const rest: Record<string, unknown> = { ...input };
  const missing: string[] = [];
  const path = http.path.replace(/:([A-Za-z_]+)/g, (_match, name: string) => {
    const value = rest[name];
    delete rest[name];
    if (typeof value !== "string" && typeof value !== "number") missing.push(name);
    return encodeURIComponent(String(value));
  });
  if (missing.length > 0) {
    throw new Error(`${op.id}: the input has no ${missing.join(", ")} for ${http.path}`);
  }
  const { workspace, ...others } = common;
  const headers: Record<string, string> = workspace ? { "OpenOutbound-Workspace": workspace } : {};
  const fields = { ...rest, ...commonFields(others) };
  if (http.method === "GET" || http.method === "DELETE") {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      if (value === null || value === undefined) continue;
      query.append(name, typeof value === "string" ? value : JSON.stringify(value));
    }
    const search = query.size > 0 ? `?${query}` : "";
    return viaRest(who, http.method, `${path}${search}`, null, headers);
  }
  return viaRest(who, http.method, path, fields, headers);
}

const mcpClients = new Map<string, Client>();

async function mcpClient(door: Door, who: Caller): Promise<Client> {
  const id = `${door} ${who.key}`;
  const existing = mcpClients.get(id);
  if (existing) return existing;
  const client = new Client({ name: "permission-parity", version: "1.0.0" });
  if (door === "mcp_remote") {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp?toolsets=all`), {
        fetch: routeTo(world.app),
        requestInit: { headers: { Authorization: `Bearer ${who.key}` } },
      }),
    );
  } else {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    if (door === "mcp_embedded") {
      const server = buildMcpServer(world.engine, {
        principal: { ...who.principal, via: "mcp" },
        toolsets: "all",
      });
      await server.connect(serverSide);
      closers.push(() => server.close());
    } else {
      const handle = await serveBridgeStdio({
        url: BASE_URL,
        apiKey: who.key,
        toolsets: "all",
        transport: serverSide,
        fetch: routeTo(world.app),
      });
      closers.push(() => handle.close());
    }
    await client.connect(clientSide);
  }
  closers.push(() => client.close());
  mcpClients.set(id, client);
  return client;
}

async function viaMcp(
  door: Door,
  who: Caller,
  op: AnyOperation,
  input: Record<string, unknown>,
  common: Common,
): Promise<Answer> {
  const tool = world.tools.get(op.id);
  if (!tool) throw new Error(`${op.id} has no MCP tool`);
  const client = await mcpClient(door, who);
  const result = (await client.callTool({
    name: tool.name,
    arguments: {
      ...(tool.action ? { action: tool.action } : {}),
      ...input,
      ...commonFields(common),
    },
  })) as { isError?: boolean; structuredContent?: unknown };
  const structured = asRecord(result.structuredContent ?? {});
  if (!result.isError) return { ok: true, value: structured };
  const error = asRecord(structured.error ?? {});
  return {
    ok: false,
    code: typeof error.code === "string" ? error.code : "unknown",
    details: asRecord(error.details ?? {}),
  };
}

/** The input as CLI arguments: --input JSON, or one flag per field when a field is `input`. */
function cliInputArgs(op: AnyOperation, input: Record<string, unknown>): string[] {
  if (!("input" in op.input.shape)) {
    return Object.keys(input).length > 0 ? ["--input", JSON.stringify(input)] : [];
  }
  return Object.entries(input).flatMap(([name, value]) => {
    const flag = name.replaceAll("_", "-");
    if (value === true) return [`--${flag}`];
    if (value === false) return [`--no-${flag}`];
    if (value === null || value === undefined) return [];
    return [`--${flag}`, typeof value === "string" ? value : JSON.stringify(value)];
  });
}

/** The engine as the in-process CLI opens it, acting as `principal` instead of local-admin. */
function engineActingAs(engine: TestEngine, principal: Principal): Engine {
  return new Proxy(engine, {
    get(target, property, receiver) {
      if (property === "localPrincipal") {
        return (_kind: "admin" | "agent", via: Via): Principal => ({ ...principal, via });
      }
      // The CLI closes the engine it opened; this one is shared.
      if (property === "close") return async () => {};
      return Reflect.get(target, property, receiver);
    },
  });
}

async function viaCli(
  door: Door,
  who: Caller,
  op: AnyOperation,
  input: Record<string, unknown>,
  common: Common,
): Promise<Answer> {
  const out = { stdout: "", stderr: "" };
  const io: CliIO = {
    stdout: (text) => {
      out.stdout += text;
    },
    stderr: (text) => {
      out.stderr += text;
    },
    stdoutIsTTY: false,
    stderrIsTTY: false,
  };
  const argv = [
    ...(door === "cli_bridge" ? ["--url", BASE_URL, "--api-key", who.key] : []),
    ...operationCliPath(op),
    ...cliInputArgs(op, input),
    ...(common.workspace ? ["--workspace", common.workspace] : []),
    ...(common.dryRun === true ? ["--dry-run"] : common.dryRun === false ? ["--no-dry-run"] : []),
    ...(common.reason ? ["--reason", common.reason] : []),
    "--json",
  ];
  const deps: CliDeps = {
    io,
    env: { DATABASE_URL: "memory://" },
    cwd: world.cliDir,
    chdir: () => {},
    packageRoot: world.cliDir,
    registry: world.engine.registry,
    fetch: routeTo(world.app),
    createEngine: async () => {
      if (door === "cli_bridge") throw new Error("the CLI bridge must not open an engine");
      return engineActingAs(world.engine, who.principal);
    },
  };
  const code = await runCli(argv, deps);
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(out.stdout));
  } catch {
    return { ok: false, code: "cli_usage", details: { exit: code, stderr: out.stderr.trim() } };
  }
  if (code === 0) return { ok: true, value: parsed };
  const error = asRecord(parsed.error ?? {});
  return {
    ok: false,
    code: typeof error.code === "string" ? error.code : "unknown",
    details: asRecord(error.details ?? {}),
  };
}

// --- World ------------------------------------------------------------------------------------

async function createKey(
  engine: TestEngine,
  name: string,
  kind: "human" | "agent",
  scopes: Scope[],
  workspace?: string,
  by?: Principal,
): Promise<Caller> {
  const created = asRecord(
    await engine.call(
      "keys.create",
      { name, kind, scopes },
      { ...(workspace ? { workspace } : {}), ...(by ? { principal: by } : {}) },
    ),
  );
  const key = String(created.key);
  const principal = await engine.authenticate(key, "cli");
  if (!principal) throw new Error(`key ${name} does not authenticate`);
  return { key, principal };
}

/** The first id of every kind of row in the workspace, by id prefix. */
async function realIds(engine: TestEngine, workspaceId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const entry of Object.values(schema)) {
    if (!is(entry, PgTable)) continue;
    const table: PgTable = entry;
    const columns: Record<string, PgColumn | undefined> = getTableColumns(table);
    const id = columns.id;
    const workspace = columns.workspace_id;
    if (!id || !workspace) continue;
    const [row] = await engine.db
      .select({ id })
      .from(table)
      .where(eq(workspace, workspaceId))
      .orderBy(asc(id))
      .limit(1);
    const value = row?.id;
    if (typeof value !== "string" || !value.includes("_")) continue;
    const prefix = value.slice(0, value.indexOf("_"));
    if (!ids.has(prefix)) ids.set(prefix, value);
  }
  return ids;
}

/** Draft campaigns, a draft post, a thread, a mailbox and an automation in A for the gates. */
async function gateFixtures(engine: TestEngine, agent: Caller, workspaceId: string, slug: string) {
  const owner = { workspace: slug };
  const [offer] = await engine.db
    .select()
    .from(schema.offers)
    .where(
      and(
        eq(schema.offers.workspace_id, workspaceId),
        eq(schema.offers.name, "Stockout Risk Audit"),
      ),
    );
  const lists = asRecord(await engine.call("lists.list", {}, owner));
  const list = (lists.items as Array<{ id: string; name: string }>).find(
    (item) => item.name === "High fit, hiring signal",
  );
  const mailboxes = await engine.db
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.workspace_id, workspaceId))
    .orderBy(asc(schema.mailboxes.created_at));
  const mailboxIds = mailboxes.filter((row) => row.status === "active").map((row) => row.id);
  if (!offer || !list || mailboxIds.length === 0) throw new Error("sandbox data missing");
  const steps = [
    {
      type: "email",
      config: { mode: "new_thread", style: "free", instruction: "Offer the audit.", max_words: 90 },
    },
    {
      type: "email",
      delay_days: 4,
      config: { mode: "reply", style: "free", instruction: "One short bump.", max_words: 40 },
    },
  ];
  const campaign = async (name: string) =>
    String(
      asRecord(
        await engine.call(
          "campaigns.create",
          {
            name,
            goal: "meeting",
            offer_id: offer.id,
            steps,
            settings: { senders: { mailbox_ids: mailboxIds }, review_level: "first" },
          },
          owner,
        ),
      ).id,
    );
  const launchCampaignId = await campaign("Peak season audit");
  await engine.call("campaigns.enroll", { campaign_id: launchCampaignId, list_id: list.id }, owner);
  const reviewCampaignId = await campaign("Peak season follow-up");
  const [post] = await engine.db
    .insert(schema.posts)
    .values({
      workspace_id: workspaceId,
      body: "Three lessons from a busy inventory season, and what we would plan differently.",
    })
    .returning();
  const [unknownPost] = await engine.db
    .insert(schema.posts)
    .values({
      workspace_id: workspaceId,
      body: "What a slow week in the warehouse taught us about reorder points.",
      status: "unknown",
      publish_attempt: 1,
    })
    .returning();
  const [recipient] = await engine.db
    .select()
    .from(schema.people)
    .where(and(eq(schema.people.workspace_id, workspaceId), isNotNull(schema.people.email)))
    .orderBy(asc(schema.people.id))
    .limit(1);
  const [unknownMessage] = await engine.db
    .insert(schema.messages)
    .values({
      workspace_id: workspaceId,
      person_id: recipient?.id ?? null,
      mailbox_id: mailboxIds[0] ?? null,
      channel: "email",
      action: "email",
      direction: "outbound",
      status: "unknown",
      attempt: 1,
      subject: "stockouts at peak season",
      body_text: "Hi, a short note about reorder points before the busy season.",
      to_address: recipient?.email ?? null,
      message_id_header: "<parity-unknown@northwind.example.com>",
    })
    .returning();
  const [reviewStep] = await engine.db
    .select()
    .from(schema.campaign_steps)
    .where(eq(schema.campaign_steps.campaign_id, reviewCampaignId))
    .orderBy(asc(schema.campaign_steps.position))
    .limit(1);
  const approvedMessages = await engine.db
    .insert(schema.messages)
    .values(
      [...DOORS, ...DOORS].map((door) => ({
        workspace_id: workspaceId,
        campaign_id: reviewCampaignId,
        step_id: reviewStep?.id ?? null,
        person_id: recipient?.id ?? null,
        channel: "email" as const,
        action: "email" as const,
        direction: "outbound" as const,
        status: "approved" as const,
        subject: "reorder points",
        body_text: `Hi, the text a person approved for the ${door} door.`,
        to_address: recipient?.email ?? null,
      })),
    )
    .returning({ id: schema.messages.id });
  const rule = asRecord(
    await engine.call(
      "signals.automations.create",
      {
        name: "Champion moved",
        filters: { definition_keys: ["job_change"], has_email: true },
        actions: [{ type: "enroll", campaign_id: launchCampaignId, max_people: 1 }],
        require_approval: true,
      },
      owner,
    ),
  );
  // A thread the agent may answer (no opt-out or suppression in the way).
  const threads = await engine.db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.workspace_id, workspaceId))
    .orderBy(asc(schema.threads.created_at));
  let threadId: string | null = null;
  for (const thread of threads) {
    const preview = asRecord(
      await engine
        .call(
          "threads.send_reply",
          { thread_id: thread.id, text: "Thanks." },
          { workspace: slug, principal: agent.principal, dryRun: true },
        )
        .catch(() => ({})),
    );
    const blocked = asRecord(preview.preview ?? {}).blocked_reasons;
    if (Array.isArray(blocked) && blocked.length === 0) {
      threadId = thread.id;
      break;
    }
  }
  if (!post || !unknownPost || !unknownMessage || !recipient || !reviewStep || !threadId) {
    throw new Error("no post, person or answerable thread in the sandbox");
  }
  return {
    launchCampaignId,
    reviewCampaignId,
    mailboxId: mailboxIds[0] as string,
    postId: post.id,
    unknownPostId: unknownPost.id,
    unknownMessageId: unknownMessage.id,
    approvedMessageIds: approvedMessages.map((row) => row.id),
    threadId,
    ruleId: String(rule.id),
  };
}

beforeAll(async () => {
  const engine = await createTestEngine();
  await engine.call("sandbox.seed", { world: "northwind" });
  const a = asRecord(await engine.call("workspaces.get", {}, { workspace: "northwind" }));
  const b = asRecord(await engine.call("workspaces.create", { name: "Bravo Parity" }));
  const owner = await createKey(engine, "Parity owner", "human", [...ALL_SCOPES]);
  const agent = await createKey(engine, "Parity agent", "agent", [...ALL_SCOPES], "northwind");
  const minted = await createKey(
    engine,
    "Parity agent's own key",
    "agent",
    [...ALL_SCOPES],
    "northwind",
    agent.principal,
  );
  const lacking = {} as Record<Scope, Caller>;
  for (const scope of ALL_SCOPES) {
    const scopes = ALL_SCOPES.filter((candidate) => candidate !== scope);
    lacking[scope] = await createKey(engine, `Parity without ${scope}`, "agent", scopes);
  }
  const tools = new Map<string, { name: string; action: string | null }>();
  for (const tool of engine.registry.tools()) {
    for (const [action, operationId] of Object.entries(tool.actions ?? {})) {
      if (!tools.has(operationId)) tools.set(operationId, { name: tool.name, action });
    }
    if (tool.operation && !tools.has(tool.operation)) {
      tools.set(tool.operation, { name: tool.name, action: null });
    }
  }
  const { app, close } = createHttpApp(engine, { rateLimitPerMinute: 1_000_000 });
  closers.push(close);
  const cliDir = mkdtempSync(join(tmpdir(), "oo-parity-"));
  closers.push(async () => rmSync(cliDir, { recursive: true, force: true }));
  world = {
    engine,
    app,
    a: { id: String(a.id), slug: String(a.slug) },
    b: { id: String(b.id), slug: String(b.slug) },
    owner,
    agent,
    minted,
    lacking,
    ids: new Map(),
    fixtures: await gateFixtures(engine, agent, String(a.id), String(a.slug)),
    tools,
    cliDir,
  };
  world.ids = await realIds(engine, world.a.id);
}, 120_000);

afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  await world?.engine.close();
  if (skipped.size > 0) {
    const lines = [...skipped].map(([cell, reason]) => `  ${cell}: ${reason}`);
    console.info(`Permission parity: cells a door cannot express\n${lines.join("\n")}`);
  }
});

// --- Tests ------------------------------------------------------------------------------------

const operations = (): AnyOperation[] => world.engine.registry.operations();

describe("permission parity guards", () => {
  it("has an input for every operation", () => {
    const missing = operations()
      .filter((op) => op.examples.length === 0 && !FIXTURES[op.id])
      .map((op) => `${op.id}: add an example to the operation (or a fixture to FIXTURES)`);
    expect(missing).toEqual([]);
  });

  it("lists every operation a door does not take, with a reason", () => {
    const ids = new Set(operations().map((op) => op.id));
    const problems: string[] = [];
    for (const op of operations()) {
      if (!world.tools.has(op.id) && !NOT_IN_MCP[op.id]) {
        problems.push(`${op.id} has no MCP tool: add it to a tool or to NOT_IN_MCP with a reason`);
      }
      if (world.tools.has(op.id) && NOT_IN_MCP[op.id]) {
        problems.push(`${op.id} has an MCP tool now: remove it from NOT_IN_MCP`);
      }
      if (!op.http && !NOT_IN_REST[op.id]) {
        problems.push(`${op.id} has no REST route: add one (http) or list it in NOT_IN_REST`);
      }
      if (op.http && NOT_IN_REST[op.id]) {
        problems.push(`${op.id} has a REST route now: remove it from NOT_IN_REST`);
      }
    }
    for (const [list, entries] of Object.entries({ NOT_IN_MCP, NOT_IN_CLI, NOT_IN_REST })) {
      for (const id of Object.keys(entries)) {
        if (!ids.has(id)) problems.push(`${list} names ${id}, which is not an operation`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("knows every place that creates approvals and every operation that can await one", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          if (/approvals\.request\(/.test(readFileSync(path, "utf8"))) {
            sources.push(relative(ROOT, path).replaceAll("\\", "/"));
          }
        }
      }
    };
    walk(join(ROOT, "src"));
    const problems: string[] = [];
    for (const source of sources) {
      if (!APPROVAL_SOURCES[source]) {
        problems.push(
          `${source} creates approvals: list it in APPROVAL_SOURCES, and put operations that ask some callers but not others in APPROVAL_GATES with a fixture`,
        );
      }
    }
    for (const source of Object.keys(APPROVAL_SOURCES)) {
      if (!sources.includes(source)) {
        problems.push(`APPROVAL_SOURCES lists ${source}, which no longer creates approvals`);
      }
    }
    const gated = Object.values(APPROVAL_SOURCES).flatMap((entry) =>
      "gates" in entry ? entry.gates : [],
    );
    for (const id of gated) {
      if (!APPROVAL_GATES[id]) problems.push(`${id} is a gate: add it to APPROVAL_GATES`);
    }
    for (const id of Object.keys(APPROVAL_GATES)) {
      if (!gated.includes(id)) problems.push(`APPROVAL_GATES has ${id}: name its source file`);
    }
    const awaiting = { status: "awaiting_approval", approval_id: "apr_x", summary: "x" };
    expect(awaitingApprovalOutput.safeParse(awaiting).success).toBe(true);
    for (const op of operations()) {
      const canAwait = world.engine.registry.outputSchema(op.id).safeParse(awaiting).success;
      if (canAwait && !APPROVAL_GATES[op.id]) {
        problems.push(`${op.id} can answer awaiting_approval: add it to APPROVAL_GATES`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("knows every operation that can send or change what a person approved", () => {
    const ids = new Set(operations().map((op) => op.id));
    const sends = operations()
      .filter((op) => operationScopes(op).includes("send"))
      .map((op) => op.id);
    const problems: string[] = [];
    for (const id of new Set([...sends, ...EDITS_APPROVED])) {
      const why = sends.includes(id) ? "needs the send scope" : "changes what a person approved";
      if (!APPROVAL_GATES[id] && !NOT_A_GATE[id]) {
        problems.push(
          `${id} ${why}: make it ask (mustRequestApproval) and add it to APPROVAL_GATES with a fixture, or list it in NOT_A_GATE with the reason it never needs to`,
        );
      }
      if (APPROVAL_GATES[id] && NOT_A_GATE[id]) {
        problems.push(`${id} is in APPROVAL_GATES and NOT_A_GATE: keep one`);
      }
    }
    for (const id of [...EDITS_APPROVED, ...Object.keys(NOT_A_GATE)]) {
      if (!ids.has(id)) problems.push(`${id} is listed but is not an operation`);
    }
    for (const id of Object.keys(NOT_A_GATE)) {
      if (!sends.includes(id) && !EDITS_APPROVED.includes(id)) {
        problems.push(
          `NOT_A_GATE has ${id}, which neither sends nor changes what a person approved`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});

type Case = "scope" | "workspace" | "dry_run";

/** The engine's own answer to a dry run, the reference for every other door. */
const engineDryRuns = new Map<string, string>();

async function engineDryRun(op: AnyOperation, input: Record<string, unknown>): Promise<string> {
  let answer = engineDryRuns.get(op.id);
  if (answer === undefined) {
    const dryRun = {
      ...(op.workspace === "none" ? {} : { workspace: world.a.slug }),
      dryRun: true,
    };
    answer = summarize(await call("engine", world.owner, op, input, dryRun));
    engineDryRuns.set(op.id, answer);
  }
  return answer;
}

async function check(door: Door, testCase: Case, op: AnyOperation): Promise<string | null> {
  const input = inputFor(op);
  if (!input) return `${op.id}: no input`;
  // Instance-level operations take no workspace (the CLI has no --workspace for them).
  const naming = (workspace: string): Common => (op.workspace === "none" ? {} : { workspace });
  let expected: string;
  let answer: Answer;
  if (testCase === "scope") {
    const scope = operationScopes(op)[0] as Scope;
    expected = `forbidden missing_scope=${scope}`;
    answer = await call(door, world.lacking[scope], op, input, naming(world.a.slug));
  } else if (testCase === "workspace") {
    expected =
      op.workspace !== "none"
        ? "forbidden reason=workspace_scope"
        : op.boundPrincipals === "allow"
          ? "ok"
          : "forbidden reason=instance_only";
    answer = await call(door, world.agent, op, input, naming(world.b.slug));
  } else {
    expected =
      op.effect !== "read" && op.dryRun === "none"
        ? "unsupported reason=no_dry_run"
        : await engineDryRun(op, input);
    answer = await call(door, world.owner, op, input, { ...naming(world.a.slug), dryRun: true });
  }
  const got = summarize(answer);
  return got === expected ? null : `${op.id}: expected ${expected}, got ${got}`;
}

const CASES: Array<[Case, string]> = [
  ["scope", "a key without one of the operation's scopes gets forbidden naming it"],
  ["workspace", "a key bound to one workspace cannot reach another"],
  ["dry_run", "dry_run gets the engine's answer"],
];

for (const door of DOORS) {
  describe(`door ${door}`, () => {
    for (const [testCase, title] of CASES) {
      it(`${testCase}: ${title}`, { timeout: 240_000 }, async () => {
        const mismatches: string[] = [];
        for (const op of operations()) {
          if (notExposed(door, op)) continue;
          const mismatch = await check(door, testCase, op);
          if (mismatch) mismatches.push(mismatch);
        }
        expect(mismatches).toEqual([]);
      });
    }
  });
}

describe("dry runs", () => {
  it("never apply: an operation with a preview answers a dry run or an error", async () => {
    const applied: string[] = [];
    for (const op of operations()) {
      if (op.effect === "read" || op.dryRun === "none" || DRY_RUN_PLAIN_ANSWERS[op.id]) continue;
      const input = inputFor(op);
      if (!input) continue;
      const answer = await engineDryRun(op, input);
      if (answer === "ok" || answer === "awaiting_approval") applied.push(`${op.id}: ${answer}`);
    }
    expect(applied).toEqual([]);
  });
});

/** An id like `id` (same prefix) that names another row. */
function otherId(id: string): string {
  const prefix = id.includes("_") ? id.slice(0, id.indexOf("_")) : "id";
  const other = `${prefix}_01k6a3v0q8x3m2n4p5r6s7t8v9`;
  return other === id ? `${prefix}_01k6a3v0q8x3m2n4p5r6s7t8va` : other;
}

/** Edits that point the approval at another target: the payload field holding its target. */
async function retargetEdits(approvalId: string): Promise<Record<string, unknown>> {
  const [row] = await world.engine.db
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.id, approvalId));
  const target = String(row?.target_id ?? "");
  const field =
    Object.entries(row?.payload ?? {}).find(([, value]) => value === target)?.[0] ?? "target_id";
  return { [field]: otherId(target) };
}

describe("approval gates", () => {
  it("ask an agent for approval on every door, and the agent cannot decide its own request", {
    timeout: 240_000,
  }, async () => {
    const decide = world.engine.registry.operation("approvals.decide");
    if (!decide) throw new Error("approvals.decide is missing");
    const mismatches: string[] = [];
    let attempt = 0;
    for (const [id, fixture] of Object.entries(APPROVAL_GATES)) {
      const op = world.engine.registry.operation(id);
      if (!op) {
        mismatches.push(`${id}: not an operation`);
        continue;
      }
      for (const door of DOORS) {
        const reason = notExposed(door, op) ?? notExposed(door, decide);
        if (reason) {
          skipped.set(`${door} ${id} (gate)`, reason);
          continue;
        }
        attempt += 1;
        const common = {
          workspace: world.a.slug,
          ...(fixture.reason ? { reason: fixture.reason } : {}),
        };
        const answer = await call(door, world.agent, op, fixture.input(world, attempt), common);
        const got = summarize(answer);
        if (!answer.ok || got !== "awaiting_approval") {
          mismatches.push(`${door} ${id}: expected awaiting_approval, got ${got}`);
          continue;
        }
        const approvalId = String(answer.value.approval_id);
        const decided = await call(
          door,
          world.agent,
          decide,
          { approval_id: approvalId, decision: "approve" },
          { workspace: world.a.slug },
        );
        const result = decided.ok
          ? asRecord((decided.value.results as unknown[] | undefined)?.[0] ?? {})
          : {};
        const refusal = asRecord(result.error ?? {}).code;
        if (refusal !== "forbidden" || result.status !== "pending") {
          mismatches.push(
            `${door} ${id}: the agent deciding its own request got ${decided.ok ? JSON.stringify(result) : summarize(decided)}`,
          );
        }
        // Not even a person can point the request at another target with an edit.
        const edits = await retargetEdits(approvalId);
        const edited = await call(
          door,
          world.owner,
          decide,
          { approval_id: approvalId, decision: "edit", edits },
          { workspace: world.a.slug },
        );
        const editResult = edited.ok
          ? asRecord((edited.value.results as unknown[] | undefined)?.[0] ?? {})
          : {};
        if (
          asRecord(editResult.error ?? {}).code !== "validation_failed" ||
          editResult.status !== "pending"
        ) {
          mismatches.push(
            `${door} ${id}: a person's edit ${JSON.stringify(edits)} got ${edited.ok ? JSON.stringify(editResult) : summarize(edited)}`,
          );
        }
        // A person rejects it, so the next door starts from the same state.
        await world.engine.call(
          "approvals.decide",
          { approval_id: approvalId, decision: "reject" },
          { workspace: world.a.slug },
        );

        // The same request from a key the agent created: the agent cannot decide it either.
        attempt += 1;
        const minted = await call(door, world.minted, op, fixture.input(world, attempt), common);
        if (!minted.ok || summarize(minted) !== "awaiting_approval") {
          mismatches.push(
            `${door} ${id}: the minted key expected awaiting_approval, got ${summarize(minted)}`,
          );
          continue;
        }
        const mintedId = String(minted.value.approval_id);
        const lent = await call(
          door,
          world.agent,
          decide,
          { approval_id: mintedId, decision: "approve" },
          { workspace: world.a.slug },
        );
        const lentResult = lent.ok
          ? asRecord((lent.value.results as unknown[] | undefined)?.[0] ?? {})
          : {};
        if (
          asRecord(lentResult.error ?? {}).code !== "forbidden" ||
          lentResult.status !== "pending"
        ) {
          mismatches.push(
            `${door} ${id}: the agent deciding its own key's request got ${lent.ok ? JSON.stringify(lentResult) : summarize(lent)}`,
          );
        }
        await world.engine.call(
          "approvals.decide",
          { approval_id: mintedId, decision: "reject" },
          { workspace: world.a.slug },
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});
