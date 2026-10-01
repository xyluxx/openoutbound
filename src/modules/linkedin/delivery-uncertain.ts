/**
 * Whether a failed call that may act on LinkedIn (an invitation, message, comment, like, visit
 * or post) may have reached it anyway. Shared by the LinkedIn action job and post publishing
 * (docs/concepts/delivery-guarantees.md).
 */
import { isOpenOutboundError } from "../../core/errors.js";
import { failureOf } from "../../core/failures.js";
import { neverConnected } from "../../providers/http.js";

/**
 * Whether a call that may act on LinkedIn may have reached it although it failed, so a retry
 * could do it twice. Read from the provider failure (`failureOf`, old and new error shapes):
 * answers that refuse before the action is taken (a rate limit, used up quota, rejected
 * credentials, a missing permission, not found, bad input, a policy refusal, a restricted or
 * disconnected account) did not act, and neither did a call that never left: one stopped before
 * it was sent (`details.not_sent`), or a timeout or network failure whose connection never
 * opened (refused, no DNS answer, connect timeout). Other timeouts, server errors (5xx, which may
 * come after LinkedIn acted), dropped connections, unreadable answers, an outcome the provider
 * itself calls unknown and anything that is not a provider failure may have.
 */
export function deliveryUncertain(error: unknown): boolean {
  if (isOpenOutboundError(error)) {
    const details = error.details ?? {};
    if (details.restricted === true || details.disconnected === true) return false;
    if (details.rateLimited === true) return false;
    if (details.not_sent === true) return false;
  }
  const failure = failureOf(error);
  // An engine error that is no provider failure (settings, validation) comes before any call.
  if (!failure) return !isOpenOutboundError(error);
  switch (failure.class) {
    case "rate_limited":
    case "quota_exhausted":
    case "auth_invalid":
    case "forbidden":
    case "not_found":
    case "bad_request":
    case "refused":
      return false;
    case "timeout":
    case "network":
      return !neverConnected(isOpenOutboundError(error) ? error.cause : error);
    default:
      return true;
  }
}
