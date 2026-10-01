import { describe, expect, it } from "vitest";
import { REPLY_CATEGORIES } from "../../core/enums.js";
import { DEFAULT_REPLY_RULES, parseWorkspaceSettings } from "../../core/settings.js";
import {
  AUTO_SEND_CATEGORIES,
  autoSendBlockers,
  readCampaignReplyOverrides,
  resolveReplyRule,
} from "./rules.js";

const defaults = parseWorkspaceSettings({});

describe("resolveReplyRule", () => {
  it("uses the spec defaults for every category", () => {
    for (const category of REPLY_CATEGORIES) {
      const rule = resolveReplyRule(category, defaults);
      expect(rule.action).toBe(DEFAULT_REPLY_RULES[category].action);
      expect(rule.locked).toBe(DEFAULT_REPLY_RULES[category].locked);
    }
  });

  it("applies workspace settings, then campaign overrides", () => {
    const settings = parseWorkspaceSettings({
      replies: { question: { action: "auto_reply" }, not_now: { action: "human" } },
    });
    expect(resolveReplyRule("question", settings)).toMatchObject({
      action: "auto_reply",
      source: "workspace",
    });
    const campaign = { replies: { question: { action: "draft_reply" } } };
    expect(resolveReplyRule("question", settings, campaign)).toMatchObject({
      action: "draft_reply",
      source: "campaign",
    });
    expect(resolveReplyRule("not_now", settings, campaign).action).toBe("human");
  });

  it("never lets settings or campaigns weaken locked rules", () => {
    const settings = parseWorkspaceSettings({
      replies: {
        unsubscribe: { action: "ignore", locked: false },
        negative: { action: "auto_reply" },
        bounce: { action: "ignore" },
      },
    });
    const campaign = {
      replies: {
        unsubscribe: { action: "draft_reply" },
        negative: { action: "auto_reply" },
        bounce: { action: "human" },
      },
    };
    expect(resolveReplyRule("unsubscribe", settings, campaign)).toMatchObject({
      action: "suppress",
      locked: true,
      source: "locked",
    });
    expect(resolveReplyRule("negative", settings, campaign).action).toBe("notify_human");
    expect(resolveReplyRule("bounce", settings, campaign).action).toBe("mark_invalid");
  });

  it("ignores malformed campaign overrides", () => {
    expect(readCampaignReplyOverrides(null)).toEqual({});
    expect(readCampaignReplyOverrides({ replies: "x" })).toEqual({});
    expect(
      readCampaignReplyOverrides({
        replies: {
          interested: { action: "launch_rockets" },
          nonsense: { action: "human" },
          objection: { action: "human" },
          unsubscribe: { action: "ignore" },
        },
      }),
    ).toEqual({ objection: "human" });
  });
});

describe("autoSendBlockers", () => {
  const base = {
    rule: {
      category: "question" as const,
      action: "auto_reply" as const,
      locked: false,
      source: "workspace" as const,
    },
    classificationConfidence: 0.9,
    suspicious: false,
    reviewReasons: [],
    needsHuman: false,
    check: { passed: true, verdict: "pass" as const, confidence: 0.9 },
  };

  it("allows only fully confident auto_reply drafts", () => {
    expect(autoSendBlockers(base)).toEqual([]);
  });

  it("blocks on every failed gate", () => {
    expect(autoSendBlockers({ ...base, rule: { ...base.rule, action: "draft_reply" } })).toContain(
      "rule_requires_review",
    );
    expect(autoSendBlockers({ ...base, rule: { ...base.rule, category: "objection" } })).toContain(
      "category_not_auto_sendable",
    );
    expect(autoSendBlockers({ ...base, classificationConfidence: 0.79 })).toContain(
      "classification_not_confident",
    );
    expect(autoSendBlockers({ ...base, check: { ...base.check, confidence: 0.5 } })).toContain(
      "checker_not_confident",
    );
    expect(autoSendBlockers({ ...base, check: { ...base.check, verdict: "revise" } })).toContain(
      "checker_verdict_not_pass",
    );
    expect(autoSendBlockers({ ...base, check: { ...base.check, passed: false } })).toContain(
      "checks_failed",
    );
    expect(autoSendBlockers({ ...base, suspicious: true })).toContain("suspicious_reply");
    expect(autoSendBlockers({ ...base, needsHuman: true })).toContain("knowledge_missing");
    expect(autoSendBlockers({ ...base, reviewReasons: ["asks_if_bot"] })).toContain(
      "needs_human_review",
    );
  });

  it("never auto-sends locked or human categories", () => {
    for (const category of ["unsubscribe", "bounce", "negative", "other", "objection"] as const) {
      expect(AUTO_SEND_CATEGORIES.has(category)).toBe(false);
    }
  });
});
