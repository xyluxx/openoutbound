import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_SCOPES } from "../../core/context.js";
import {
  automation_rules,
  icps,
  knowledge_items,
  offers,
  signal_definitions,
  templates,
  workspaces,
} from "../../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import { seedPerson } from "../../testing/factories.js";

interface ExportResult {
  setup: Record<string, unknown> & {
    settings: Record<string, Record<string, unknown>>;
    offers: Array<Record<string, unknown>>;
    automations: Array<Record<string, unknown>>;
    knowledge: Array<Record<string, unknown>>;
    lessons: Array<Record<string, unknown>>;
    signals: { custom: Array<Record<string, unknown>>; builtin_enabled: string[] };
  };
  summary: {
    counts: Record<string, number>;
    settings_sections: string[];
    bytes: number;
    left_out: string[];
    outside_text: boolean;
  };
  path: string | null;
}

interface ImportPlan {
  created: Array<{ type: string; name: string; id: string | null }>;
  skipped: Array<{ type: string; name: string; reason: string }>;
  settings_changed: string[];
  signals_updated: Array<{ key: string; enabled: boolean }>;
  warnings?: string[];
}

interface DryRunResult {
  dry_run: true;
  preview: ImportPlan;
  warnings: string[];
}

const SOURCE = "northwind-example";
const SIGNING_SECRET = "hook-signing-secret-0123456789";

let engine: TestEngine;
let stateDir: string;
let sourceId: string;

const call = (op: string, input: Record<string, unknown>, workspace = SOURCE) =>
  engine.call(op, input, { workspace });

async function workspaceId(slug: string): Promise<string> {
  const [row] = await engine.db.select().from(workspaces).where(eq(workspaces.slug, slug));
  if (!row) throw new Error(`no workspace ${slug}`);
  return row.id;
}

async function exportSetup(input: Record<string, unknown> = {}, workspace = SOURCE) {
  return (await call("workspaces.export_setup", input, workspace)) as ExportResult;
}

async function importInto(slug: string, setup: unknown, dryRun?: boolean) {
  return engine.call(
    "workspaces.import_setup",
    { setup, ...(dryRun === undefined ? {} : { dry_run: dryRun }) },
    { workspace: slug },
  );
}

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "oo-setup-"));
  engine = await createTestEngine({ config: { stateDir } });
  await engine.call("workspaces.create", { name: "Northwind Example" });
  sourceId = await workspaceId(SOURCE);
  await call("workspaces.update", {
    settings: {
      company: { name: "Northwind Example", website: "https://northwind.example.com" },
      booking: { default_url: "https://cal.example.com/northwind", after_no_show: "draft" },
      ai: {
        tone_notes: "Plain and short.",
        fallback_provider: "openai",
        task_models: { fast: { model: "fast-model" } },
      },
      data: { enrichment: { finders: ["hunter"], pattern_guessing: true } },
      approvals: { default_review_level: "every" },
      strategy: { goals: "Ten qualified meetings a month" },
      replies: { interested: { action: "draft_reply" } },
      sandbox: { use_real_brain: true },
    },
  });

  const proof = (await call("knowledge.create", {
    kind: "proof",
    title: "Stockouts down 31%",
    body: "Lumen Home cut stockouts by 31% in the first quarter.",
    source_ref: "https://northwind.example.com/customers/lumen-home",
  })) as { id: string };
  await call("knowledge.create", {
    kind: "rule",
    title: "No ROI promises",
    body: "Never promise specific savings or ROI numbers.",
  });
  // Ingested from the website: outside text.
  await engine.db.insert(knowledge_items).values({
    workspace_id: sourceId,
    kind: "about",
    title: "About Northwind",
    body: "Forecasting tools for mid-size retailers.",
    source_type: "url",
    source_ref: "https://northwind.example.com/about",
  });
  await engine.db.insert(knowledge_items).values({
    workspace_id: sourceId,
    kind: "lesson",
    title: "Short subject lines win",
    body: "Three-word subjects got twice the replies (40 sends each).",
    expires_at: new Date("2026-12-31T00:00:00Z"),
  });
  await call("offers.create", {
    name: "Forecast Pilot",
    summary: "A 30 day forecasting pilot on your own sales data.",
    value_props: ["Fewer stockouts"],
    proof_item_ids: [proof.id],
    cta: "Open to a 20 minute walkthrough?",
    booking_url: "https://cal.example.com/northwind/pilot",
  });
  await call("icps.create", {
    name: "Texas dental practices",
    criteria: { industries: ["dental clinic"], countries: ["US"], regions: ["TX"] },
  });
  await call("signals.definitions.create", {
    key: "new_clinic_location",
    name: "Opened a new clinic location",
    description: "The practice opened an additional clinic location in the last 60 days.",
    collectors: ["website_changes"],
  });
  await call("signals.definitions.update", { key: "news_mention", enabled: false });
  const list = (await call("lists.create", { name: "Hot accounts" })) as { id: string };
  await call("signals.automations.create", {
    name: "Funding alert",
    filters: { definition_keys: ["funding_round"], min_score: 40 },
    actions: [{ type: "notify" }],
  });
  await call("signals.automations.create", {
    name: "Clinic list",
    filters: { definition_keys: ["new_clinic_location"] },
    actions: [{ type: "add_to_list", list_id: list.id }],
  });
  await call("signals.automations.create", {
    name: "Signed hook",
    actions: [{ type: "webhook", url: "https://hooks.example.org/in", secret: SIGNING_SECRET }],
  });
  const campaign = (await call("campaigns.create", {
    name: "Dental Q4",
    template: "signal_based_email_4",
  })) as { id: string };
  await call("campaigns.save_as_template", {
    campaign_id: campaign.id,
    name: "Clinic owners, 4 touches",
  });
  await seedPerson(
    { db: engine.db, workspace: { id: sourceId } },
    { email: "dana.reyes@harbor.example.org" },
  );
});

afterAll(async () => {
  await engine.close();
  await rm(stateDir, { recursive: true, force: true });
});

describe("export_setup", () => {
  it("exports the reusable setup with names instead of ids", async () => {
    const { setup, summary, path } = await exportSetup();
    expect(setup).toMatchObject({ format: "openoutbound.setup", version: 1 });
    expect(path).toBeNull();
    expect(summary.counts).toEqual({
      offers: 1,
      icps: 1,
      knowledge: 3,
      lessons: 0,
      custom_signals: 1,
      builtin_signals_on: expect.any(Number),
      automations: 3,
      campaign_templates: 1,
    });
    expect(summary.outside_text).toBe(true);
    expect(setup.offers[0]).toMatchObject({
      name: "Forecast Pilot",
      proof: [{ kind: "proof", title: "Stockouts down 31%" }],
      booking_url: null,
    });
    expect(setup.signals.builtin_enabled).not.toContain("news_mention");
    expect(setup.automations.map((rule) => rule.name)).toEqual([
      "Funding alert",
      "Clinic list",
      "Signed hook",
    ]);
    expect(setup.automations[1]?.actions).toEqual([{ type: "add_to_list", list: "Hot accounts" }]);
    expect(setup.automations[2]?.actions).toEqual([{ type: "webhook", url: null, signed: true }]);
    expect(setup.settings).toMatchObject({
      ai: { tone_notes: "Plain and short." },
      approvals: { default_review_level: "every" },
      booking: { after_no_show: "draft" },
      data: { enrichment: { pattern_guessing: true } },
    });
    expect(summary.left_out.join(" ")).toContain("company section");
    expect(summary.left_out.join(" ")).toContain("signing secret");
  });

  it("never exports secrets, provider settings, identity, leads or ids", async () => {
    const { setup } = await exportSetup();
    const text = JSON.stringify(setup);
    for (const absent of [
      SIGNING_SECRET,
      "dana.reyes@harbor.example.org",
      "hunter",
      "fallback_provider",
      "task_models",
      "use_real_brain",
      "Northwind Example",
      "cal.example.com",
      "hooks.example.org",
      "secret_id",
      sourceId,
    ]) {
      expect(text).not.toContain(absent);
    }
    expect(text).not.toMatch(/"(off|icp|kn|ls|cmp|rul|tpl|pe)_[0-9a-z]{26}"/);
    expect(setup).not.toHaveProperty("leads");
    expect(setup.settings).not.toHaveProperty("company");
    expect(setup.settings).not.toHaveProperty("sandbox");
  });

  it("keeps identity and lessons on request", async () => {
    const { setup, summary } = await exportSetup({ include_company: true, include_lessons: true });
    expect(setup.settings.company).toMatchObject({ name: "Northwind Example" });
    expect(setup.settings.booking).toMatchObject({
      default_url: "https://cal.example.com/northwind",
    });
    expect(setup.offers[0]?.booking_url).toBe("https://cal.example.com/northwind/pilot");
    expect(setup.automations[2]?.actions).toEqual([
      { type: "webhook", url: "https://hooks.example.org/in", signed: true },
    ]);
    expect(setup.lessons).toEqual([
      expect.objectContaining({
        kind: "lesson",
        title: "Short subject lines win",
        expires_at: "2026-12-31T00:00:00.000Z",
      }),
    ]);
    expect(summary.counts.lessons).toBe(1);
  });
});

describe("import_setup", () => {
  it("plans by default without writing, then imports into an empty workspace", async () => {
    await engine.call("workspaces.create", { name: "Harbor Example" });
    const targetId = await workspaceId("harbor-example");
    const { setup } = await exportSetup({ include_lessons: true });

    const planned = (await importInto("harbor-example", setup)) as DryRunResult;
    expect(planned.dry_run).toBe(true);
    expect(planned.preview.created.map((item) => `${item.type}:${item.name}`)).toEqual([
      "knowledge:Stockouts down 31%",
      "knowledge:No ROI promises",
      "knowledge:About Northwind",
      "lesson:Short subject lines win",
      "offer:Forecast Pilot",
      "icp:Texas dental practices",
      "signal:new_clinic_location",
      "automation:Funding alert",
      "campaign_template:Clinic owners, 4 touches",
    ]);
    expect(planned.preview.created.every((item) => item.id === null)).toBe(true);
    expect(planned.preview.skipped.map((item) => item.name)).toEqual([
      "Clinic list",
      "Signed hook",
    ]);
    expect(planned.preview.skipped[0]?.reason).toContain('list "Hot accounts"');
    expect(planned.preview.skipped[1]?.reason).toContain("signing secret");
    expect(planned.preview.signals_updated).toEqual([{ key: "news_mention", enabled: false }]);
    expect(planned.preview.settings_changed).toEqual(
      expect.arrayContaining(["ai", "approvals", "booking", "replies", "strategy"]),
    );
    expect(planned.warnings).toEqual([]);
    expect(await engine.db.select().from(offers).where(eq(offers.workspace_id, targetId))).toEqual(
      [],
    );

    const result = (await importInto("harbor-example", setup, false)) as ImportPlan;
    expect(result.created.map((item) => item.name)).toEqual(
      planned.preview.created.map((item) => item.name),
    );
    expect(result.created.every((item) => typeof item.id === "string")).toBe(true);

    const [offer] = await engine.db.select().from(offers).where(eq(offers.workspace_id, targetId));
    const [proof] = await engine.db
      .select()
      .from(knowledge_items)
      .where(and(eq(knowledge_items.workspace_id, targetId), eq(knowledge_items.kind, "proof")));
    expect(offer).toMatchObject({ name: "Forecast Pilot", is_default: true, booking_url: null });
    expect(offer?.proof_item_ids).toEqual([proof?.id]);
    expect(proof?.source_ref).toBe("https://northwind.example.com/customers/lumen-home");
    const [lesson] = await engine.db
      .select()
      .from(knowledge_items)
      .where(and(eq(knowledge_items.workspace_id, targetId), eq(knowledge_items.kind, "lesson")));
    expect(lesson?.expires_at?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    const [icp] = await engine.db.select().from(icps).where(eq(icps.workspace_id, targetId));
    expect(icp).toMatchObject({ name: "Texas dental practices", is_default: true });
    const definitions = await engine.db
      .select()
      .from(signal_definitions)
      .where(eq(signal_definitions.workspace_id, targetId));
    expect(definitions.find((row) => row.key === "new_clinic_location")?.kind).toBe("custom");
    expect(definitions.find((row) => row.key === "news_mention")?.enabled).toBe(false);
    const rules = await engine.db
      .select()
      .from(automation_rules)
      .where(eq(automation_rules.workspace_id, targetId));
    expect(rules.map((rule) => rule.name)).toEqual(["Funding alert"]);
    const [template] = await engine.db
      .select()
      .from(templates)
      .where(eq(templates.workspace_id, targetId));
    expect(template?.name).toBe("Clinic owners, 4 touches");
    const created = (await engine.call(
      "campaigns.create",
      { name: "From the copy", template: template?.id },
      { workspace: "harbor-example" },
    )) as { steps: unknown[] };
    expect(created.steps.length).toBeGreaterThan(0);

    const [target] = await engine.db.select().from(workspaces).where(eq(workspaces.id, targetId));
    expect(target?.settings).toMatchObject({
      ai: { tone_notes: "Plain and short." },
      approvals: { default_review_level: "every" },
      strategy: { goals: "Ten qualified meetings a month" },
    });
    expect(target?.settings).not.toHaveProperty("company");
    expect(target?.settings).not.toHaveProperty("sandbox");
  });

  it("skips names that already exist, so a second import changes nothing", async () => {
    // The whole export result works too (what the CLI prints with --json).
    const exported = await exportSetup({ include_lessons: true });
    const again = (await importInto("harbor-example", exported, false)) as ImportPlan;
    expect(again.created).toEqual([]);
    expect(again.settings_changed).toEqual([]);
    expect(again.signals_updated).toEqual([]);
    expect(again.skipped.map((item) => `${item.type}:${item.name}`)).toEqual(
      expect.arrayContaining([
        "knowledge:Stockouts down 31%",
        "lesson:Short subject lines win",
        "offer:Forecast Pilot",
        "icp:Texas dental practices",
        "signal:new_clinic_location",
        "automation:Funding alert",
        "campaign_template:Clinic owners, 4 touches",
      ]),
    );
    expect(again.skipped.find((item) => item.name === "Forecast Pilot")?.reason).toContain(
      "already exists",
    );
  });

  it("gives a lesson imported without an expiry the 90 day default", async () => {
    await engine.call("workspaces.create", { name: "Birch Example" });
    const targetId = await workspaceId("birch-example");
    const { setup } = await exportSetup({ include_lessons: true });
    const lessons = setup.lessons.map((lesson) => ({ ...lesson, expires_at: null }));
    await importInto("birch-example", { ...setup, lessons }, false);
    const [lesson] = await engine.db
      .select()
      .from(knowledge_items)
      .where(and(eq(knowledge_items.workspace_id, targetId), eq(knowledge_items.kind, "lesson")));
    expect(lesson?.expires_at?.getTime()).toBe(engine.clock.now().getTime() + 90 * 86_400_000);
  });

  it("brings the company section only when the file has it", async () => {
    await engine.call("workspaces.create", { name: "Cedar Example" });
    const { setup } = await exportSetup({ include_company: true });
    await importInto("cedar-example", setup, false);
    const [target] = await engine.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, "cedar-example"));
    expect(target?.settings).toMatchObject({
      company: { name: "Northwind Example" },
      booking: { default_url: "https://cal.example.com/northwind" },
    });
    expect(target?.settings).not.toHaveProperty(["ai", "fallback_provider"]);
  });

  it("rejects files that are not setups, or from a newer version", async () => {
    await expect(importInto("harbor-example", { format: "csv" })).rejects.toMatchObject({
      code: "validation_failed",
      message: "This is not an OpenOutbound setup file.",
    });
    await expect(
      importInto("harbor-example", {
        format: "openoutbound.setup",
        version: 2,
        exported_at: "2026-09-27T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "validation_failed", hint: expect.stringContaining("newer") });
    await expect(
      importInto("harbor-example", {
        format: "openoutbound.setup",
        version: 1,
        exported_at: "2026-09-27T00:00:00Z",
        offers: [{ summary: "no name" }],
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringContaining("offers.0"),
    });
  });

  it("skips settings that loosen a gate when someone who must ask imports them", async () => {
    await engine.call("workspaces.create", { name: "Gate Example" });
    const agent = engine.principal({
      type: "agent",
      id: "key_import_agent",
      name: "Import agent",
      scopes: [...ALL_SCOPES],
    });
    const setup = {
      format: "openoutbound.setup",
      version: 1,
      exported_at: "2026-09-27T00:00:00Z",
      settings: {
        approvals: { agent_changes: "auto" },
        strategy: { goals: "Ten qualified meetings a month" },
      },
    };
    const run = (dryRun: boolean) =>
      engine.call(
        "workspaces.import_setup",
        { setup, dry_run: dryRun },
        { workspace: "gate-example", principal: agent },
      );
    const planned = (await run(true)) as DryRunResult;
    expect(planned.preview.settings_changed).toEqual([]);
    expect(planned.preview.skipped).toEqual([
      {
        type: "settings",
        name: "settings",
        reason: expect.stringContaining("settings.approvals.agent_changes"),
      },
    ]);
    const done = (await run(false)) as ImportPlan;
    expect(done.settings_changed).toEqual([]);
    expect(done.skipped[0]?.reason).toContain("manage_strategy action propose");
    const [target] = await engine.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, "gate-example"));
    expect(target?.settings).toEqual({});
  });

  it("ignores sections a setup never carries", async () => {
    const result = (await importInto("harbor-example", {
      format: "openoutbound.setup",
      version: 1,
      exported_at: "2026-09-27T00:00:00Z",
      leads: [{ email: "someone@example.org" }],
      mailboxes: [{ email: "sender@example.org", password: "x" }],
      settings: { sandbox: { use_real_brain: true }, ai: { fallback_provider: "openai" } },
    })) as DryRunResult;
    expect(result.preview.created).toEqual([]);
    expect(result.preview.settings_changed).toEqual([]);
    expect(result.warnings.join(" ")).toContain("Ignored sections: leads, mailboxes");
    expect(result.warnings.join(" ")).toContain("provider settings");
  });

  it("never sends a copied setup's leads to the source client's webhook endpoints", async () => {
    const HOOK = "https://hooks.example.org/northwind/leads";
    const STEP_HOOK = "https://steps.example.org/northwind/enrolled";
    await engine.call("workspaces.create", { name: "Hook Source Example" });
    const source = "hook-source-example";
    await call(
      "signals.automations.create",
      { name: "Lead hook", actions: [{ type: "notify" }, { type: "webhook", url: HOOK }] },
      source,
    );
    const campaign = (await call(
      "campaigns.create",
      {
        name: "Hook sequence",
        steps: [
          { type: "email", config: { instruction: "A short first email." } },
          { type: "webhook", delay_days: 1, config: { url: STEP_HOOK } },
        ],
      },
      source,
    )) as { id: string };
    await call(
      "campaigns.save_as_template",
      { campaign_id: campaign.id, name: "Hook sequence" },
      source,
    );

    // Without include_company the addresses stay out of the file.
    const plain = await exportSetup({}, source);
    const plainText = JSON.stringify(plain.setup);
    expect(plainText).not.toContain("hooks.example.org");
    expect(plainText).not.toContain("steps.example.org");
    expect(plain.setup.automations[0]?.actions).toEqual([
      { type: "notify" },
      { type: "webhook", url: null, signed: false },
    ]);
    expect(plain.summary.left_out.join(" ")).toContain("The URLs of 2 webhooks");
    const full = await exportSetup({ include_company: true }, source);
    expect(JSON.stringify(full.setup)).toContain(HOOK);
    expect(JSON.stringify(full.setup)).toContain(STEP_HOOK);

    // With the addresses in the file: the rule comes in switched off and the step without them.
    await engine.call("workspaces.create", { name: "Hook Target Example" });
    const target = await workspaceId("hook-target-example");
    const planned = (await importInto("hook-target-example", full.setup)) as DryRunResult;
    expect(planned.preview.created.map((item) => `${item.type}:${item.name}`)).toEqual([
      "automation:Lead hook",
      "campaign_template:Hook sequence",
    ]);
    expect(planned.warnings).toEqual([
      expect.stringMatching(/Automation "Lead hook" is imported switched off.*hooks\.example\.org/),
      expect.stringMatching(/Template "Hook sequence".*webhook step 2.*steps\.example\.org/),
    ]);
    const imported = (await importInto("hook-target-example", full.setup, false)) as ImportPlan;
    expect(imported.warnings).toEqual(planned.warnings);
    const [rule] = await engine.db
      .select()
      .from(automation_rules)
      .where(eq(automation_rules.workspace_id, target));
    expect(rule?.enabled).toBe(false);
    expect(rule?.actions).toContainEqual({ type: "webhook", url: HOOK });
    const [template] = await engine.db
      .select()
      .from(templates)
      .where(eq(templates.workspace_id, target));
    expect(JSON.stringify(template?.content)).not.toContain("steps.example.org");
    const content = template?.content as { steps?: Array<{ config: object }> } | undefined;
    expect(content?.steps?.[1]?.config).toEqual({});

    // Without them: the rule cannot work, so it is skipped; the template still comes in.
    await engine.call("workspaces.create", { name: "Hook Plain Example" });
    const bare = (await importInto("hook-plain-example", plain.setup, false)) as ImportPlan;
    expect(bare.created.map((item) => item.name)).toEqual(["Hook sequence"]);
    expect(bare.skipped).toEqual([
      expect.objectContaining({
        type: "automation",
        name: "Lead hook",
        reason: expect.stringContaining("include_company"),
      }),
    ]);
    expect(bare.warnings).toEqual([
      expect.stringMatching(/Template "Hook sequence".*webhook step 2 has no URL/),
    ]);
  });

  it("writes large setups to the exports folder and imports them by file name", async () => {
    await engine.call("workspaces.create", { name: "Large Example" });
    const body = "Detailed product notes. ".repeat(800);
    for (let index = 0; index < 12; index++) {
      await call(
        "knowledge.create",
        { kind: "product", title: `Module ${index}`, body },
        "large-example",
      );
    }
    const { summary, path } = await exportSetup({}, "large-example");
    expect(summary.bytes).toBeGreaterThan(200 * 1024);
    expect(path).toBe(join(stateDir, "exports", "setup-large-example-2026-09-19.json"));
    const file = JSON.parse(await readFile(path as string, "utf8")) as { knowledge: unknown[] };
    expect(file.knowledge).toHaveLength(12);

    await engine.call("workspaces.create", { name: "Copy Example" });
    const result = (await engine.call(
      "workspaces.import_setup",
      { path: "setup-large-example-2026-09-19.json", dry_run: false },
      { workspace: "copy-example" },
    )) as ImportPlan;
    expect(result.created.filter((item) => item.type === "knowledge")).toHaveLength(12);
    await expect(
      engine.call(
        "workspaces.import_setup",
        { path: "../secrets.json" },
        { workspace: "copy-example" },
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      engine.call(
        "workspaces.import_setup",
        { path: "setup-large-example-2026-09-19.json" },
        {
          workspace: "copy-example",
          principal: engine.principal({ workspaceId: await workspaceId("copy-example") }),
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
