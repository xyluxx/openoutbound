/**
 * Registers realistic, deterministic sandbox answers for every prompt id in the app, so sandbox
 * workspaces (which always run on the fake brain, src/providers/brain/fake.ts) see plausible
 * campaign previews, reply classifications, briefs and reports instead of the fake brain's
 * fallback: the smallest schema-valid sample.
 *
 * Call `registerSandboxBrainAnswers()` once, at sandbox module load (src/modules/sandbox/index.ts).
 * `setFakeBrainAnswer` only fills in an answer used when neither a test's own
 * `ctx.brain.on(...)` nor a later call to this function registered one for that prompt id, so
 * registering here never overrides what a test sets up for itself.
 */

import {
  checkPrompt,
  fillSlotsPrompt,
  teachPrompt,
  writeEmailPrompt,
  writeLinkedInPrompt,
} from "../../modules/campaigns/writing/prompts.js";
import { draftPostPrompt } from "../../modules/content/prompts/draft-post.js";
import { teamExtractionPrompt } from "../../modules/enrichment/prompts/team.js";
import { checkReplyPrompt } from "../../modules/inbox/prompts/check.js";
import { classifyReplyPrompt } from "../../modules/inbox/prompts/classify.js";
import { draftReplyPrompt } from "../../modules/inbox/prompts/draft.js";
import { promisesPrompt } from "../../modules/inbox/prompts/promises.js";
import { bootstrapPrompt } from "../../modules/knowledge/prompts/bootstrap.js";
import { icpRefinePrompt } from "../../modules/leads/prompts/icp-refine.js";
import { importMappingPrompt } from "../../modules/leads/prompts/import-mapping.js";
import { reportSummaryPrompt } from "../../modules/reports/prompts/summary.js";
import { briefPrompt } from "../../modules/research/prompts/brief.js";
import { classifyItems } from "../../modules/signals/prompts/classify-items.js";
import { classifyWebsiteChange } from "../../modules/signals/prompts/classify-website-change.js";
import { evaluateCustomSignal } from "../../modules/signals/prompts/evaluate-custom.js";
import { setFakeBrainAnswer } from "../../providers/brain/fake.js";
import { buildClassifyAnswer, buildDraftAnswer, buildReplyCheckAnswer } from "./inbox-answers.js";
import {
  buildDraftPostAnswer,
  buildIcpRefineAnswer,
  buildImportMappingAnswer,
  buildReportSummaryAnswer,
  buildTeamExtractionAnswer,
} from "./misc-answers.js";
import { buildPromisesAnswer } from "./promise-answers.js";
import { buildBootstrapAnswer, buildBriefAnswer } from "./research-answers.js";
import {
  buildClassifyItemsAnswer,
  buildClassifyWebsiteChangeAnswer,
  buildEvaluateCustomAnswer,
} from "./signals-answers.js";
import {
  buildEmailCheckAnswer,
  buildFillSlotsAnswer,
  buildTeachAnswer,
  buildWriteEmailAnswer,
  buildWriteLinkedInAnswer,
} from "./writing-answers.js";

let registered = false;

/** Idempotent: safe to call more than once (module re-imports, repeated engine boots). */
export function registerSandboxBrainAnswers(): void {
  if (registered) return;
  registered = true;

  setFakeBrainAnswer(writeEmailPrompt.id, buildWriteEmailAnswer);
  setFakeBrainAnswer(writeLinkedInPrompt.id, buildWriteLinkedInAnswer);
  setFakeBrainAnswer(fillSlotsPrompt.id, buildFillSlotsAnswer);
  setFakeBrainAnswer(checkPrompt.id, buildEmailCheckAnswer);
  setFakeBrainAnswer(teachPrompt.id, buildTeachAnswer);

  setFakeBrainAnswer(classifyReplyPrompt.id, buildClassifyAnswer);
  setFakeBrainAnswer(draftReplyPrompt.id, buildDraftAnswer);
  setFakeBrainAnswer(checkReplyPrompt.id, buildReplyCheckAnswer);
  setFakeBrainAnswer(promisesPrompt.id, buildPromisesAnswer);

  setFakeBrainAnswer(briefPrompt.id, buildBriefAnswer);
  setFakeBrainAnswer(bootstrapPrompt.id, buildBootstrapAnswer);

  setFakeBrainAnswer(classifyItems.id, buildClassifyItemsAnswer);
  setFakeBrainAnswer(classifyWebsiteChange.id, buildClassifyWebsiteChangeAnswer);
  setFakeBrainAnswer(evaluateCustomSignal.id, buildEvaluateCustomAnswer);

  setFakeBrainAnswer(reportSummaryPrompt.id, buildReportSummaryAnswer);
  setFakeBrainAnswer(draftPostPrompt.id, buildDraftPostAnswer);
  setFakeBrainAnswer(importMappingPrompt.id, buildImportMappingAnswer);
  setFakeBrainAnswer(icpRefinePrompt.id, buildIcpRefineAnswer);
  setFakeBrainAnswer(teamExtractionPrompt.id, buildTeamExtractionAnswer);
}
