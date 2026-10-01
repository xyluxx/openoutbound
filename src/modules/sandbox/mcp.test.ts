/**
 * What the sandbox tells agents must be callable over MCP: every `try_first` entry of
 * sandbox.status names a registered tool (and action), and the local agent (default scopes, no
 * admin) can fast-forward simulated replies with manage_sandbox action simulate.
 */
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messages } from "../../db/schema/index.js";
import { serveEmbeddedStdio } from "../../mcp/stdio.js";
import { decideEmailOutcome } from "../../sandbox/simulator/decide.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import { seedMailbox, seedMessage, seedPerson, seedThread } from "../../testing/factories.js";
import { modules } from "../index.js";

let engine: TestEngine;
/** Id of the send that seedAnsweredSend adds. */
let answeredSend = "";

/**
 * A sent first-touch email in northwind that the prospect simulator answers with a reply.
 * Returns its message id.
 */
async function seedAnsweredSend(): Promise<string> {
  const workspaces = (await engine.call("workspaces.list", {})) as {
    items: Array<{ id: string; slug: string }>;
  };
  const northwind = workspaces.items.find((workspace) => workspace.slug === "northwind");
  if (!northwind) throw new Error("northwind was not seeded");
  const personId = "pe_mcp_simulate";
  let messageId = "";
  for (let i = 0; i < 20_000 && !messageId; i++) {
    const candidate = `msg_mcp_simulate_${i}`;
    const outcome = decideEmailOutcome({ personId, messageId: candidate, emailStatus: "valid" });
    if (outcome.kind === "reply") messageId = candidate;
  }
  const target = { db: engine.db, workspace: { id: northwind.id } };
  const thread = await seedThread(target);
  const mailbox = await seedMailbox(target);
  const person = await seedPerson(target, { id: personId, email_status: "valid" });
  await seedMessage(target, {
    id: messageId,
    thread_id: thread.id,
    mailbox_id: mailbox.id,
    person_id: person.id,
    status: "sent",
  });
  return messageId;
}

beforeAll(async () => {
  engine = await createTestEngine();
  await engine.call("sandbox.seed", {});
  answeredSend = await seedAnsweredSend();
});

afterAll(async () => {
  await engine?.close();
});

describe("sandbox pointers for MCP agents", () => {
  it("names only MCP tools and actions that exist in try_first", async () => {
    const status = (await engine.call("sandbox.status", {})) as { try_first: string[] };
    const tools = new Map(
      modules.flatMap((module) => module.tools ?? []).map((tool) => [tool.name, tool]),
    );
    expect(status.try_first.length).toBeGreaterThan(0);
    for (const hint of status.try_first) {
      const match = /^([a-z_]+)(?: action ([a-z_]+))? - /.exec(hint);
      expect(match, hint).not.toBeNull();
      const [, name = "", action] = match ?? [];
      const tool = tools.get(name);
      expect(tool, `${hint}: no MCP tool named ${name}`).toBeDefined();
      if (action) expect(Object.keys(tool?.actions ?? {}), hint).toContain(action);
    }
  });

  it("lets the local agent fast-forward simulated replies with manage_sandbox action simulate", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = await serveEmbeddedStdio(engine, {
      toolsets: "core,admin",
      defaultWorkspace: "northwind",
      transport: serverSide,
    });
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      const result = (await client.callTool({
        name: "manage_sandbox",
        arguments: { action: "simulate", reason: "show a reply in the demo" },
      })) as {
        isError?: boolean;
        content: Array<{ text?: string }>;
        structuredContent?: unknown;
      };
      expect(result.isError, result.content.map((block) => block.text).join("\n")).toBeFalsy();
      // The seeded world has one unanswered send of its own. Whether the simulator answers it
      // depends on the ids it got when it was seeded, so only ours is sure to be answered; what
      // was pending is exactly what arrives.
      const { pending_before, delivered } = result.structuredContent as {
        pending_before: { email_replies: number };
        delivered: { email_replies: number };
      };
      expect(pending_before.email_replies).toBeGreaterThanOrEqual(1);
      expect(pending_before.email_replies).toBeLessThanOrEqual(2);
      expect(delivered.email_replies).toBe(pending_before.email_replies);
      // The simulated reply carries the id of the message it answers in its Message-ID.
      const replies = await engine.db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.direction, "inbound"),
            like(messages.message_id_header, `<sbx_reply_${answeredSend}_%`),
          ),
        );
      expect(replies).toHaveLength(1);
    } finally {
      await client.close();
      await handle.close();
    }
  });
});
