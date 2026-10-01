/**
 * Unipile publishing (slot social): creates a post on the connected LinkedIn account
 * (`POST /api/v1/posts`, multipart `account_id` + `text`). UNVERIFIED in the provider notes:
 * the response field is read defensively (`post_id`, then `id`, then `social_id`). A post whose
 * answer was lost (timeout, broken connection, 5xx) is `outcome_unknown`; one accepted without
 * an id is `malformed` with `details.accepted` (it was published).
 */
import { malformedFailure } from "../http.js";
import { unipileConfigSchema, unipileSecrets } from "../linkedin/unipile.js";
import { createUnipileClient, UNIPILE, type UnipileClient } from "../linkedin/unipile-client.js";
import { asRecord, str } from "../linkedin/unipile-mapping.js";
import { defineProvider, type SocialPublisher } from "../types.js";

export function createUnipileSocial(client: UnipileClient): SocialPublisher {
  return {
    id: "unipile",
    async publish(post) {
      const body = await client.request("POST", "/posts", {
        form: { account_id: post.accountRef.account_id, text: post.text },
        write: true,
        signal: post.signal,
      });
      const record = asRecord(body);
      const id = str(record.post_id) ?? str(record.id) ?? str(record.social_id);
      if (!id) throw malformedFailure(UNIPILE, "no post id", { write: true });
      const url = id.startsWith("urn:li:")
        ? `https://www.linkedin.com/feed/update/${id}/`
        : undefined;
      return url ? { externalId: id, url } : { externalId: id };
    },
  };
}

export const unipileSocialProvider = defineProvider({
  slot: "social",
  id: "unipile",
  name: "Unipile (LinkedIn posts)",
  description: "Publishes posts from a LinkedIn account connected through Unipile.",
  docsUrl: "https://developer.unipile.com/docs/linkedin",
  configSchema: unipileConfigSchema,
  secrets: unipileSecrets,
  create: ({ config, secrets, ctx }) =>
    createUnipileSocial(
      createUnipileClient({
        dsn: secrets.dsn ?? "",
        apiKey: secrets.api_key ?? "",
        fetch: ctx.fetch,
        timeoutMs: config.timeout_ms,
      }),
    ),
});
