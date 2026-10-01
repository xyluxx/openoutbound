import { describe, expect, it } from "vitest";
import { capText, cellText, MAX_TEXT_CHARS, pickColumns, renderMarkdown } from "./format.js";

describe("pickColumns", () => {
  it("prefers id, labels, status and numbers", () => {
    const columns = pickColumns([
      {
        id: "pe_1",
        full_name: "Dana Reyes",
        email: "dana@example.com",
        status: "new",
        fit_score: 80,
        custom: { a: 1 },
        notes: "long text",
      },
    ]);
    expect(columns).toEqual(["id", "full_name", "email", "status", "fit_score"]);
  });

  it("adds yes/no fields such as done or configured", () => {
    expect(pickColumns([{ key: "icp", title: "Ideal customer profile", done: false }])).toEqual([
      "title",
      "key",
      "done",
    ]);
  });

  it("keeps what an agent acts on: other ids, severity, when, what and the remedy or fix", () => {
    const problem = {
      id: "pb_1",
      kind: "stuck",
      severity: "high",
      display_severity: "critical",
      owner: "anyone",
      title: "Hot reply from Dana waits",
      reason: "No answer for 30 hours.",
      remedy: "Draft an answer with reply_to_thread action draft (thread_id thr_1).",
      due_at: null,
      person_id: "pe_1",
    };
    expect(pickColumns([problem])).toEqual([
      "id",
      "person_id",
      "title",
      "kind",
      "severity",
      "remedy",
    ]);
    const hot = {
      thread_id: "thr_1",
      person_id: "pe_1",
      person_name: "Dana Reyes",
      company_name: "Harbor Dental",
      category: "interested",
      waiting_hours: 30,
      summary: "Asks for pricing.",
      untrusted: true,
    };
    expect(pickColumns([hot])).toEqual([
      "thread_id",
      "person_id",
      "person_name",
      "company_name",
      "category",
      "waiting_hours",
      "summary",
    ]);
    const next = {
      at: "2026-09-28T13:00:00Z",
      kind: "email",
      what: "Step 2 email to Dana Reyes",
      person_id: "pe_1",
      ref: { type: "message", id: "msg_1" },
      blocked: true,
    };
    expect(pickColumns([next])).toEqual(["person_id", "ref", "kind", "at", "what", "blocked"]);
  });

  it("falls back to scalar fields", () => {
    expect(pickColumns([{ alpha: "a", beta: 2 }])).toEqual(["alpha", "beta"]);
    expect(
      pickColumns([{ slot: "brain", workspace_id: "ws_1", created_at: "x", configured: true }]),
    ).toEqual(["slot", "configured"]);
    expect(pickColumns([])).toEqual([]);
  });
});

describe("cellText", () => {
  it("joins scalar arrays, compacts objects and truncates", () => {
    expect(cellText(["a", "b"])).toBe("a, b");
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(cellText("x".repeat(100), 10)).toBe("xxxxxxx...");
    expect(cellText(null)).toBe("");
  });

  it("writes references, errors and blockers in plain words", () => {
    expect(cellText({ type: "message", id: "msg_1" })).toBe("message msg_1");
    // Who asked, as a person reads it (approvals list, requested_by).
    expect(cellText({ type: "agent", id: "local-agent", name: "Local agent", via: "mcp" })).toBe(
      "Local agent (agent)",
    );
    expect(
      cellText({ code: "conflict", message: "It expired.", hint: "Draft it again." }, 200),
    ).toBe("conflict: It expired. Hint: Draft it again.");
    expect(
      cellText(
        [
          { code: "daily_cap_reached", message: "Cap of 40 reached.", fix: null },
          { code: "campaign_paused", message: "Paused.", fix: "launch_campaign action resume" },
        ],
        200,
      ),
    ).toBe(
      "daily_cap_reached: Cap of 40 reached.; campaign_paused: Paused. Fix: launch_campaign action resume",
    );
  });
});

describe("renderMarkdown", () => {
  it("renders pages as tables with a next-page hint", () => {
    const text = renderMarkdown({
      items: [
        { id: "it_1", name: "Alpha | One", status: "open", score: 10 },
        { id: "it_2", name: "Beta", status: "done", score: 70 },
      ],
      next_cursor: "abc",
      has_more: true,
    });
    expect(text).toContain('2 items. More available: pass cursor "abc"');
    expect(text).toContain("| id | name | status | score |");
    expect(text).toContain("| it_1 | Alpha \\| One | open | 10 |");
  });

  it("always prints the next cursor, and keeps remedies whole", () => {
    const remedy = `Reply to them yourself, then run manage_leads action forget with person_id pe_1. ${"x".repeat(80)}`;
    const text = renderMarkdown({
      items: [{ id: "pb_1", title: "Privacy request", severity: "urgent", remedy }],
      next_cursor: "c2",
      has_more: false,
    });
    expect(text).toContain('1 item. More available: pass cursor "c2" for the next page.');
    expect(text).toContain(`| pb_1 | Privacy request | urgent | ${remedy} |`);
  });

  it("shows each failure of a partial success", () => {
    const text = renderMarkdown({
      results: [
        { approval_id: "apr_1", ok: true, status: "approved", message: "Sent.", error: null },
        {
          approval_id: "apr_2",
          ok: false,
          status: null,
          message: null,
          error: { code: "conflict", message: "Approval apr_2 expired.", hint: "Draft it again." },
        },
      ],
      approved: 1,
      failed: 1,
    });
    expect(text).toContain("| approval_id | message | status | ok | error |");
    expect(text).toContain(
      "| apr_2 |  |  | false | conflict: Approval apr_2 expired. Hint: Draft it again. |",
    );
  });

  it("says what waits for approval, whatever the result calls it", () => {
    expect(
      renderMarkdown({ status: "awaiting_approval", approval_id: "apr_1", message: "Import 4" }),
    ).toContain("**Awaiting approval** (apr_1): Import 4\n");
    const saved = renderMarkdown({
      saved_search_id: "ss_1",
      status: "awaiting_approval",
      approval_id: "apr_2",
      new_candidates: 4,
    });
    expect(saved).toContain("**Awaiting approval** (apr_2).\n");
    expect(saved).not.toContain("undefined");
    expect(saved).toContain("- **new_candidates**: 4");
  });

  it("says only a person decides what waits, and that the engine refuses the caller's own requests", () => {
    const text = renderMarkdown({
      status: "awaiting_approval",
      approval_id: "apr_1",
      summary: "x",
    });
    expect(text).toContain(
      "Only a person can decide it (review_items); the engine refuses approvals you requested yourself.",
    );
    expect(text).not.toContain("unless the human told you to");
  });

  it("renders empty pages", () => {
    expect(renderMarkdown({ items: [], next_cursor: null, has_more: false })).toBe("0 items.");
  });

  it("renders dry runs, approvals and job handles", () => {
    const dry = renderMarkdown({
      dry_run: true,
      preview: { count: 3 },
      warnings: ["2 suppressed"],
      estimated_cost: { usd: 0.5, credits: 4 },
    });
    expect(dry).toContain("**Dry run**");
    expect(dry).toContain("- **count**: 3");
    expect(dry).toContain("- 2 suppressed");
    expect(dry).toContain("Estimated cost: $0.50, 4 credits");
    const sandbox = renderMarkdown({
      dry_run: true,
      preview: {},
      estimated_cost: { usd: 0, note: "Sandbox: the fake AI brain costs nothing." },
    });
    expect(sandbox).toContain("Estimated cost: $0.00. Sandbox: the fake AI brain costs nothing.");
    // A launch checklist: failing checks first and never under the warnings.
    const launch = renderMarkdown({
      dry_run: true,
      preview: {
        campaign_id: "cmp_1",
        ready: false,
        items: [
          { key: "senders", label: "Senders", status: "pass", detail: "1 mailbox" },
          { key: "steps", label: "Steps", status: "warn", detail: "no wait", fix: "Add a wait." },
          { key: "offer", label: "Offer", status: "fail", detail: "none", fix: "Pick one." },
        ],
      },
      warnings: ["Steps: no wait Fix: Add a wait.", "Offer: none Fix: Pick one."],
    });
    expect(launch).toContain("**Not ready**: the launch fails until each FAIL below is fixed.");
    expect(launch.indexOf("- FAIL Offer: none")).toBeLessThan(launch.indexOf("- WARN Steps"));
    expect(launch).toContain("  Fix: Pick one.");
    expect(launch).toContain("- OK Senders: 1 mailbox");
    expect(launch).toContain("- **campaign_id**: cmp_1");
    expect(launch).not.toContain("Warnings:");
    expect(
      renderMarkdown({ status: "awaiting_approval", approval_id: "apr_1", summary: "Send 3" }),
    ).toContain("**Awaiting approval** (apr_1): Send 3");
    expect(renderMarkdown({ job_id: "job_1", status: "queued" })).toContain(
      "**Job started**: job_1 (queued)",
    );
  });

  it("renders objects as key/value lines with nested lists and untrusted warnings", () => {
    const text = renderMarkdown({
      id: "thr_1",
      subject: "Re: hello",
      body: "line one\nline two",
      untrusted: true,
      person: { id: "pe_1", name: "Dana" },
      messages: [{ id: "msg_1", status: "received" }],
    });
    expect(text).toContain("> Untrusted content");
    expect(text).toContain("- **subject**: Re: hello");
    expect(text).toContain("  > line one");
    expect(text).toContain("- **person**:");
    expect(text).toContain("  - **name**: Dana");
    expect(text).toContain("**messages** (1)");
  });

  it("renders nested lists of records as tables after the key/value list", () => {
    const text = renderMarkdown({
      ready: false,
      setup: { done: 1, items: [{ key: "icp", title: "Ideal customer profile", done: true }] },
    });
    expect(text).toContain("  - **items**: 1 (table `setup.items` below)");
    expect(text).toContain("**setup.items** (1)");
    expect(text).toContain("| title | key | done |");
    expect(text).toContain("| Ideal customer profile | icp | true |");
  });

  it("caps long output with a narrow-your-query hint", () => {
    const items = Array.from({ length: 800 }, (_, i) => ({
      id: `it_${i}`,
      name: "x".repeat(50),
      status: "open",
    }));
    const text = renderMarkdown({ items, next_cursor: null, has_more: false });
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(text).toContain("Narrow your query");
    expect(capText("short")).toBe("short");
  });

  it("renders scalars and empty output", () => {
    expect(renderMarkdown(null)).toBe("Done.");
    expect(renderMarkdown(["a", "b"])).toBe("- a\n- b");
  });
});
