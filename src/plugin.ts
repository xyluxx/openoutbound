/**
 * `openoutbound/plugin`: everything a provider plug-in author needs.
 *
 *   import { defineProvider, providerFailure, providerSignal } from "openoutbound/plugin";
 */
export type { Clock } from "./core/clock.js";
export type { SafeFetch, SafeFetchInit } from "./core/context.js";
export { EMAIL_STATUSES, MODEL_TIERS } from "./core/enums.js";
export {
  type ErrorCode,
  isOpenOutboundError,
  JobWaitError,
  OpenOutboundError,
  type OpenOutboundErrorOptions,
} from "./core/errors.js";
export {
  classifyFetchError,
  classifyHttpStatus,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  FAILURE_CLASSES,
  type Failure,
  type FailureClass,
  type FailureScope,
  failureOf,
  isFetchError,
  isRetryable,
  type PartialResult,
  type ProviderFailureInput,
  parseRetryAfter,
  providerFailure,
  providerSignal,
  retryAfterOf,
} from "./core/failures.js";
export type { Logger } from "./core/logger.js";
export { createProviderCatalog, findProvider, providersForSlot } from "./providers/registry.js";
export * from "./providers/types.js";
