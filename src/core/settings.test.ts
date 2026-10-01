import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPLY_RULES,
  mergeSettings,
  parseCampaignSettings,
  parseStepConfig,
  parseWorkspaceSettings,
  stepConfigSchema,
} from "./settings.js";

describe("workspace settings", () => {
  it("fills every default from an empty object", () => {
    const settings = parseWorkspaceSettings({});
    expect(settings.schedule.working_days).toEqual([1, 2, 3, 4, 5]);
    expect(settings.compliance.consent_required_countries).toEqual([
      "DE",
      "AT",
      "IT",
      "ES",
      "NL",
      "DK",
      "PL",
      "BE",
    ]);
    expect(settings.compliance.publication_evidence_countries).toEqual(["CA", "AU"]);
    expect(settings.compliance.ad_disclosure.countries).toEqual(["US"]);
    expect(settings.compliance.ai_disclosure.auto_replies).toBe("eu");
    expect(settings.compliance.retention_days).toBe(1095);
    expect(settings.data.enrichment.pattern_guessing).toBe(false);
    expect(settings.data.enrichment.crawler_excluded_countries).toEqual([]);
    expect(settings.compliance.contact_cap_per_company).toBe(3);
    expect(settings.sending.catch_all).toBe("skip");
    expect(settings.sending.tracking).toEqual({ opens: false, clicks: false });
    expect(settings.sending.reply_delay_minutes).toEqual([3, 12]);
    expect(settings.ai).toEqual({
      monthly_budget_usd: null,
      language: "en",
      tone_notes: "",
      task_models: {},
      fallback_provider: null,
      agent_timeout_minutes: 30,
    });
    expect(settings.data.enrichment).toEqual({
      finders: [],
      verifier: null,
      verify_existing: true,
      pattern_guessing: false,
      website_crawler: true,
      crawler_excluded_countries: [],
    });
    expect(settings.approvals).toEqual({
      agent_launch_requires_approval: true,
      default_review_level: "first",
      expire_days: 7,
      agent_changes: "approve",
    });
    expect(settings.replies.unsubscribe).toEqual({ action: "suppress", locked: true });
    expect(settings.replies.interested.action).toBe("opportunity_and_draft");
    expect(settings.sandbox.use_real_brain).toBe(false);
  });

  it("fills the booking, inbox, lead file, strategy and CRM sections", () => {
    const settings = parseWorkspaceSettings({});
    expect(settings.booking).toEqual({
      mode: "link",
      default_url: null,
      tag_links: true,
      assume_held_after_hours: 24,
      after_no_show: "task",
      after_cancel: "task",
    });
    expect(settings.inbox).toEqual({ read_sent_folder: true });
    expect(settings.lead_file).toEqual({
      extract_facts: true,
      extract_promises: true,
      writer_context: true,
    });
    expect(settings.strategy).toEqual({ goals: "", qualified_meeting: "", agent_notes: "" });
    expect(settings.crm).toEqual({
      mode: "built_in",
      sync_from: "interested",
      log: "deals",
      timing: "live",
      stage_owner: "engine",
      on_forget: "task",
      skip_owned_accounts: false,
      allow_outreach_with_open_deal: false,
      notes: "",
    });
    expect(settings.sending.daily_dns_check).toBe(true);
    expect(settings.compliance.privacy_response_days).toBe(30);
    expect(settings.replies.privacy_request).toEqual({ action: "privacy", locked: true });
  });

  it("validates the new settings", () => {
    expect(() => parseWorkspaceSettings({ booking: { mode: "calendar" } })).toThrow();
    expect(() =>
      parseWorkspaceSettings({ booking: { default_url: "ftp://cal.example.com/sam" } }),
    ).toThrow();
    expect(
      parseWorkspaceSettings({ booking: { default_url: "https://cal.example.com/sam" } }).booking
        .default_url,
    ).toBe("https://cal.example.com/sam");
    expect(() => parseWorkspaceSettings({ booking: { assume_held_after_hours: 721 } })).toThrow();
    expect(parseWorkspaceSettings({ booking: { assume_held_after_hours: 0 } }).booking).toEqual(
      expect.objectContaining({ assume_held_after_hours: 0, mode: "link" }),
    );
    expect(() => parseWorkspaceSettings({ ai: { agent_timeout_minutes: 4 } })).toThrow();
    expect(() => parseWorkspaceSettings({ ai: { agent_timeout_minutes: 1441 } })).toThrow();
    expect(() => parseWorkspaceSettings({ compliance: { privacy_response_days: 91 } })).toThrow();
    expect(() => parseWorkspaceSettings({ strategy: { goals: "x".repeat(2001) } })).toThrow();
    expect(() => parseWorkspaceSettings({ crm: { on_forget: "archive" } })).toThrow();
  });

  it("keeps partial overrides and defaults the rest", () => {
    const settings = parseWorkspaceSettings({
      ai: { monthly_budget_usd: 25 },
      compliance: { excluded_countries: ["FR"] },
    });
    expect(settings.ai.monthly_budget_usd).toBe(25);
    expect(settings.ai.language).toBe("en");
    expect(settings.compliance.excluded_countries).toEqual(["FR"]);
    expect(settings.compliance.include_unsubscribe_link).toBe(true);
  });

  it("enforces locked reply rules", () => {
    const settings = parseWorkspaceSettings({
      replies: {
        unsubscribe: { action: "ignore", locked: false },
        question: { action: "auto_reply" },
      },
    });
    expect(settings.replies.unsubscribe).toEqual(DEFAULT_REPLY_RULES.unsubscribe);
    expect(settings.replies.question.action).toBe("auto_reply");
  });

  it("keeps privacy requests locked to the privacy action", () => {
    const settings = parseWorkspaceSettings({
      replies: { privacy_request: { action: "draft_reply", locked: false } },
    });
    expect(settings.replies.privacy_request).toEqual({ action: "privacy", locked: true });
  });

  it("rejects invalid values", () => {
    expect(() =>
      parseWorkspaceSettings({ compliance: { excluded_countries: ["germany"] } }),
    ).toThrow();
  });

  it("mergeSettings deep-merges objects and replaces arrays", () => {
    const merged = mergeSettings(
      { ai: { language: "de", tone_notes: "warm" }, schedule: { working_days: [1, 2] } },
      { ai: { language: "en" }, schedule: { working_days: [3] } },
    );
    expect(merged).toEqual({
      ai: { language: "en", tone_notes: "warm" },
      schedule: { working_days: [3] },
    });
  });
});

describe("campaign settings", () => {
  it("fills defaults", () => {
    const settings = parseCampaignSettings(undefined);
    expect(settings.review_level).toBe("first");
    expect(settings.schedule).toMatchObject({
      start_hour: 8,
      end_hour: 17,
      timezone_mode: "lead",
      timezone: "UTC",
    });
    expect(settings.daily_new_leads).toBe(20);
    expect(settings.priority).toBe(50);
    expect(settings.writing.length).toBe("short");
    expect(settings.missing_data).toBe("skip_step");
    expect(settings.end_action).toEqual({ type: "none" });
    expect(settings.stop).toEqual({ on_reply: true, on_company_reply: true, on_meeting: true });
    expect(settings.ab_test).toEqual({ enabled: false, metric: "positive_reply_rate" });
  });
});

describe("step config", () => {
  it("defaults an email step", () => {
    const step = parseStepConfig("email", { instruction: "Mention the new location" });
    expect(step).toEqual({
      type: "email",
      mode: "new_thread",
      style: "free",
      instruction: "Mention the new location",
      max_words: 90,
    });
  });

  it("validates per type", () => {
    expect(() => parseStepConfig("email", { style: "exact" })).toThrow(/body/);
    expect(() => parseStepConfig("condition", { if: "signal_present" })).toThrow(/signal_key/);
    expect(parseStepConfig("linkedin_invite", {})).toEqual({
      type: "linkedin_invite",
      note: "none",
    });
    expect(parseStepConfig("condition", { if: "has_email" })).toMatchObject({
      then_step: null,
      else_step: null,
    });
    expect(parseStepConfig("wait", {})).toEqual({ type: "wait" });
  });

  it("rejects unknown step types", () => {
    expect(stepConfigSchema.safeParse({ type: "fax" }).success).toBe(false);
  });
});
