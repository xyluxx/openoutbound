import { describe, expect, it } from "vitest";
import { parseCampaignSettings } from "../../core/settings.js";
import { module } from "./index.js";
import {
  stepAction,
  stepChannel,
  stepDelayMs,
  stepInput,
  stepUsesAi,
  validateSteps,
} from "./steps.js";
import { BUILTIN_TEMPLATES } from "./templates.js";
import {
  countryTimeZone,
  isValidTimeZone,
  localDate,
  recipientTimeZone,
  startOfLocalDay,
} from "./timezones.js";

const parse = (steps: unknown[]) => validateSteps(steps.map((step) => stepInput.parse(step)));

describe("validateSteps", () => {
  it("validates every config against its type and reports paths", () => {
    expect(() =>
      parse([
        { type: "email", config: { style: "guided" } },
        { type: "webhook", config: { url: "ftp://example.com" } },
        { type: "condition", config: { if: "signal_present" } },
      ]),
    ).toThrowError(/steps\.0\.config\.body.*steps\.1\.config\.url.*steps\.2\.config\.signal_key/);
  });

  it("allows only forward condition jumps up to the step count (end)", () => {
    expect(() =>
      parse([
        { type: "task", config: { title: "a" } },
        { type: "condition", config: { if: "has_email", then_step: 1 } },
      ]),
    ).toThrowError(/steps\.1\.config\.then_step/);
    expect(
      parse([
        { type: "condition", config: { if: "has_email", then_step: 2, else_step: 1 } },
        { type: "task", config: { title: "a" } },
      ]),
    ).toHaveLength(2);
  });

  it("rejects duplicate variant keys, empty lists and too many steps", () => {
    expect(() =>
      parse([
        {
          type: "email",
          config: { variants: [{ key: "A" }, { key: "A" }] },
        },
      ]),
    ).toThrowError(/Duplicate variant key/);
    expect(() => parse([])).toThrowError(/at least one step/);
    expect(() => parse(Array.from({ length: 31 }, () => ({ type: "wait" as const })))).toThrowError(
      /At most 30 steps/,
    );
  });

  it("keeps ids and stores the type inside the config", () => {
    const [step] = parse([{ id: "stp_1", type: "linkedin_invite", delay_days: 2 }]);
    expect(step).toEqual({
      id: "stp_1",
      type: "linkedin_invite",
      delay_days: 2,
      delay_hours: 0,
      config: { type: "linkedin_invite" },
    });
  });
});

describe("step helpers", () => {
  it("maps types to channels, actions, delays and AI use", () => {
    expect(stepChannel("linkedin_like")).toBe("linkedin");
    expect(stepChannel("task")).toBeNull();
    expect(stepAction("linkedin_invite")).toBe("invite");
    expect(stepDelayMs({ delay_days: 1, delay_hours: 2 })).toBe(26 * 3_600_000);
    expect(
      stepUsesAi({ type: "email", config: { type: "email", style: "exact", body: "x" } }),
    ).toBe(false);
    expect(stepUsesAi({ type: "linkedin_invite", config: { type: "linkedin_invite" } })).toBe(
      false,
    );
    expect(stepUsesAi({ type: "linkedin_comment", config: { type: "linkedin_comment" } })).toBe(
      true,
    );
  });
});

describe("built-in templates", () => {
  it.each(BUILTIN_TEMPLATES.map((template) => [template.key, template]))(
    "%s has valid steps and settings",
    (_key, template) => {
      expect(parse(template.steps).length).toBeGreaterThan(0);
      expect(() => parseCampaignSettings(template.settings)).not.toThrow();
    },
  );

  it("are the five from the sequences playbook", () => {
    expect(BUILTIN_TEMPLATES.map((template) => template.key)).toEqual([
      "signal_based_email_4",
      "email_linkedin_6",
      "local_business_3",
      "event_follow_up",
      "re_engage_lost",
    ]);
  });
});

describe("module", () => {
  it("points every tool action at a registered operation", () => {
    const ids = new Set(module.operations?.map((op) => op.id));
    for (const tool of module.tools ?? []) {
      for (const opId of Object.values(tool.actions ?? {})) expect(ids.has(opId)).toBe(true);
    }
    expect(module.schedules?.[0]).toMatchObject({ job: "campaigns.tick", perWorkspace: true });
    expect(module.approvalResolvers?.map((resolver) => resolver.kind)).toEqual([
      "message",
      "campaign_launch",
      "enrollment",
      "review_level",
    ]);
  });

  it("has examples that parse against the input schemas", () => {
    for (const op of module.operations ?? []) {
      for (const example of op.examples) {
        const parsed = op.input.safeParse(example.input);
        expect({ op: op.id, ok: parsed.success }).toEqual({ op: op.id, ok: true });
      }
    }
  });
});

describe("timezones", () => {
  const schedule = parseCampaignSettings({ schedule: { timezone: "Europe/Paris" } }).schedule;

  it("prefers the person's zone, then company, country and campaign fallback", () => {
    expect(recipientTimeZone(schedule, { timezone: "Asia/Tokyo", country: "US" }, null)).toBe(
      "Asia/Tokyo",
    );
    expect(
      recipientTimeZone(
        schedule,
        { timezone: null, country: null },
        { timezone: "America/Denver", country: "US" },
      ),
    ).toBe("America/Denver");
    expect(recipientTimeZone(schedule, { timezone: "Not/AZone", country: "GB" }, null)).toBe(
      "Europe/London",
    );
    expect(recipientTimeZone(schedule, { timezone: null, country: "ZZ" }, null)).toBe(
      "Europe/Paris",
    );
    const fixed = { ...schedule, timezone_mode: "fixed" as const };
    expect(recipientTimeZone(fixed, { timezone: "Asia/Tokyo", country: "JP" }, null)).toBe(
      "Europe/Paris",
    );
  });

  it("computes local days across DST changes", () => {
    expect(isValidTimeZone("America/Chicago")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(countryTimeZone("de")).toBe("Europe/Berlin");
    // 2026-11-01 is the DST end in Chicago (CDT -5 until 02:00, then CST -6).
    const afternoon = new Date("2026-11-01T20:00:00Z");
    expect(localDate(afternoon, "America/Chicago")).toBe("2026-11-01");
    expect(startOfLocalDay(afternoon, "America/Chicago").toISOString()).toBe(
      "2026-11-01T05:00:00.000Z",
    );
    expect(startOfLocalDay(new Date("2026-09-20T04:30:00Z"), "America/Chicago").toISOString()).toBe(
      "2026-09-19T05:00:00.000Z",
    );
    expect(startOfLocalDay(new Date("2026-09-20T01:00:00Z"), "Asia/Tokyo").toISOString()).toBe(
      "2026-09-19T15:00:00.000Z",
    );
  });
});
