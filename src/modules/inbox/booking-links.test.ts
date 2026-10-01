import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import { people } from "../../db/schema/index.js";
import { createTestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedPerson } from "../../testing/factories.js";
import {
  assignBookingRef,
  bookingLinkFor,
  bookingRefFromUrl,
  ensureBookingRef,
  findPersonByBookingRef,
  isBookingRef,
  newBookingRef,
  tagBookingUrl,
} from "./booking-links.js";

const REF = "bk0123456789";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

describe("tagBookingUrl", () => {
  it("adds utm_content and utm_source to Calendly links", () => {
    expect(tagBookingUrl("https://calendly.com/helix-example/intro", REF)).toBe(
      `https://calendly.com/helix-example/intro?utm_content=${REF}&utm_source=openoutbound`,
    );
    expect(tagBookingUrl("https://eu.calendly.com/helix-example/intro", REF)).toBe(
      `https://eu.calendly.com/helix-example/intro?utm_content=${REF}&utm_source=openoutbound`,
    );
  });

  it("keeps an existing query exactly as written, and the fragment", () => {
    expect(tagBookingUrl("https://calendly.com/helix-example/intro?month=2026-10#top", REF)).toBe(
      `https://calendly.com/helix-example/intro?month=2026-10&utm_content=${REF}&utm_source=openoutbound#top`,
    );
    expect(tagBookingUrl("https://calendly.com/helix-example/intro?name=Dana%20Reyes", REF)).toBe(
      `https://calendly.com/helix-example/intro?name=Dana%20Reyes&utm_content=${REF}&utm_source=openoutbound`,
    );
    expect(tagBookingUrl("https://calendly.com/helix-example/intro?", REF)).toBe(
      `https://calendly.com/helix-example/intro?utm_content=${REF}&utm_source=openoutbound`,
    );
  });

  it("keeps the user's utm_source and never overrides utm_content", () => {
    expect(tagBookingUrl("https://calendly.com/helix-example/intro?utm_source=site", REF)).toBe(
      `https://calendly.com/helix-example/intro?utm_source=site&utm_content=${REF}`,
    );
    const own = "https://calendly.com/helix-example/intro?utm_content=newsletter";
    expect(tagBookingUrl(own, REF)).toBe(own);
  });

  it("replaces another lead's code in a pasted Calendly link and is idempotent", () => {
    // A link copied from a reply sent to someone else carries that person's code.
    const pasted =
      "https://calendly.com/helix-example/intro?utm_content=bkzzzzzzzzzz&utm_source=openoutbound";
    const tagged = tagBookingUrl(pasted, REF);
    expect(tagged).toBe(
      `https://calendly.com/helix-example/intro?utm_source=openoutbound&utm_content=${REF}`,
    );
    expect(bookingRefFromUrl(tagged)).toBe(REF);
    expect(tagBookingUrl(tagged, REF)).toBe(tagged);
    const once = tagBookingUrl("https://calendly.com/helix-example/intro", REF);
    expect(tagBookingUrl(once, REF)).toBe(once);
    expect(
      tagBookingUrl("https://calendly.com/helix-example/intro?utm_content=BKZZZZZZZZZZ#top", REF),
    ).toBe(
      `https://calendly.com/helix-example/intro?utm_content=${REF}&utm_source=openoutbound#top`,
    );
  });

  it("sets metadata[oo_ref] on Cal.com links with encoded brackets", () => {
    for (const host of ["cal.com", "app.cal.com", "team.cal.com"]) {
      expect(tagBookingUrl(`https://${host}/helix-example/20min`, REF)).toBe(
        `https://${host}/helix-example/20min?metadata%5Boo_ref%5D=${REF}`,
      );
    }
    expect(tagBookingUrl("https://cal.com/helix-example/20min?duration=30#slots", REF)).toBe(
      `https://cal.com/helix-example/20min?duration=30&metadata%5Boo_ref%5D=${REF}#slots`,
    );
  });

  it("replaces an older Cal.com code and is idempotent", () => {
    const once = tagBookingUrl("https://cal.com/helix-example/20min?duration=30", REF);
    expect(tagBookingUrl(once, REF)).toBe(once);
    const other = tagBookingUrl(once, "bkzzzzzzzzzz");
    expect(other).toBe(
      "https://cal.com/helix-example/20min?duration=30&metadata%5Boo_ref%5D=bkzzzzzzzzzz",
    );
    expect(
      tagBookingUrl("https://cal.com/helix-example/20min?metadata[oo_ref]=bkaaaaaaaaaa&x=1", REF),
    ).toBe(`https://cal.com/helix-example/20min?x=1&metadata%5Boo_ref%5D=${REF}`);
  });

  it("leaves other hosts, look-alike hosts, other schemes and bad URLs alone", () => {
    for (const url of [
      "https://cal.example.org/helix/intro",
      "https://savvycal.com/helix/intro",
      "https://notcalendly.com/helix",
      "https://calendly.com.example.org/helix",
      "https://evilcal.com/helix",
      "mailto:sam@example.org",
      "not a url",
      "",
    ]) {
      expect(tagBookingUrl(url, REF)).toBe(url);
    }
  });

  it("reads the code back from tagged links", () => {
    expect(bookingRefFromUrl(tagBookingUrl("https://calendly.com/helix-example/intro", REF))).toBe(
      REF,
    );
    expect(bookingRefFromUrl(tagBookingUrl("https://app.cal.com/helix-example/20min", REF))).toBe(
      REF,
    );
    expect(
      bookingRefFromUrl("https://calendly.com/helix-example/intro?utm_content=newsletter"),
    ).toBe(null);
    expect(bookingRefFromUrl("https://cal.example.org/helix?utm_content=bk0123456789")).toBeNull();
    expect(bookingRefFromUrl("nope")).toBeNull();
  });
});

describe("booking references", () => {
  it("creates bk + 10 base32 characters once and keeps it", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await seedPerson(ctx);
    const ref = await ensureBookingRef(ctx, person.id);
    expect(ref).toMatch(/^bk[0-9a-hjkmnp-tv-z]{10}$/);
    expect(isBookingRef(ref)).toBe(true);
    expect(await ensureBookingRef(ctx, person.id)).toBe(ref);
    const [row] = await ctx.db.select().from(people).where(eq(people.id, person.id));
    expect(row?.booking_ref).toBe(ref);
    expect(new Set(Array.from({ length: 200 }, newBookingRef)).size).toBe(200);
  });

  it("draws a new code when the random one is taken in the workspace", async () => {
    const ctx = await createTestContext({ db: testDb });
    const holder = await seedPerson(ctx, { booking_ref: "bktaken00000" });
    const person = await seedPerson(ctx);
    const draws = ["bktaken00000", "bktaken00000", "bkfree000000"];
    const ref = await assignBookingRef(ctx, ctx.workspace.id, person.id, () => draws.shift() ?? "");
    expect(ref).toBe("bkfree000000");
    expect(await findPersonByBookingRef(ctx, "bktaken00000")).toBe(holder.id);
    expect(await findPersonByBookingRef(ctx, "BKFREE000000")).toBe(person.id);
  });

  it("gives up after repeated collisions instead of looping", async () => {
    const ctx = await createTestContext({ db: testDb });
    await seedPerson(ctx, { booking_ref: "bkdupe000000" });
    const person = await seedPerson(ctx);
    await expect(
      assignBookingRef(ctx, ctx.workspace.id, person.id, () => "bkdupe000000"),
    ).rejects.toThrow(/no unique booking reference/);
  });

  it("allows the same code in another workspace and never finds across workspaces", async () => {
    const a = await createTestContext({ db: testDb });
    const b = await createTestContext({ db: testDb });
    const inA = await seedPerson(a, { booking_ref: "bkshared0000" });
    const inB = await seedPerson(b, { booking_ref: "bkshared0000" });
    expect(await findPersonByBookingRef(a, "bkshared0000")).toBe(inA.id);
    expect(await findPersonByBookingRef(b, "bkshared0000")).toBe(inB.id);
    expect(await findPersonByBookingRef(a, "bkunknown000")).toBeNull();
    expect(await findPersonByBookingRef(a, "not-a-ref")).toBeNull();
    await expect(ensureBookingRef(a, inB.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("bookingLinkFor", () => {
  const CALENDLY = "https://calendly.com/helix-example/intro";
  async function setup(settings: WorkspaceSettingsInput = {}) {
    const ctx = await createTestContext({ db: testDb, settings });
    const person = await seedPerson(ctx);
    return { ctx, person };
  }

  it("tags the offer link for replies in link mode", async () => {
    const { ctx, person } = await setup();
    const url = await bookingLinkFor(ctx, {
      personId: person.id,
      offerUrl: CALENDLY,
      purpose: "reply",
    });
    const ref = await ensureBookingRef(ctx, person.id);
    expect(url).toBe(`${CALENDLY}?utm_content=${ref}&utm_source=openoutbound`);
  });

  it("falls back to booking.default_url and returns null without any link", async () => {
    const withDefault = await setup({
      booking: { default_url: "https://cal.com/helix-example/30" },
    });
    const url = await bookingLinkFor(withDefault.ctx, {
      personId: withDefault.person.id,
      offerUrl: null,
      purpose: "reply",
    });
    expect(url).toMatch(/^https:\/\/cal\.com\/helix-example\/30\?metadata%5Boo_ref%5D=bk/);
    const none = await setup();
    expect(
      await bookingLinkFor(none.ctx, {
        personId: none.person.id,
        offerUrl: null,
        purpose: "reply",
      }),
    ).toBeNull();
  });

  it("gives replies no link in handoff and off modes, templates always get one", async () => {
    for (const mode of ["handoff", "off"] as const) {
      const { ctx, person } = await setup({ booking: { mode } });
      expect(
        await bookingLinkFor(ctx, { personId: person.id, offerUrl: CALENDLY, purpose: "reply" }),
      ).toBeNull();
      const template = await bookingLinkFor(ctx, {
        personId: person.id,
        offerUrl: CALENDLY,
        purpose: "template",
      });
      expect(template).toContain(`${CALENDLY}?utm_content=bk`);
    }
  });

  it("leaves links untagged when tagging is off, without a person or for other tools", async () => {
    const off = await setup({ booking: { tag_links: false } });
    expect(
      await bookingLinkFor(off.ctx, {
        personId: off.person.id,
        offerUrl: CALENDLY,
        purpose: "reply",
      }),
    ).toBe(CALENDLY);
    const [row] = await off.ctx.db.select().from(people).where(eq(people.id, off.person.id));
    expect(row?.booking_ref).toBeNull();

    const { ctx, person } = await setup();
    expect(
      await bookingLinkFor(ctx, { personId: null, offerUrl: CALENDLY, purpose: "template" }),
    ).toBe(CALENDLY);
    const other = "https://cal.example.org/helix/intro";
    expect(
      await bookingLinkFor(ctx, { personId: person.id, offerUrl: other, purpose: "reply" }),
    ).toBe(other);
    // No code is created for a link that cannot carry one.
    const [untouched] = await ctx.db.select().from(people).where(eq(people.id, person.id));
    expect(untouched?.booking_ref).toBeNull();
    // A person of another workspace (or a deleted one) gets the plain link.
    const stranger = await createTestContext({ db: testDb });
    const outsider = await seedPerson(stranger);
    expect(
      await bookingLinkFor(ctx, { personId: outsider.id, offerUrl: CALENDLY, purpose: "reply" }),
    ).toBe(CALENDLY);
  });
});
