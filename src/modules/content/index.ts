import { defineTool, type EngineModule } from "../../core/operation.js";
import { postApprovalResolver } from "./approval.js";
import { linkedinOAuthRoutes } from "./oauth.js";
import { contentOperations } from "./operations.js";
import { publishDueJob } from "./publish-job.js";

export const managePosts = defineTool({
  name: "manage_posts",
  title: "LinkedIn posts",
  description:
    "Drafts, reviews and publishes LinkedIn posts for the user's own profile, written by AI from the knowledge base, content pillars and voice samples. Actions: list, draft (AI drafts saved as drafts), update (edit text, pillar, account, time), schedule (future time; approval by default), publish (now; approval by default), cancel (back to draft), resolve_unknown (settle a post whose publish got no clear answer: published, republish or cancel), accounts (posting accounts), connect_account (LinkedIn OAuth link for the official API). Posts from agents always wait for human approval (review_items). Not for outreach: comments on prospects' posts are campaign steps.",
  toolset: "content",
  actions: {
    list: "posts.list",
    draft: "posts.draft",
    update: "posts.update",
    schedule: "posts.schedule",
    publish: "posts.publish",
    cancel: "posts.cancel",
    resolve_unknown: "posts.resolve_unknown",
    accounts: "posts.accounts.list",
    connect_account: "posts.accounts.connect",
  },
});

export const module: EngineModule = {
  name: "content",
  operations: contentOperations,
  tools: [managePosts],
  jobs: [publishDueJob],
  schedules: [
    {
      name: "content.publish_due",
      cron: "*/5 * * * *",
      job: "content.publish_due",
      perWorkspace: true,
    },
  ],
  approvalResolvers: [postApprovalResolver],
  httpRoutes: [linkedinOAuthRoutes],
};
