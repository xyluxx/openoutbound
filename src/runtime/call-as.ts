/**
 * Runs a registered operation through the full safety gate from inside another operation.
 *
 * Only for applying change proposals (strategy module): a proposed change runs the named
 * operation as the proposer, so it passes principal, workspace, scopes, input validation,
 * idempotency, the paused check, budgets, the dry-run flag, the handler's own approvals and the
 * audit log exactly like a call from a door. There is no second action path.
 */
import type { OpContext } from "../core/context.js";
import type { CallOptions } from "../core/engine.js";
import type { AnyOperation } from "../core/operation.js";
import { kernelOf } from "./context.js";
import { createExecutor } from "./executor.js";

/**
 * Calls `operationId` with `input` through the executor. The context must come from the engine
 * (`createTestEngine` in tests); throws what the operation throws.
 */
export function callOperationAs(
  ctx: OpContext,
  operationId: string,
  input: unknown,
  options: CallOptions,
): Promise<unknown> {
  return createExecutor(kernelOf(ctx)).call(operationId, input, options);
}

/** The registered operation with this id, or undefined when no loaded module defines it. */
export function registeredOperation(ctx: OpContext, operationId: string): AnyOperation | undefined {
  return kernelOf(ctx).registry.operation(operationId);
}
