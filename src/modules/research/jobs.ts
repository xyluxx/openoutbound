import { z } from "zod";
import { defineJob } from "../../core/operation.js";
import { type ResearchJobPayload, runResearchJob } from "./pipeline.js";
import { RESEARCH_JOB } from "./service.js";

const payload = z.object({
  company_id: z.string().nullable(),
  person_id: z.string().nullable(),
});

/** `research.run`: fills the pending briefs of one company (or one company-less person). */
export const researchJob = defineJob<ResearchJobPayload>({
  name: RESEARCH_JOB,
  payload,
  maxAttempts: 3,
  timeoutMs: 10 * 60_000,
  backoff: { type: "exponential", baseMs: 60_000, maxMs: 30 * 60_000 },
  handler: (ctx, input) => runResearchJob(ctx, input),
});
