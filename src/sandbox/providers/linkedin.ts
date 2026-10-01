/**
 * Sandbox linkedin provider: fake accounts acting on the world's fake profiles. Invites are
 * accepted after a short simulated delay for about 35% of people (deterministic per person);
 * about half of people have a recent post. Relation state is read from `linkedin_relations`
 * (written by the linkedin module when it calls sendInvite), which sandbox providers may read
 * via `ctx.db`.
 */
import { and, eq } from "drizzle-orm";
import { OpenOutboundError } from "../../core/errors.js";
import { linkedin_accounts, linkedin_relations, people } from "../../db/schema/index.js";
import type {
  LinkedInInboundMessage,
  LinkedInPost,
  LinkedInProfile,
  LinkedInProvider,
  LinkedInTarget,
  ProviderRuntime,
} from "../../providers/types.js";
import { allPeople, findCompanyByDomain } from "../world/index.js";
import { hashBool, hashRatio, hashSeed } from "../world/rng.js";

/**
 * Simulated time between sending an invite and it being accepted (for the ~35% who accept).
 * Exported so the prospect simulator (src/sandbox/simulator/**) can agree on the same
 * acceptance decision instead of re-deriving its own rate and drifting from this provider.
 */
export const ACCEPT_DELAY_MS = 10 * 60_000;
export const ACCEPT_RATE = 0.35;
const HAS_POST_RATE = 0.5;

const PERSON_BY_LINKEDIN_URL = new Map(allPeople().map((p) => [p.linkedin_url, p]));

function providerIdFor(profileUrl: string): string {
  return `sbx_li_${hashSeed(profileUrl).toString(36)}`;
}

async function resolveAccountRowId(
  ctx: ProviderRuntime,
  externalAccountId: string,
): Promise<string | null> {
  if (!ctx.workspaceId) return null;
  const [row] = await ctx.db
    .select({ id: linkedin_accounts.id })
    .from(linkedin_accounts)
    .where(
      and(
        eq(linkedin_accounts.workspace_id, ctx.workspaceId),
        eq(linkedin_accounts.external_account_id, externalAccountId),
      ),
    );
  return row?.id ?? null;
}

async function resolvePersonRow(ctx: ProviderRuntime, profileUrl: string) {
  if (!ctx.workspaceId) return null;
  const [row] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.workspace_id, ctx.workspaceId), eq(people.linkedin_url, profileUrl)));
  return row ?? null;
}

function requireWorldPerson(target: LinkedInTarget) {
  const profileUrl = target.profile_url;
  const worldPerson = profileUrl ? PERSON_BY_LINKEDIN_URL.get(profileUrl) : undefined;
  if (!worldPerson) {
    throw new OpenOutboundError(
      "provider_error",
      `No sandbox LinkedIn profile for ${profileUrl ?? target.provider_id ?? "unknown target"}.`,
      { hint: "Use a profile_url returned by this sandbox's lead_source or linkedin search." },
    );
  }
  return worldPerson;
}

export function createSandboxLinkedIn(ctx: ProviderRuntime): LinkedInProvider {
  return {
    id: "sandbox",

    async getProfile(account: string, target: LinkedInTarget): Promise<LinkedInProfile> {
      const worldPerson = requireWorldPerson(target);
      const company = findCompanyByDomain(worldPerson.companyKey);
      const personRow = await resolvePersonRow(ctx, worldPerson.linkedin_url);
      const accountRowId = await resolveAccountRowId(ctx, account);
      let degree: 1 | 2 | null = 2;
      let invitationPending = false;
      if (accountRowId && personRow) {
        const [relation] = await ctx.db
          .select({ status: linkedin_relations.status })
          .from(linkedin_relations)
          .where(
            and(
              eq(linkedin_relations.account_id, accountRowId),
              eq(linkedin_relations.person_id, personRow.id),
            ),
          );
        if (relation?.status === "connected") degree = 1;
        if (relation?.status === "invited") invitationPending = true;
      }
      return {
        provider_id: providerIdFor(worldPerson.linkedin_url),
        profile_url: worldPerson.linkedin_url,
        public_identifier: worldPerson.linkedin_url.split("/").pop() ?? null,
        first_name: worldPerson.first_name,
        last_name: worldPerson.last_name,
        full_name: worldPerson.full_name,
        headline: worldPerson.title,
        location: `${worldPerson.city}, ${worldPerson.country}`,
        company: company?.name ?? null,
        title: worldPerson.title,
        connection_degree: degree,
        invitation_pending: invitationPending,
        premium: false,
      };
    },

    async visitProfile(): Promise<void> {
      // No state to record; a real provider would log a profile view.
    },

    async sendInvite(_account: string, target: LinkedInTarget, _note?: string) {
      const worldPerson = requireWorldPerson(target);
      return {
        providerRef: `sbx_inv_${ctx.clock.now().getTime().toString(36)}_${hashSeed(worldPerson.linkedin_url).toString(36)}`,
      };
    },

    async sendMessage(
      _account: string,
      target: LinkedInTarget,
      _text: string,
      options?: { chatId?: string },
    ) {
      const worldPerson = requireWorldPerson(target);
      const chatId =
        options?.chatId ?? `sbx_chat_${hashSeed(worldPerson.linkedin_url).toString(36)}`;
      return { messageId: `sbx_msg_${ctx.clock.now().getTime().toString(36)}`, chatId };
    },

    async listRecentPosts(
      _account: string,
      target: LinkedInTarget,
      options: { limit?: number } = {},
    ): Promise<LinkedInPost[]> {
      const worldPerson = requireWorldPerson(target);
      if (!hashBool(`post:${worldPerson.linkedin_url}`, HAS_POST_RATE)) return [];
      const daysAgo = 1 + Math.floor(hashRatio(`post_age:${worldPerson.linkedin_url}`) * 20);
      const publishedAt = new Date(ctx.clock.now().getTime() - daysAgo * 86_400_000).toISOString();
      const company = findCompanyByDomain(worldPerson.companyKey);
      const post: LinkedInPost = {
        id: `sbx_post_${hashSeed(worldPerson.linkedin_url).toString(36)}`,
        url: `https://www.linkedin.com/feed/update/sbx_post_${hashSeed(worldPerson.linkedin_url).toString(36)}`,
        text:
          company && company.segment === "ecommerce"
            ? `Proud of how the team handled peak demand this quarter at ${company.name}. Forecasting the next one now.`
            : `Grateful for another great review from a patient this week at ${company?.name ?? "the practice"}.`,
        published_at: publishedAt,
        author_provider_id: providerIdFor(worldPerson.linkedin_url),
        reactions_count: 3 + Math.floor(hashRatio(`reactions:${worldPerson.linkedin_url}`) * 40),
        comments_count: Math.floor(hashRatio(`comments:${worldPerson.linkedin_url}`) * 8),
      };
      return options.limit ? [post].slice(0, options.limit) : [post];
    },

    async reactToPost(): Promise<void> {
      // No-op: sandbox does not track reactions given.
    },

    async commentOnPost(): Promise<{ commentId?: string }> {
      return { commentId: `sbx_comment_${ctx.clock.now().getTime().toString(36)}` };
    },

    async syncMessages() {
      return { messages: [] as LinkedInInboundMessage[], cursor: null };
    },

    async syncRelations(account: string) {
      const accountRowId = await resolveAccountRowId(ctx, account);
      if (!accountRowId) return { connections: [], cursor: null };
      const now = ctx.clock.now();
      const invited = await ctx.db
        .select({
          personId: linkedin_relations.person_id,
          invitedAt: linkedin_relations.invited_at,
        })
        .from(linkedin_relations)
        .where(
          and(
            eq(linkedin_relations.account_id, accountRowId),
            eq(linkedin_relations.status, "invited"),
          ),
        );

      const connections: Array<{
        provider_id: string;
        profile_url?: string | null;
        connected_at?: string | null;
      }> = [];
      for (const row of invited) {
        if (!row.invitedAt) continue;
        const elapsed = now.getTime() - row.invitedAt.getTime();
        if (elapsed < ACCEPT_DELAY_MS) continue;
        if (!hashBool(`accept:${row.personId}`, ACCEPT_RATE)) continue;
        const [personRow] = await ctx.db.select().from(people).where(eq(people.id, row.personId));
        if (!personRow?.linkedin_url) continue;
        connections.push({
          provider_id: providerIdFor(personRow.linkedin_url),
          profile_url: personRow.linkedin_url,
          connected_at: now.toISOString(),
        });
      }
      return { connections, cursor: null };
    },
  } satisfies LinkedInProvider;
}
