import { createHmac } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import type { OpContext } from "../../../core/context.js";
import { requireWorkspace } from "../../../core/context.js";
import type { StepConfigOf } from "../../../core/settings.js";
import { messages, tasks } from "../../../db/schema/index.js";
import { getRelation } from "../../linkedin/service.js";
import { getActiveSignals } from "../../signals/service.js";
import { stepConfig } from "../steps.js";
import { renderTemplate } from "../writing/render.js";
import { advance, reschedule, type StepState, updateRun } from "./state.js";

const WEBHOOK_MAX_ATTEMPTS = 3;
const WEBHOOK_TIMEOUT_MS = 10_000;

/** Evaluates a condition step for the enrollment's person. */
export async function evaluateCondition(
  ctx: OpContext,
  state: StepState,
  config: StepConfigOf<"condition">,
): Promise<boolean> {
  const { person, enrollment, loaded } = state;
  switch (config.if) {
    case "has_email":
      return Boolean(person.email) && person.email_status !== "invalid";
    case "has_linkedin":
      return Boolean(person.linkedin_url);
    case "linkedin_connected": {
      const accountId =
        enrollment.linkedin_account_id ?? loaded.settings.senders.linkedin_account_ids[0] ?? null;
      if (!accountId) return false;
      return (await getRelation(ctx, { accountId, personId: person.id })) === "connected";
    }
    case "signal_present": {
      const lists = await Promise.all([
        person.company_id
          ? getActiveSignals(ctx, { companyId: person.company_id, limit: 50 })
          : Promise.resolve([]),
        getActiveSignals(ctx, { personId: person.id, limit: 50 }),
      ]);
      return lists.flat().some((signal) => signal.definition_key === config.signal_key);
    }
    case "replied": {
      const workspace = requireWorkspace(ctx);
      const rows = await ctx.db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.workspace_id, workspace.id),
            eq(messages.person_id, person.id),
            eq(messages.direction, "inbound"),
            gte(messages.created_at, enrollment.enrolled_at),
          ),
        )
        .limit(1);
      return rows.length > 0;
    }
    case "custom": {
      const value = person.custom?.[config.custom_field ?? ""];
      if (config.custom_value !== undefined) {
        return value !== undefined && value !== null && String(value) === config.custom_value;
      }
      return value !== undefined && value !== null && value !== "" && value !== false;
    }
  }
}

async function runCondition(ctx: OpContext, state: StepState): Promise<void> {
  const config = stepConfig({ type: "condition", config: state.step.config });
  const result = await evaluateCondition(ctx, state, config);
  const target = result ? config.then_step : config.else_step;
  await advance(ctx, state, {
    to: target,
    anchor: ctx.clock.now(),
    outcome: "done",
    detail: { branch: result ? "then" : "else" },
  });
}

async function runTask(ctx: OpContext, state: StepState): Promise<void> {
  if (!state.run.detail.task_id) {
    const config = stepConfig({ type: "task", config: state.step.config });
    const vars = {
      first_name: state.person.first_name,
      last_name: state.person.last_name,
      company: state.company?.name ?? null,
      title: state.person.title,
      city: state.person.city ?? state.company?.city ?? null,
      custom: { ...(state.company?.custom ?? {}), ...(state.person.custom ?? {}) },
    };
    const title = renderTemplate(config.title, vars).text;
    const notes = renderTemplate(config.notes, vars).text;
    const now = ctx.clock.now();
    await ctx.db.transaction(async (tx) => {
      const [task] = await tx
        .insert(tasks)
        .values({
          workspace_id: state.enrollment.workspace_id,
          person_id: state.person.id,
          campaign_id: state.loaded.campaign.id,
          enrollment_id: state.enrollment.id,
          type: config.task_type,
          title,
          notes: notes || null,
          due_at: now,
          status: "open",
        })
        .returning({ id: tasks.id });
      if (!task) throw new Error("task insert returned no row");
      await updateRun(tx, state.run, { detail: { task_id: task.id } });
    });
  }
  await advance(ctx, state, { anchor: ctx.clock.now(), outcome: "done" });
}

/** `OpenOutbound-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>` (spec 6). */
export function signWebhook(secret: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function runWebhook(ctx: OpContext, state: StepState): Promise<void> {
  const workspace = requireWorkspace(ctx);
  const config = stepConfig({ type: "webhook", config: state.step.config });
  const now = ctx.clock.now();
  const attempts = (state.run.detail.webhook_attempts ?? 0) + 1;
  const body = JSON.stringify({
    type: "campaign.step",
    delivery_id: `${state.enrollment.id}:${state.step.id}:${state.run.attempt}`,
    occurred_at: now.toISOString(),
    campaign: { id: state.loaded.campaign.id, name: state.loaded.campaign.name },
    enrollment_id: state.enrollment.id,
    step: { id: state.step.id, position: state.step.position },
    person: {
      id: state.person.id,
      first_name: state.person.first_name,
      last_name: state.person.last_name,
      email: state.person.email,
      title: state.person.title,
      linkedin_url: state.person.linkedin_url,
      company: state.company
        ? { id: state.company.id, name: state.company.name, domain: state.company.domain }
        : null,
    },
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "openoutbound-event": "campaign.step",
    "openoutbound-delivery": `${state.enrollment.id}:${state.step.id}:${state.run.attempt}`,
  };
  if (config.secret_id) {
    const secret = await ctx.vault.getSecret(config.secret_id, workspace.id);
    if (!secret) {
      await advance(ctx, state, {
        anchor: now,
        outcome: "skipped",
        detail: { reason: "webhook_secret_missing" },
      });
      return;
    }
    headers["openoutbound-signature"] = signWebhook(secret, body, now);
  }
  let status: number | null = null;
  try {
    const response = await ctx.fetch(config.url, {
      method: "POST",
      body,
      headers,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
    });
    status = response.status;
  } catch (error) {
    ctx.log.warn(
      {
        enrollment_id: state.enrollment.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "campaign webhook step failed",
    );
  }
  if (status !== null && status >= 200 && status < 300) {
    await advance(ctx, state, {
      anchor: now,
      outcome: "done",
      detail: { webhook_attempts: attempts, webhook_status: status },
    });
    return;
  }
  if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
    await advance(ctx, state, {
      anchor: now,
      outcome: "skipped",
      detail: { reason: "webhook_failed", webhook_attempts: attempts, webhook_status: status },
    });
    return;
  }
  await updateRun(ctx.db, state.run, {
    detail: { webhook_attempts: attempts, webhook_status: status },
  });
  await reschedule(ctx, state, new Date(now.getTime() + attempts * 5 * 60_000));
}

/** Runs a step that does not contact the person: wait, condition, task, webhook. */
export async function executeFlowStep(ctx: OpContext, state: StepState): Promise<void> {
  switch (state.step.type) {
    case "wait":
      await advance(ctx, state, { anchor: ctx.clock.now(), outcome: "done" });
      return;
    case "condition":
      await runCondition(ctx, state);
      return;
    case "task":
      await runTask(ctx, state);
      return;
    case "webhook":
      await runWebhook(ctx, state);
      return;
    default:
      throw new Error(`Not a flow step: ${state.step.type}`);
  }
}
