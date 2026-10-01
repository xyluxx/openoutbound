/**
 * Deterministic reply checks: links must be the booking link or our website as whole URLs
 * (the booking tag may differ), never a longer link that only starts with an allowed one.
 */
import { describe, expect, it } from "vitest";
import { checkReplyText } from "./checks.js";
import { allowedLinkKeys, linkKey, linksIn } from "./link-match.js";

const PLAIN = "https://calendly.com/helix-example/intro";
const TAGGED = `${PLAIN}?utm_content=bkdana000001&utm_source=openoutbound`;
const WEBSITE = "https://helix.example.org";

function unknownLinks(body: string, allowedLinks = [TAGGED, PLAIN, WEBSITE]): string[] {
  return checkReplyText({ body, maxWords: 90, allowedLinks, grounding: "" })
    .filter((issue) => issue.code === "unknown_link")
    .map((issue) => issue.message);
}

describe("linkKey", () => {
  it("ignores case, trailing punctuation, trailing slashes and parameter order", () => {
    expect(linkKey("HTTPS://Calendly.com/Helix-Example/Intro/.")).toBe(linkKey(PLAIN));
    expect(linkKey(`${PLAIN}?b=2&a=1`)).toBe(linkKey(`${PLAIN}?a=1&b=2`));
    expect(linkKey("mailto:dana@example.com")).toBeNull();
    expect(linkKey("not a link")).toBeNull();
  });

  it("leaves the booking tag out only when asked", () => {
    expect(linkKey(TAGGED, { ignoreTag: true })).toBe(linkKey(PLAIN));
    expect(linkKey(TAGGED)).not.toBe(linkKey(PLAIN));
    const calcom = "https://cal.com/helix-example/20min?duration=30";
    expect(linkKey(`${calcom}&metadata%5Boo_ref%5D=bkdana000001`, { ignoreTag: true })).toBe(
      linkKey(calcom),
    );
    // The user's own utm_content is part of the link.
    expect(linkKey(`${PLAIN}?utm_content=newsletter`, { ignoreTag: true })).not.toBe(
      linkKey(PLAIN),
    );
  });

  it("finds links in text and allows both forms of a website saved without a scheme", () => {
    expect(linksIn(`Pick a slot: ${TAGGED}. Or see ${WEBSITE}/pricing!`)).toEqual([
      `${TAGGED}.`,
      `${WEBSITE}/pricing!`,
    ]);
    expect(allowedLinkKeys(["helix.example.org", " ", PLAIN])).toEqual([
      "https://helix.example.org",
      "http://helix.example.org",
      "https://calendly.com/helix-example/intro",
    ]);
  });
});

describe("checkReplyText links", () => {
  it("allows the booking link, tagged or plain, and the website", () => {
    expect(unknownLinks(`Grab a slot here: ${TAGGED}.`)).toEqual([]);
    expect(unknownLinks(`Grab a slot here: ${PLAIN}/`)).toEqual([]);
    expect(unknownLinks(`More at ${WEBSITE}/ and ${WEBSITE}.`)).toEqual([]);
    expect(unknownLinks("More at http://helix.example.org", ["helix.example.org"])).toEqual([]);
  });

  it("flags a longer link that only starts with an allowed one", () => {
    expect(unknownLinks("Book at https://calendly.com/helix-example/intro-other")).toHaveLength(1);
    expect(unknownLinks(`Book at ${PLAIN}/extra`)).toHaveLength(1);
    expect(unknownLinks(`Book at ${PLAIN}?next=https://tracker.example.net`)).toHaveLength(1);
    expect(unknownLinks("See https://helix.example.org.tracker.example.net/offer")).toEqual([
      "The link https://helix.example.org.tracker.example.net/offer is not the booking link or our website.",
    ]);
    expect(unknownLinks(`See ${WEBSITE}/pricing`)).toHaveLength(1);
    expect(unknownLinks(`See ${WEBSITE}#pricing`)).toHaveLength(1);
  });

  it("flags every link when none is allowed", () => {
    expect(unknownLinks(`Grab a slot here: ${PLAIN}`, [])).toHaveLength(1);
  });
});
