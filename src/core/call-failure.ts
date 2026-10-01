/**
 * The failure of one provider call, for per-item records: an enrichment step, a research search,
 * a monitor check, a sync, a notification. It is `failureOf` with the provider filled in. An
 * error that is not a provider failure (a bug, an answer of the wrong type) still gets a record,
 * so nothing that failed is ever stored as "nothing found": `unavailable` when retrying may
 * help (`isRetryable`), `refused` when it cannot.
 */
import { type Failure, failureOf, isRetryable, isRetryableClass } from "./failures.js";

export function callFailure(error: unknown, provider: string): Failure {
  const failure = failureOf(error);
  if (failure) return failure.provider ? failure : { ...failure, provider };
  const retryable = isRetryable(error);
  return { class: retryable ? "unavailable" : "refused", retryable, scope: "call", provider };
}

/**
 * Whether a failure reaches past the call that got it: the credentials, quota or rate limit of
 * the account, or the whole provider. The next calls to that provider in the same run would fail
 * the same way, so the run stops asking it.
 */
export function stopsProvider(failure: Failure): boolean {
  return failure.scope !== "call";
}

/**
 * Whether the provider did the work although the call failed: it answered, in a shape the
 * engine could not read (`malformed`), so the call is charged like a success. Every other
 * failure is free: the provider refused it, was not reached or did not answer in time.
 */
export function answeredDespiteFailure(failure: Failure): boolean {
  return failure.class === "malformed";
}

/**
 * Whether asking again later can succeed: the failure is temporary (timeout, network, server
 * error, rate limit) or about the account, which a person can fix (credentials, quota, plan).
 * A failure that only concerns this call and will repeat (not found, bad request, an answer the
 * engine cannot read, a refusal, an outcome that is not known) cannot.
 *
 * It follows the class, not `retryable`: a paid call that timed out or lost its connection is
 * `retryable: false` because the engine must not repeat it by itself (it may already have used
 * credits), yet the data it was asking for is still missing, so a monitor keeps its window and
 * a saved search its resume cursor for the next run.
 */
export function worthRetrying(failure: Failure): boolean {
  return isRetryableClass(failure.class) || failure.scope !== "call";
}
