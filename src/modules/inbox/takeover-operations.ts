/** threads.take_over and threads.release: who answers a thread, a person or the engine. */
import { z } from "zod";
import { MESSAGE_ACTIONS, MESSAGE_STATUSES, THREAD_OWNERS } from "../../core/enums.js";
import { idSchema } from "../../core/ids.js";
import { defineOperation, dryRun, dryRunOutput } from "../../core/operation.js";
import { requireThread } from "./reply-context.js";
import { threadSummary } from "./schemas.js";
import { unsentForThread } from "./stale-replies.js";
import { releaseThread, takeOverThread } from "./takeover.js";
import { summaryOf } from "./thread-operations.js";

const EXAMPLE_THREAD_ID = "thr_01k6a3v0q8x3m2n4p5r6s7t8v9";

const takeOverPreview = z.object({
  thread_id: z.string(),
  owner: z.enum(THREAD_OWNERS).describe("Current owner"),
  would_cancel: z
    .array(
      z.object({
        id: z.string(),
        status: z.enum(MESSAGE_STATUSES),
        action: z.enum(MESSAGE_ACTIONS),
      }),
    )
    .describe("Unsent engine messages of the thread that taking it over cancels"),
});

export const takeOverThreadOp = defineOperation({
  id: "threads.take_over",
  summary: "Take a thread over so the engine stops writing in it",
  description:
    "Marks a thread as answered by a person: the engine cancels its unsent messages in the thread (drafts, pending reviews, approved and scheduled replies) with their approvals, stops the person's running sequences, and makes no AI draft or automatic reply while the person owns it. Use it when you or your user will answer this conversation yourselves; replies written from the mailbox itself are found in its Sent folder and take the thread over on their own. Use the release action to hand the thread back. Classification, stop rules and the attention flag keep running, and reply_to_thread action send still sends an explicit reply.",
  effect: "write",
  input: z.object({ thread_id: idSchema("thr") }),
  output: z.union([
    threadSummary.extend({
      changed: z.boolean().describe("False when a person already owned the thread"),
      cancelled: z.number().int().describe("Unsent engine messages cancelled in the thread"),
    }),
    dryRunOutput(takeOverPreview),
  ]),
  http: { method: "POST", path: "/v1/threads/:thread_id/take_over" },
  dryRun: "supported",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Answer a thread yourself", input: { thread_id: EXAMPLE_THREAD_ID } }],
  handler: async (ctx, input) => {
    const thread = await requireThread(ctx, input.thread_id);
    if (ctx.request.dryRun) {
      const pending = await unsentForThread(ctx, thread.id);
      return dryRun(
        { thread_id: thread.id, owner: thread.owner, would_cancel: pending },
        {
          warnings: thread.owner === "person" ? ["A person already owns this thread."] : [],
        },
      );
    }
    const result = await takeOverThread(ctx, thread.id, { reason: "take_over" });
    return { ...(await summaryOf(ctx, thread.id)), ...result };
  },
});

export const releaseThreadOp = defineOperation({
  id: "threads.release",
  summary: "Hand a thread back to the engine",
  description:
    "Hands a thread a person took over back to the engine: the next message from the prospect is classified, drafted and, where the reply rules allow, answered automatically again. Use it when the person is done with the conversation and the engine should carry on. Nothing is sent right away, and sequences that stopped when the thread was taken over stay stopped; enroll the person again with enroll_leads if needed. Use the take_over action for the opposite.",
  effect: "write",
  input: z.object({ thread_id: idSchema("thr") }),
  output: threadSummary.extend({
    changed: z.boolean().describe("False when the engine already owned the thread"),
  }),
  http: { method: "POST", path: "/v1/threads/:thread_id/release" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Hand a thread back", input: { thread_id: EXAMPLE_THREAD_ID } }],
  handler: async (ctx, input) => {
    const thread = await requireThread(ctx, input.thread_id);
    const result = await releaseThread(ctx, thread.id);
    return { ...(await summaryOf(ctx, thread.id)), ...result };
  },
});

export const takeoverOperations = [takeOverThreadOp, releaseThreadOp];
