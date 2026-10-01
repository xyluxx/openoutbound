import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { palette } from "./io.js";
import { renderHuman } from "./output.js";

const plain = palette(false);

const pending = {
  email_replies: 2,
  linkedin_accepts: 1,
  linkedin_replies: 0,
  meeting_bookings: 0,
  meeting_no_shows: 0,
};
const nothing = {
  email_replies: 0,
  linkedin_accepts: 0,
  linkedin_replies: 0,
  meeting_bookings: 0,
  meeting_no_shows: 0,
};
const counts = {
  companies: 40,
  people: 120,
  lists: 2,
  list_members: 30,
  icps: 1,
  knowledge_items: 12,
  offers: 1,
  signals: 9,
  campaigns: 1,
  campaign_steps: 3,
  mailboxes: 2,
  linkedin_accounts: 1,
  threads: 3,
  messages: 6,
  suppressions: 1,
};

describe("renderHuman: hand-made layouts", () => {
  it("sandbox status shows counts and what will arrive without --json", () => {
    const out = renderHuman(
      {
        workspaces: [
          {
            workspace_id: "ws_1",
            slug: "northwind",
            name: "Northwind Analytics",
            counts,
            quick_start_prompts: ["Show me the operating state."],
            pending_simulated_replies: pending,
          },
        ],
        try_first: ["find_leads - search the sandbox world"],
      },
      plain,
      { command: "sandbox status", operationId: "sandbox.status" },
    );
    expect(out.stdout).toContain("Northwind Analytics  slug northwind");
    expect(out.stdout).toContain("40 companies, 120 people");
    expect(out.stdout).toContain("Waiting to arrive: 2 email replies, 1 LinkedIn acceptance");
    expect(out.stdout).toContain("Show me the operating state.");
    expect(out.stdout).toContain("find_leads - search the sandbox world");
    expect(out.hints.join("\n")).toContain("`openoutbound sandbox simulate --workspace northwind`");
  });

  it("sandbox status says how to create the sandbox when there is none", () => {
    const out = renderHuman({ workspaces: [], try_first: [] }, plain, {
      command: "sandbox status",
      operationId: "sandbox.status",
    });
    expect(out.stdout).toContain("No sandbox workspace yet.");
    expect(out.hints.join("\n")).toContain("`openoutbound sandbox`");
  });

  it("sandbox simulate says what arrived and what was sent, in the command the person runs", () => {
    const out = renderHuman(
      {
        workspace: "northwind",
        pending_before: pending,
        delivered: pending,
        outbox: { emails_sent: 3, linkedin_sent: 1, waiting: 2 },
      },
      plain,
      { command: "sandbox simulate", operationId: "sandbox.simulate", prefix: "pnpm openoutbound" },
    );
    expect(out.stdout).toContain("Delivered now: 2 email replies, 1 LinkedIn acceptance.");
    expect(out.stdout).toContain(
      "Sent so far, to the simulator (never to a real person): 3 emails, 1 LinkedIn action.",
    );
    expect(out.stdout).toContain("2 messages wait for their send window.");
    expect(out.hints.join("\n")).toContain(
      "`pnpm openoutbound messages list --workspace northwind --status sent`",
    );
    const quiet = renderHuman(
      {
        workspace: "northwind",
        pending_before: nothing,
        delivered: nothing,
        outbox: { emails_sent: 0, linkedin_sent: 0, waiting: 0 },
      },
      plain,
      { command: "sandbox simulate", operationId: "sandbox.simulate" },
    );
    expect(quiet.stdout).toContain("Nothing was waiting to arrive.");
    expect(quiet.stdout).toContain("Nothing sent yet.");
  });

  it("readiness lists blockers with their fixes, and a sandbox once", () => {
    const real = renderHuman(
      {
        workspace: "acme",
        sandbox: false,
        summary: "Nothing can reach a real person yet.",
        email: {
          ready: false,
          blockers: [
            {
              id: "no_mailbox",
              label: "Mailbox",
              detail: "No real mailbox is connected.",
              fix: "`openoutbound mailboxes add --workspace acme --email <address>`",
            },
          ],
          warnings: [],
        },
        linkedin: { ready: true, blockers: [], warnings: [] },
        review: { level: "first", summary: "A person approves the first message." },
      },
      plain,
      {
        command: "workspaces readiness",
        operationId: "workspaces.readiness",
        prefix: "node dist/cli/main.js",
      },
    );
    expect(real.stdout).toContain("Nothing can reach a real person yet.");
    expect(real.stdout).toContain("Email: not ready");
    expect(real.stdout).toContain("Mailbox: No real mailbox is connected.");
    expect(real.stdout).toContain(
      "Fix: `node dist/cli/main.js mailboxes add --workspace acme --email <address>`",
    );
    expect(real.stdout).toContain("LinkedIn: ready");
    expect(real.stdout).toContain("Review (first): A person approves the first message.");

    const sandboxBlocker = {
      id: "sandbox",
      label: "Sandbox",
      detail: "This is a sandbox workspace.",
      fix: "`openoutbound workspaces create --name <company name>` creates a real workspace.",
    };
    const sandbox = renderHuman(
      {
        workspace: "northwind",
        sandbox: true,
        summary: "Sandbox workspace: nothing it does ever reaches a real person.",
        email: { ready: false, blockers: [sandboxBlocker], warnings: [] },
        linkedin: { ready: false, blockers: [sandboxBlocker], warnings: [] },
        review: { level: "first", summary: "A person approves the first message." },
      },
      plain,
      { command: "workspaces readiness", operationId: "workspaces.readiness" },
    );
    expect(sandbox.stdout).toContain("Sandbox workspace: nothing it does ever reaches");
    expect(sandbox.stdout.match(/creates a real workspace/g)).toHaveLength(1);
  });

  it("readiness says when replies still go out while campaign email is blocked", () => {
    const replies =
      "Replies to people who wrote to you go out once a person approves them (mailboxes that can send: sam@acme.example.com).";
    const out = renderHuman(
      {
        workspace: "acme",
        sandbox: false,
        summary: "No campaign message can reach a real person yet.",
        email: {
          ready: false,
          replies_ready: true,
          replies,
          blockers: [
            {
              id: "base_url",
              label: "Public https address",
              detail: "OPENOUTBOUND_BASE_URL is http://localhost:7331.",
              fix: "Set OPENOUTBOUND_BASE_URL.",
            },
          ],
          warnings: [],
        },
        linkedin: {
          ready: false,
          replies_ready: false,
          replies: "Replies cannot go out either: No LinkedIn account is connected.",
          blockers: [
            {
              id: "no_linkedin_account",
              label: "LinkedIn account connected",
              detail: "No LinkedIn account is connected.",
              fix: "Connect one.",
            },
          ],
          warnings: [],
        },
        review: { level: "first", summary: "A person approves the first message." },
      },
      plain,
      { command: "workspaces readiness", operationId: "workspaces.readiness" },
    );
    const lines = out.stdout.split("\n");
    const email = lines.indexOf("Email: not ready (replies go out)");
    expect(email).toBeGreaterThan(0);
    expect(lines[email + 1]).toBe(`  Replies  ${replies}`);
    // A channel whose replies are stopped too says so through its blockers only.
    expect(out.stdout).toContain("LinkedIn: not ready\n");
    expect(out.stdout.match(/Replies cannot go out/g)).toBeNull();
  });

  it("a launch preview lists failing checks apart from warnings, in the command the person runs", () => {
    const fail = {
      key: "unsubscribe_link",
      label: "Unsubscribe link",
      status: "fail",
      detail: "OPENOUTBOUND_BASE_URL (http://localhost:7331) is not a public https address.",
      fix: "Set OPENOUTBOUND_BASE_URL in the engine's .env, then restart `openoutbound serve`.",
    };
    const warn = {
      key: "postal_address",
      label: "Postal address in the footer",
      status: "warn",
      detail: "No postal address is set.",
      fix: "Ask the human to change settings.company.postal_address (openoutbound workspaces update).",
    };
    const pass = { key: "steps", label: "Steps", status: "pass", detail: "3 valid steps." };
    const out = renderHuman(
      {
        dry_run: true,
        preview: {
          campaign_id: "cmp_1",
          ready: false,
          items: [pass, fail, warn],
          estimates: { queued: 4, in_progress: 0 },
        },
        warnings: [
          `${fail.label}: ${fail.detail} Fix: ${fail.fix}`,
          `${warn.label}: ${warn.detail} Fix: ${warn.fix}`,
        ],
        estimated_cost: { usd: 0.5, note: "Rough AI cost per day." },
      },
      plain,
      {
        command: "campaigns launch",
        operationId: "campaigns.launch",
        dryRunMode: "supported",
        prefix: "node dist/cli/main.js",
      },
    );
    const lines = out.stdout.split("\n");
    expect(lines).toContain("Not ready: the launch fails until each FAIL below is fixed.");
    const failAt = lines.indexOf(`FAIL  ${fail.label}: ${fail.detail}`);
    expect(failAt).toBeGreaterThan(0);
    expect(lines[failAt + 1]).toBe(
      "      Fix: Set OPENOUTBOUND_BASE_URL in the engine's .env, then restart `node dist/cli/main.js serve`.",
    );
    const warnAt = lines.indexOf(`WARN  ${warn.label}: ${warn.detail}`);
    expect(warnAt).toBeGreaterThan(failAt);
    expect(lines[warnAt + 1]).toBe(
      "      Fix: Ask the human to change settings.company.postal_address (node dist/cli/main.js workspaces update).",
    );
    expect(lines).toContain(`OK    ${pass.label}: ${pass.detail}`);
    // A failing check never shows up as a warning.
    expect(out.stdout).not.toContain("Warnings:");
    expect(out.stdout.match(/Unsubscribe link/g)).toHaveLength(1);
    expect(out.stdout).toContain("Estimated cost: $0.50. Rough AI cost per day.");
    expect(out.stdout).toContain("Dry run: nothing was written, sent or spent.");

    const ready = renderHuman(
      {
        dry_run: true,
        preview: { campaign_id: "cmp_1", ready: true, items: [pass], estimates: {} },
        warnings: [],
      },
      plain,
      { command: "campaigns launch", operationId: "campaigns.launch", dryRunMode: "supported" },
    );
    expect(ready.stdout).toContain("Ready to launch.");
  });

  it("writes dry-run warnings in the command the person runs", () => {
    const out = renderHuman(
      {
        dry_run: true,
        preview: { deleted: 0 },
        warnings: ["Nothing matched; list them with `openoutbound leads search`."],
      },
      plain,
      { command: "leads forget", dryRunMode: "supported", prefix: "pnpm openoutbound" },
    );
    expect(out.stdout).toContain("list them with `pnpm openoutbound leads search`.");
  });

  it("writes hints in the command the person runs", () => {
    const out = renderHuman(
      { status: "awaiting_approval", approval_id: "apr_1", message: "Launch it" },
      plain,
      { command: "campaigns launch", prefix: "node dist/cli/main.js --home /srv/engine" },
    );
    expect(out.hints[0]).toContain("`node dist/cli/main.js --home /srv/engine approvals list`");
  });

  it("a sandbox launch preview costs zero and says what it would cost for real", () => {
    const out = renderHuman(
      {
        dry_run: true,
        preview: { ready: true },
        estimated_cost: {
          usd: 0,
          note: "Sandbox: the fake AI brain costs nothing. With a real AI brain this would cost about $0.72 a day.",
        },
      },
      plain,
      { command: "campaigns launch", dryRunMode: "supported" },
    );
    expect(out.stdout).toContain(
      "Estimated cost: $0.00. Sandbox: the fake AI brain costs nothing. With a real AI brain",
    );
  });

  it("the seed output says what to do next", () => {
    const out = renderHuman(
      {
        workspaces: [
          {
            workspace_id: "ws_1",
            slug: "northwind",
            name: "Northwind Analytics",
            created: true,
            reset: false,
            counts,
            quick_start_prompts: ["Show me the operating state."],
          },
        ],
      },
      plain,
      { command: "sandbox seed", operationId: "sandbox.seed" },
    );
    const hints = out.hints.join("\n");
    expect(hints).toContain("`openoutbound serve`");
    expect(hints).toContain("--workspace northwind");
    // The step numbers follow the page, so renumbering the page breaks this test, not the hint.
    const page = readFileSync(
      fileURLToPath(new URL("../../docs/getting-started/first-hour.md", import.meta.url)),
      "utf8",
    );
    const step = (title: string) => page.match(new RegExp(`^## (\\d+)\\. ${title}`, "m"))?.[1];
    expect(hints).toContain(
      `(docs/getting-started/first-hour.md, steps ${step("Start the server")} and ${step("Connect your agent")}).`,
    );
  });
});
