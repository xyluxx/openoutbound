/** `{{booking_url}}` at send time: the offer's link or booking.default_url, tagged per person. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import { offers, people } from "../../db/schema/index.js";
import { createTestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCampaign, seedMailbox, seedMessage, seedPerson } from "../../testing/factories.js";
import { loadSendContext, templateVars } from "./message-context.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

const DEFAULT_URL = "https://calendly.com/helix/intro";

async function setup(
  settings: WorkspaceSettingsInput,
  body: string,
  offerUrl: string | null = null,
) {
  const ctx = await createTestContext({ db: testDb, settings });
  const person = await seedPerson(ctx, { first_name: "Dana" });
  const mailbox = await seedMailbox(ctx);
  let offerId: string | null = null;
  if (offerUrl) {
    const [offer] = await ctx.db
      .insert(offers)
      .values({ workspace_id: ctx.workspace.id, name: "Pilot", booking_url: offerUrl })
      .returning();
    offerId = offer?.id ?? null;
  }
  const { campaign } = await seedCampaign(ctx, { offer_id: offerId });
  const message = await seedMessage(ctx, {
    person_id: person.id,
    campaign_id: campaign.id,
    status: "scheduled",
    body_text: body,
  });
  const context = await loadSendContext(ctx, ctx.workspace, message);
  const [stored] = await ctx.db.select().from(people).where(eq(people.id, person.id));
  return { vars: templateVars(context, mailbox), ref: stored?.booking_ref ?? null };
}

describe("{{booking_url}} at send time", () => {
  it("is the default link tagged with the person's booking code", async () => {
    const { vars, ref } = await setup(
      { booking: { default_url: DEFAULT_URL } },
      "Pick a time here: {{ booking_url }}",
    );
    expect(ref).toMatch(/^bk[0-9a-z]{10}$/);
    expect(vars.booking_url).toBe(`${DEFAULT_URL}?utm_content=${ref}&utm_source=openoutbound`);
  });

  it("prefers the offer's link and works in every booking mode", async () => {
    const { vars, ref } = await setup(
      { booking: { mode: "off", default_url: DEFAULT_URL } },
      "Pick a time here: {{booking_url|our calendar}}",
      "https://cal.com/helix/pilot",
    );
    expect(vars.booking_url).toBe(`https://cal.com/helix/pilot?metadata%5Boo_ref%5D=${ref}`);
  });

  it("gives nobody a booking code for messages without the variable, or with tagging off", async () => {
    const plain = await setup({ booking: { default_url: DEFAULT_URL } }, "No link in this one.");
    expect(plain.ref).toBeNull();
    const untagged = await setup(
      { booking: { default_url: DEFAULT_URL, tag_links: false } },
      "Pick a time here: {{booking_url}}",
    );
    expect(untagged.ref).toBeNull();
    expect(untagged.vars.booking_url).toBe(DEFAULT_URL);
  });

  it("stays empty without any link, as before", async () => {
    const { vars } = await setup({}, "Pick a time here: {{booking_url}}");
    expect(vars.booking_url).toBeNull();
  });
});
