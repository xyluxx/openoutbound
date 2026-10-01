import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "../../core/engine.js";
import { OpenOutboundError } from "../../core/errors.js";
import { newId } from "../../core/ids.js";
import { messages, people, suppressions } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMessage, seedPerson } from "../../testing/factories.js";
import { registerUnsubscribeRoutes } from "./unsubscribe-routes.js";
import {
  signUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from "./unsubscribe-token.js";

vi.mock("../leads/service.js", async () => (await import("./test-support.js")).fakeLeadsService);

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

function app(context: TestContext): Hono {
  const engine = {
    config: context.config,
    log: context.log,
    systemContext: async (workspaceId: string | null) => {
      if (workspaceId !== context.workspace.id) {
        throw new OpenOutboundError("not_found", `Workspace ${workspaceId} not found.`);
      }
      return context.jobContext();
    },
  } as unknown as Engine;
  const hono = new Hono();
  registerUnsubscribeRoutes(hono, { engine });
  return hono;
}

async function seeded() {
  ctx = await createTestContext();
  const person = await seedPerson(ctx, { email: "dana@harbor.example.com", status: "active" });
  const message = await seedMessage(ctx, {
    person_id: person.id,
    to_address: "dana@harbor.example.com",
    status: "sent",
    sent_at: ctx.clock.now(),
  });
  const token = signUnsubscribeToken(ctx.config, {
    messageId: message.id,
    workspaceId: ctx.workspace.id,
    email: "Dana@Harbor.example.com",
  });
  return { person, message, token };
}

const oneClick = {
  method: "POST",
  body: "List-Unsubscribe=One-Click",
  headers: { "content-type": "application/x-www-form-urlencoded" },
};

describe("unsubscribe token", () => {
  it("round-trips and never expires", async () => {
    ctx = await createTestContext();
    const target = {
      messageId: newId("msg"),
      workspaceId: ctx.workspace.id,
      email: "a@b.example.com",
    };
    const token = signUnsubscribeToken(ctx.config, target);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyUnsubscribeToken(ctx.config, token)).toEqual(target);
    expect(unsubscribeUrl(ctx.config, target)).toBe(`http://localhost:7331/u/${token}`);
  });

  it("rejects tampered, foreign and malformed tokens", async () => {
    ctx = await createTestContext();
    const target = {
      messageId: newId("msg"),
      workspaceId: ctx.workspace.id,
      email: "a@b.example.com",
    };
    const token = signUnsubscribeToken(ctx.config, target);
    const [payload, signature] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ m: target.messageId, w: target.workspaceId, e: "other@b.example.com" }),
    ).toString("base64url");
    expect(verifyUnsubscribeToken(ctx.config, `${forged}.${signature}`)).toBeNull();
    expect(verifyUnsubscribeToken(ctx.config, `${payload}.${signature.slice(1)}x`)).toBeNull();
    expect(verifyUnsubscribeToken(ctx.config, payload)).toBeNull();
    expect(verifyUnsubscribeToken(ctx.config, "")).toBeNull();
    const otherKey = { ...ctx.config, secretKey: Buffer.alloc(32, 9) };
    expect(verifyUnsubscribeToken(otherKey, token)).toBeNull();
  });

  it("keeps links sent before a secret key rotation working while the old key is listed", async () => {
    ctx = await createTestContext();
    const target = {
      messageId: newId("msg"),
      workspaceId: ctx.workspace.id,
      email: "a@b.example.com",
    };
    const sent = signUnsubscribeToken(ctx.config, target);
    const oldKey = ctx.config.secretKey?.toString("base64") ?? "";
    const rotated = {
      ...ctx.config,
      secretKey: Buffer.alloc(32, 8),
      env: {
        ...ctx.config.env,
        OPENOUTBOUND_SECRET_KEY_VERSION: "2",
        OPENOUTBOUND_PREVIOUS_SECRET_KEYS: `1:${oldKey}`,
      },
    };
    expect(verifyUnsubscribeToken(rotated, sent)).toEqual(target);
    const fresh = signUnsubscribeToken(rotated, target);
    expect(fresh).not.toBe(sent);
    expect(verifyUnsubscribeToken(rotated, fresh)).toEqual(target);
    const forgotten = {
      ...rotated,
      env: { ...rotated.env, OPENOUTBOUND_PREVIOUS_SECRET_KEYS: "" },
    };
    expect(verifyUnsubscribeToken(forgotten, sent)).toBeNull();
  });
});

describe("unsubscribe routes", () => {
  it("GET shows a confirmation page and changes nothing", async () => {
    const { token } = await seeded();
    const response = await app(ctx).request(`/u/${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toContain('<form method="post">');
    expect(html).toContain("d***@harbor.example.com");
    expect(html).not.toContain("dana@harbor.example.com");
    expect(await ctx.db.select().from(suppressions)).toHaveLength(0);
    expect(ctx.emitted("unsubscribe.received")).toHaveLength(0);
  });

  it("POST one-click suppresses the address and the person, once", async () => {
    const { person, message, token } = await seeded();
    const first = await app(ctx).request(`/u/${token}`, oneClick);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("You are unsubscribed");
    const [row] = await ctx.db.select().from(suppressions);
    expect(row).toMatchObject({
      type: "email",
      value: "dana@harbor.example.com",
      reason: "unsubscribed",
      source: "unsubscribe_link",
    });
    const [updated] = await ctx.db.select().from(people).where(eq(people.id, person.id));
    expect(updated?.status).toBe("unsubscribed");
    expect(ctx.emitted("unsubscribe.received").map((event) => event.data)).toEqual([
      {
        person_id: person.id,
        email: "dana@harbor.example.com",
        source: "one_click",
        message_id: message.id,
      },
    ]);

    const again = await app(ctx).request(`/u/${token}`, oneClick);
    expect(again.status).toBe(200);
    expect(ctx.emitted("unsubscribe.received")).toHaveLength(1);
    expect(await ctx.db.select().from(suppressions)).toHaveLength(1);
  });

  it("POST from the page button is recorded as a link unsubscribe", async () => {
    const { token } = await seeded();
    const response = await app(ctx).request(`/u/${token}`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(ctx.emitted("unsubscribe.received")[0]?.data.source).toBe("link");
  });

  it("still works after the message was deleted", async () => {
    const { person, message, token } = await seeded();
    await ctx.db.delete(messages).where(eq(messages.id, message.id));
    const response = await app(ctx).request(`/u/${token}`, oneClick);
    expect(response.status).toBe(200);
    expect(await ctx.db.select().from(suppressions)).toHaveLength(1);
    expect(ctx.emitted("unsubscribe.received")[0]?.data).toMatchObject({
      person_id: person.id,
      email: "dana@harbor.example.com",
      message_id: null,
    });
  });

  it("answers 200 when the workspace is gone and 404 for invalid tokens", async () => {
    ctx = await createTestContext();
    const token = signUnsubscribeToken(ctx.config, {
      messageId: newId("msg"),
      workspaceId: newId("ws"),
      email: "gone@example.org",
    });
    expect((await app(ctx).request(`/u/${token}`, oneClick)).status).toBe(200);
    expect((await app(ctx).request("/u/not-a-token", oneClick)).status).toBe(404);
    expect((await app(ctx).request("/u/not-a-token")).status).toBe(404);
  });
});
