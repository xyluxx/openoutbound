/**
 * Links the changes recorded while a proposal is applied, or while an undo runs, to that
 * proposal or undo. The functions that apply changes (workspace settings, offers, ICPs,
 * campaigns) call `recordChange` without knowing why they run; the scope set around the call
 * tells `recordChange` which proposal or undo the change belongs to.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface ChangeScope {
  /** Only changes of this workspace are linked. */
  workspaceId: string;
  proposalId?: string | null;
  /** The change an undo reverts. */
  undoOf?: string | null;
  /** Replaces the operation id the applying function records (an undo records "changes.undo"). */
  operation?: string | null;
  /** Changes recorded inside the scope, oldest first. */
  recorded: Array<{ changeId: string; version: number }>;
}

const storage = new AsyncLocalStorage<ChangeScope>();

/** Runs `fn` with `scope` visible to every `recordChange` call it makes, even after awaits. */
export function runInChangeScope<T>(scope: ChangeScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

/** The scope of the running proposal or undo, if any. */
export function currentChangeScope(): ChangeScope | undefined {
  return storage.getStore();
}
