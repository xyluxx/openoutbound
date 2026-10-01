/** Relation tracking between our LinkedIn accounts and people in the workspace. */
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import type { LinkedInRelationStatus } from "../../core/enums.js";
import type { Db } from "../../db/client.js";
import {
  type LinkedInAccount,
  type LinkedInRelation,
  linkedin_relations,
  people,
} from "../../db/schema/index.js";
import { normalizeLinkedinUrl } from "../../lib/web/extract.js";

export async function findRelation(
  db: Db,
  accountId: string,
  personId: string,
): Promise<LinkedInRelation | null> {
  const [row] = await db
    .select()
    .from(linkedin_relations)
    .where(
      and(eq(linkedin_relations.account_id, accountId), eq(linkedin_relations.person_id, personId)),
    );
  return row ?? null;
}

/** Creates or updates the relation row; only the given fields change on update. */
export async function upsertRelation(
  db: Db,
  input: {
    workspaceId: string;
    accountId: string;
    personId: string;
    status: LinkedInRelationStatus;
    invitedAt?: Date | null;
    connectedAt?: Date | null;
    withdrawnAt?: Date | null;
    providerRef?: string | null;
  },
): Promise<void> {
  const set: Partial<typeof linkedin_relations.$inferInsert> = { status: input.status };
  if (input.invitedAt !== undefined) set.invited_at = input.invitedAt;
  if (input.connectedAt !== undefined) set.connected_at = input.connectedAt;
  if (input.withdrawnAt !== undefined) set.withdrawn_at = input.withdrawnAt;
  if (input.providerRef) set.provider_ref = input.providerRef;
  await db
    .insert(linkedin_relations)
    .values({
      workspace_id: input.workspaceId,
      account_id: input.accountId,
      person_id: input.personId,
      status: input.status,
      invited_at: input.invitedAt ?? null,
      connected_at: input.connectedAt ?? null,
      withdrawn_at: input.withdrawnAt ?? null,
      provider_ref: input.providerRef ?? null,
    })
    .onConflictDoUpdate({
      target: [linkedin_relations.account_id, linkedin_relations.person_id],
      set,
    });
}

/**
 * Finds the person behind a LinkedIn member: first by the member id stored on a relation of
 * this account, then by the normalized profile URL. Null when the person is not in the workspace.
 */
export async function matchPerson(
  db: Db,
  account: Pick<LinkedInAccount, "id" | "workspace_id">,
  member: { provider_id?: string | null; profile_url?: string | null },
): Promise<string | null> {
  if (member.provider_id) {
    const [byRef] = await db
      .select({ person_id: linkedin_relations.person_id })
      .from(linkedin_relations)
      .where(
        and(
          eq(linkedin_relations.account_id, account.id),
          eq(linkedin_relations.provider_ref, member.provider_id),
        ),
      )
      .limit(1);
    if (byRef) return byRef.person_id;
  }
  const url = member.profile_url ? normalizeLinkedinUrl(member.profile_url) : null;
  if (url) {
    const [byUrl] = await db
      .select({ id: people.id })
      .from(people)
      .where(
        and(
          eq(people.workspace_id, account.workspace_id),
          isNotNull(people.linkedin_url),
          eq(people.linkedin_url, url),
        ),
      )
      .limit(1);
    if (byUrl) return byUrl.id;
  }
  return null;
}

/**
 * Marks a relation connected. Emits `linkedin.connected` only on the transition (one atomic
 * upsert), so repeated or concurrent webhooks and syncs stay silent.
 */
export async function markConnected(
  ctx: OpContext,
  account: Pick<LinkedInAccount, "id" | "workspace_id">,
  personId: string,
  options: { connectedAt?: Date; providerRef?: string | null } = {},
): Promise<boolean> {
  const connectedAt = options.connectedAt ?? ctx.clock.now();
  const providerRef = options.providerRef || null;
  const set: Partial<typeof linkedin_relations.$inferInsert> = {
    status: "connected",
    connected_at: connectedAt,
  };
  if (providerRef) set.provider_ref = providerRef;
  const changed = await ctx.db
    .insert(linkedin_relations)
    .values({
      workspace_id: account.workspace_id,
      account_id: account.id,
      person_id: personId,
      status: "connected",
      connected_at: connectedAt,
      provider_ref: providerRef,
    })
    .onConflictDoUpdate({
      target: [linkedin_relations.account_id, linkedin_relations.person_id],
      set,
      setWhere: ne(linkedin_relations.status, "connected"),
    })
    .returning({ person_id: linkedin_relations.person_id });
  if (changed.length === 0) {
    // Already connected: only fill in a missing member id.
    if (providerRef) {
      await ctx.db
        .update(linkedin_relations)
        .set({ provider_ref: providerRef })
        .where(
          and(
            eq(linkedin_relations.account_id, account.id),
            eq(linkedin_relations.person_id, personId),
            isNull(linkedin_relations.provider_ref),
          ),
        );
    }
    return false;
  }
  await ctx.events.emit("linkedin.connected", {
    workspaceId: account.workspace_id,
    subject: { type: "person", id: personId },
    data: { account_id: account.id, person_id: personId, connected_at: connectedAt.toISOString() },
  });
  return true;
}
