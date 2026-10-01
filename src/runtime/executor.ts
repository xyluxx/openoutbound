/**
 * The safety gate every call goes through (spec 6), in this exact order:
 * principal (bound to the session's workspace when the door asks) -> workspace -> workspace
 * access and the `workspace: "none"` policy -> scopes -> input validation -> dry-run flag ->
 * idempotency lookup -> paused workspace (send ops) -> budget (spend ops) -> handler -> audit
 * (every non-read op, failures and dry runs included) -> idempotency store.
 * A used-up data budget refuses real spend runs; a dry run still returns its preview, with a
 * warning first that the real run would be refused and why.
 *
 * Every door (CLI, REST, MCP, the bridges) and every operation run from inside another one
 * (`callOperationAs`) goes through `call`; nothing else decides permissions. The pure checks
 * are exported so the door tests' fake engine runs the same rules.
 */
import { z } from "zod";
import { usedUpWarning } from "../core/budget.js";
import type { AuditTarget, Principal } from "../core/context.js";
import type { CallOptions } from "../core/engine.js";
import type { AuditStatus } from "../core/enums.js";
import {
  forbidden,
  isOpenOutboundError,
  OpenOutboundError,
  toOpenOutboundError,
} from "../core/errors.js";
import { ID_PREFIX, isId } from "../core/ids.js";
import { type AnyOperation, operationScopes, RESERVED_INPUT_FIELDS } from "../core/operation.js";
import type { Workspace } from "../db/schema/index.js";
import { createAuditLog } from "./audit.js";
import { createOpContext } from "./context.js";
import {
  claimIdempotency,
  completeIdempotency,
  type IdempotencyTarget,
  releaseIdempotency,
  requestHash,
} from "./idempotency.js";
import type { Kernel } from "./kernel.js";
import { stripOneTimeSecrets } from "./redact.js";
import { unknownOperation } from "./registry.js";
import { createUsageMeter } from "./usage.js";
import {
  assertWorkspacePolicy,
  bindPrincipal,
  dbWorkspaceLookup,
  resolveWorkspace,
} from "./workspace-resolution.js";

const commonFieldsSchema = z.object({
  workspace: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  dry_run: z.boolean().nullable().optional(),
  idempotency_key: z.string().min(1).max(200).nullable().optional(),
  response_format: z.enum(["concise", "detailed"]).nullable().optional(),
});

const PREFIX_TYPES = new Map<string, string>(
  Object.entries(ID_PREFIX).map(([name, prefix]) => [
    prefix,
    name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  ]),
);

export interface Executor {
  call(operationId: string, input: unknown, options: CallOptions): Promise<unknown>;
}

export type CommonFields = z.infer<typeof commonFieldsSchema>;

/**
 * The executor's common fields (workspace, reason, dry_run, idempotency_key, response_format)
 * taken out of a call's input and validated, and the rest of the input. Throws
 * `validation_failed` like the executor.
 */
export function splitCommonFields(
  op: AnyOperation,
  raw: unknown,
): { fields: CommonFields; rest: Record<string, unknown> } {
  const { common, rest } = splitInput(raw);
  const parsed = commonFieldsSchema.safeParse(common);
  if (!parsed.success) throw inputError(op, parsed.error);
  return { fields: parsed.data, rest };
}

function splitInput(raw: unknown): {
  common: Record<string, unknown>;
  rest: Record<string, unknown>;
} {
  if (raw === undefined || raw === null) return { common: {}, rest: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new OpenOutboundError("validation_failed", "The input must be a JSON object.", {
      hint: 'Pass the fields as an object, e.g. { "limit": 10 }.',
    });
  }
  const common: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if ((RESERVED_INPUT_FIELDS as readonly string[]).includes(key)) common[key] = value;
    else rest[key] = value;
  }
  return { common, rest };
}

/** Throws `forbidden` naming the first scope of the operation the principal lacks. */
export function assertScopes(
  op: Pick<AnyOperation, "effect" | "scopes" | "forbiddenHint">,
  principal: Pick<Principal, "scopes">,
): void {
  for (const scope of operationScopes(op)) {
    if (!principal.scopes.includes(scope)) throw forbidden(scope, op.forbiddenHint);
  }
}

/**
 * Whether the call is a dry run. Read operations have nothing to preview and ignore the flag;
 * an operation without a preview refuses `dry_run: true` with `unsupported`, the same answer on
 * every door.
 */
export function dryRunFlag(
  op: Pick<AnyOperation, "id" | "effect" | "dryRun">,
  requested: boolean | undefined,
): boolean {
  if (op.effect === "read") return false;
  if (op.dryRun === "none") {
    if (requested === true) throw noDryRun(op);
    return false;
  }
  return requested ?? op.dryRun === "default";
}

/** The `unsupported` refusal for `dry_run: true` on an operation without a preview. */
export function noDryRun(op: Pick<AnyOperation, "id">): OpenOutboundError {
  return new OpenOutboundError("unsupported", `${op.id} has no dry run.`, {
    hint: "Call it without dry_run; check its inputs first with the matching list or get operation.",
    details: { operation: op.id, reason: "no_dry_run" },
  });
}

function inputError(op: AnyOperation, error: unknown): OpenOutboundError {
  const failure = toOpenOutboundError(error);
  const example = op.examples[0]?.input;
  return new OpenOutboundError("validation_failed", failure.message, {
    hint: example
      ? `Fix the listed fields. Example input for ${op.id}: ${JSON.stringify(example).slice(0, 300)}`
      : (failure.hint ?? "Fix the listed fields and try again."),
    ...(failure.details ? { details: failure.details } : {}),
    cause: error,
  });
}

/** A dry-run result with `warning` first among its warnings (unchanged when already there). */
function withFirstWarning(output: unknown, warning: string): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  if (record.dry_run !== true || !Array.isArray(record.warnings)) return output;
  if (record.warnings.includes(warning)) return output;
  return { ...record, warnings: [warning, ...record.warnings] };
}

function auditStatusOf(output: unknown, dryRun: boolean): AuditStatus {
  if (dryRun) return "dry_run";
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (record.dry_run === true) return "dry_run";
    if (record.status === "awaiting_approval") return "awaiting_approval";
  }
  return "ok";
}

/** Best-effort audit target: the record the output or the input is about. */
export function inferAuditTarget(output: unknown, input: unknown): AuditTarget | null {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    if (typeof record.approval_id === "string") return { type: "approval", id: record.approval_id };
    if (isId(record.id)) {
      const prefix = record.id.slice(0, record.id.lastIndexOf("_"));
      return { type: PREFIX_TYPES.get(prefix) ?? prefix, id: record.id };
    }
    if (typeof record.job_id === "string") return { type: "job", id: record.job_id };
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (key.endsWith("_id") && typeof value === "string") {
        return { type: key.slice(0, -3), id: value };
      }
    }
  }
  return null;
}

export function workspaceNotActive(
  workspace: Pick<Workspace, "slug" | "status">,
): OpenOutboundError {
  const archived = workspace.status === "archived";
  return new OpenOutboundError(
    "workspace_paused",
    archived
      ? `Workspace "${workspace.slug}" is archived; nothing can be sent from it.`
      : `Workspace "${workspace.slug}" is paused; sending is stopped.`,
    {
      hint: archived
        ? "Unarchive it with workspaces.update before sending."
        : "Resume it with manage_workspaces action resume (CLI: openoutbound workspaces resume) when it is safe to send again.",
      details: { workspace: workspace.slug, status: workspace.status },
    },
  );
}

export function createExecutor(kernel: Kernel): Executor {
  const { db, clock, log } = kernel;

  return {
    async call(operationId, rawInput, options) {
      const op = kernel.registry.operation(operationId);
      if (!op) {
        throw unknownOperation(
          operationId,
          kernel.registry.operations().map((candidate) => candidate.id),
        );
      }
      const given: Principal | undefined = options?.principal;
      if (!given) {
        throw new OpenOutboundError("unauthorized", "The call has no principal.", {
          hint: "Authenticate with an API key (Authorization: Bearer oo_...) or use a local principal.",
        });
      }
      // Narrowed below when the door binds the call to a session's workspace.
      let principal: Principal = given;

      let workspace: Workspace | null = null;
      let validatedInput: unknown;
      let restInput: Record<string, unknown> = {};
      let reason: string | undefined;
      let dryRun = false;

      const writeAudit = async (entry: {
        status: AuditStatus;
        output?: unknown;
        errorCode?: OpenOutboundError["code"];
        summary: string;
      }) => {
        if (op.effect === "read") return;
        const input = validatedInput ?? restInput;
        const fields =
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : null;
        const recorded = op.auditInput && fields ? op.auditInput(fields) : input;
        // The operation's own scrub of free text (reason, error message), from the input as sent.
        const text = (value: string) => (op.auditText ? op.auditText(value, restInput) : value);
        await createAuditLog(kernel, {
          workspaceId: workspace?.id ?? principal.workspaceId ?? null,
          principal,
        }).record({
          operation: op.id,
          effect: op.effect,
          status: entry.status,
          target: inferAuditTarget(entry.output, recorded),
          reason: reason ? text(reason) : null,
          summary: text(entry.summary).slice(0, 500),
          input: recorded,
          errorCode: entry.errorCode ?? null,
        });
      };

      try {
        const { fields, rest } = splitCommonFields(op, rawInput);
        restInput = rest;
        reason = (options.reason ?? fields.reason ?? undefined)?.slice(0, 500);
        const idempotencyKey = options.idempotencyKey ?? fields.idempotency_key ?? undefined;
        const responseFormat = options.responseFormat ?? fields.response_format ?? "concise";
        const requestedDryRun = options.dryRun ?? fields.dry_run ?? undefined;

        // A session bound to one workspace (mcp --workspace) narrows the principal first.
        const lookup = dbWorkspaceLookup(db);
        if (options.boundWorkspace?.trim()) {
          principal = await bindPrincipal(lookup, principal, options.boundWorkspace);
        }
        const caller: Principal = principal;

        // Workspace + access (a bound principal cannot leave its workspace, and instance-level
        // operations refuse it unless they allow bound principals).
        workspace = await resolveWorkspace(
          lookup,
          op.workspace,
          caller,
          options.workspace ?? fields.workspace ?? null,
        );
        assertWorkspacePolicy(op, caller);

        // Scopes.
        assertScopes(op, caller);

        // Input.
        const parsed = op.input.safeParse(rest);
        if (!parsed.success) throw inputError(op, parsed.error);
        validatedInput = parsed.data;

        // Dry-run flag (read ops have nothing to preview; ops without previews refuse).
        dryRun = dryRunFlag(op, requestedDryRun);

        // Idempotency lookup (dry runs are never stored).
        let idempotency: IdempotencyTarget | null = null;
        if (idempotencyKey && !dryRun) {
          idempotency = { scope: workspace?.id ?? "instance", key: idempotencyKey };
          const claim = await claimIdempotency(
            db,
            clock,
            idempotency,
            op.id,
            requestHash(op.id, rest),
          );
          if (claim.kind === "replay") return claim.response;
        }

        try {
          if (op.effect === "send" && workspace && workspace.status !== "active") {
            throw workspaceNotActive(workspace);
          }
          // Set when a dry run goes on although the real run would be refused here.
          let refusalWarning: string | null = null;
          if (op.effect === "spend" && workspace) {
            const meter = createUsageMeter(kernel, { workspaceId: workspace.id });
            try {
              await meter.assertBudget(workspace.id, "data");
            } catch (error) {
              // A dry run still returns its preview, with a warning that says why the real
              // run would be refused.
              if (!dryRun || !isOpenOutboundError(error) || error.code !== "budget_exceeded") {
                throw error;
              }
              refusalWarning = usedUpWarning(await meter.budgetStatus(workspace.id, "data"));
            }
          }
          if (options.signal?.aborted) {
            throw new OpenOutboundError("conflict", "The call was cancelled before it started.");
          }
          const ctx = createOpContext(kernel, {
            workspace,
            principal: caller,
            request: {
              dryRun,
              responseFormat,
              ...(reason ? { reason } : {}),
              ...(idempotencyKey ? { idempotencyKey } : {}),
            },
          });
          const result = await op.handler(ctx, validatedInput);
          let output: unknown;
          try {
            output = op.output.parse(result);
          } catch (error) {
            log.error({ err: error, operation: op.id }, "operation returned an invalid result");
            throw new OpenOutboundError("internal", `${op.id} returned an invalid result.`, {
              hint: "This is a bug in the operation; report it with the server log line.",
              cause: error,
            });
          }
          if (refusalWarning) output = withFirstWarning(output, refusalWarning);
          await writeAudit({ status: auditStatusOf(output, dryRun), output, summary: op.summary });
          if (idempotency) await completeIdempotency(db, idempotency, stripOneTimeSecrets(output));
          return output;
        } catch (error) {
          if (idempotency) {
            await releaseIdempotency(db, idempotency).catch((releaseError: unknown) =>
              log.error({ err: releaseError }, "releasing the idempotency key failed"),
            );
          }
          throw error;
        }
      } catch (error) {
        const failure = toOpenOutboundError(error);
        if (failure.code === "internal") {
          log.error({ err: error, operation: op.id }, "operation failed");
        }
        await writeAudit({
          status: "error",
          errorCode: failure.code,
          summary: `${failure.code}: ${failure.message}`,
        });
        throw failure;
      }
    },
  };
}
