/**
 * Sandbox social publisher: "publishes" a post by minting a fake example.com URL. Nothing is
 * sent anywhere.
 */
import type { ProviderRuntime, SocialPublisher } from "../../providers/types.js";
import { hashSeed } from "../world/rng.js";

export function createSandboxSocial(ctx: ProviderRuntime): SocialPublisher {
  return {
    id: "sandbox",
    async publish(input) {
      const externalId = `sbx_post_${hashSeed(input.text).toString(36)}_${ctx.clock.now().getTime().toString(36)}`;
      return { externalId, url: `https://posts.example.com/${externalId}` };
    },
  };
}
