/**
 * Programmatic API: `createEngine()` plus the stable contracts for writing modules, providers
 * and webhook receivers.
 *
 *   import { createEngine } from "openoutbound";
 *   const engine = await createEngine({ worker: true });
 *   const principal = engine.localPrincipal("admin", "cli");
 *   await engine.call("workspaces.status", {}, { principal, workspace: "acme" });
 */
export {
  definePrompt,
  type PromptDefinition,
  UNTRUSTED_CONTENT_RULE,
  wrapUntrusted,
} from "./brain/prompt.js";
export { type EngineConfig, loadConfig } from "./core/config.js";
export * from "./core/context.js";
export type {
  CallOptions,
  CreateEngine,
  CreateEngineOptions,
  Engine,
  Registry,
} from "./core/engine.js";
export * from "./core/enums.js";
export * from "./core/errors.js";
export { EVENT_TYPES, type EventData, type EventType, onEvent } from "./core/events.js";
export { ID_PREFIX, idSchema, isId, newId } from "./core/ids.js";
export * from "./core/operation.js";
export {
  type CampaignSettings,
  campaignSettingsSchema,
  parseCampaignSettings,
  parseStepConfig,
  parseWorkspaceSettings,
  type StepConfig,
  stepConfigSchema,
  type WorkspaceSettings,
  workspaceSettingsSchema,
} from "./core/settings.js";
export { VERSION } from "./core/version.js";
export { modules } from "./modules/index.js";
export { defineProvider } from "./providers/types.js";
export { createEngine, type RuntimeEngine } from "./runtime/create-engine.js";
export { type NotifyInput, notify } from "./runtime/notify.js";
export { assertValidCron, nextRunAt, saveSchedule } from "./runtime/scheduler.js";
export {
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from "./runtime/webhooks.js";
