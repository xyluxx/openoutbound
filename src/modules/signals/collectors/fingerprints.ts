/**
 * Lightweight technology fingerprints (a small, hand-picked subset in the spirit of
 * Wappalyzer): HTML, script src, meta generator, response headers, cookie names and DNS
 * MX / TXT records. Patterns are deliberately specific to avoid false positives.
 */
import { load } from "cheerio";

export type TechCategory =
  | "crm"
  | "marketing_automation"
  | "email_marketing"
  | "chat"
  | "support"
  | "scheduling"
  | "reviews"
  | "payments"
  | "ecommerce"
  | "email_hosting"
  | "email_security"
  | "email_delivery"
  | "analytics"
  | "ab_testing"
  | "advertising"
  | "cms"
  | "framework"
  | "hosting";

/** Categories worth a low-strength signal even without configured keywords. */
export const BUSINESS_CATEGORIES: ReadonlySet<TechCategory> = new Set([
  "crm",
  "marketing_automation",
  "email_marketing",
  "chat",
  "support",
  "scheduling",
  "reviews",
  "payments",
  "ecommerce",
  "email_hosting",
  "ab_testing",
]);

export interface Fingerprint {
  name: string;
  category: TechCategory;
  html?: RegExp[];
  script?: RegExp[];
  generator?: RegExp;
  headers?: Record<string, RegExp>;
  cookies?: RegExp[];
  mx?: RegExp[];
  txt?: RegExp[];
}

export const FINGERPRINTS: readonly Fingerprint[] = [
  {
    name: "HubSpot",
    category: "crm",
    script: [/js\.(hs-scripts|hsforms|hs-analytics|hubspot)\.(com|net)/i],
    cookies: [/^hubspotutk$/],
  },
  {
    name: "Salesforce",
    category: "crm",
    txt: [/include:_spf\.salesforce\.com/i],
    html: [/\.my\.salesforce\.com|salesforce\.com\/embeddedservice/i],
  },
  {
    name: "Pipedrive",
    category: "crm",
    script: [/leadbooster-chat\.pipedrive\.com|webforms\.pipedrive\.com/i],
  },
  {
    name: "Pardot",
    category: "marketing_automation",
    script: [/pi\.pardot\.com|go\.pardot\.com/i],
  },
  {
    name: "Marketo",
    category: "marketing_automation",
    script: [/munchkin\.marketo\.net/i],
    cookies: [/^_mkto_trk$/],
  },
  {
    name: "ActiveCampaign",
    category: "marketing_automation",
    script: [/trackcmp\.net|activehosted\.com/i],
  },
  {
    name: "Mailchimp",
    category: "email_marketing",
    script: [/chimpstatic\.com|list-manage\.com/i],
    txt: [/include:servers\.mcsv\.net/i],
  },
  { name: "Klaviyo", category: "email_marketing", script: [/static\.klaviyo\.com/i] },
  {
    name: "Intercom",
    category: "chat",
    script: [/widget\.intercom\.io|js\.intercomcdn\.com/i],
    cookies: [/^intercom-(id|session)-/],
  },
  { name: "Drift", category: "chat", script: [/js\.driftt\.com/i] },
  { name: "LiveChat", category: "chat", script: [/cdn\.livechatinc\.com/i] },
  { name: "Crisp", category: "chat", script: [/client\.crisp\.chat/i] },
  { name: "Tidio", category: "chat", script: [/code\.tidio\.co/i] },
  { name: "Podium", category: "chat", script: [/connect\.podium\.com|podium\.com\/widget/i] },
  {
    name: "Zendesk",
    category: "support",
    script: [/static\.zdassets\.com|\.zendesk\.com\/embeddable/i],
    txt: [/include:mail\.zendesk\.com/i],
  },
  {
    name: "Freshdesk",
    category: "support",
    script: [/widget\.freshworks\.com|freshdesk\.com\/widget/i],
  },
  { name: "Help Scout", category: "support", script: [/beacon-v2\.helpscout\.net/i] },
  {
    name: "Calendly",
    category: "scheduling",
    script: [/assets\.calendly\.com/i],
    html: [/calendly\.com\/[a-z0-9_-]+/i],
  },
  { name: "Acuity Scheduling", category: "scheduling", html: [/acuityscheduling\.com/i] },
  { name: "NexHealth", category: "scheduling", html: [/nexhealth\.com/i] },
  { name: "Zocdoc", category: "scheduling", html: [/zocdoc\.com\/(practice|doctor|widget)/i] },
  { name: "LocalMed", category: "scheduling", html: [/localmed\.com/i] },
  { name: "Weave", category: "scheduling", html: [/getweave\.com|weavehelp\.com/i] },
  { name: "Birdeye", category: "reviews", script: [/birdeye\.com/i] },
  { name: "Trustpilot", category: "reviews", script: [/widget\.trustpilot\.com/i] },
  { name: "Stripe", category: "payments", script: [/js\.stripe\.com/i] },
  { name: "PayPal", category: "payments", script: [/paypal\.com\/sdk\/js|paypalobjects\.com/i] },
  {
    name: "Shopify",
    category: "ecommerce",
    html: [/cdn\.shopify\.com|Shopify\.theme/],
    headers: { "x-shopid": /./, "x-shopify-stage": /./ },
  },
  { name: "WooCommerce", category: "ecommerce", html: [/woocommerce/i] },
  { name: "BigCommerce", category: "ecommerce", html: [/cdn\d*\.bigcommerce\.com/i] },
  {
    name: "Google Workspace",
    category: "email_hosting",
    mx: [/(aspmx\.l\.google\.com|googlemail\.com|smtp\.google\.com)\.?$/i],
    txt: [/include:_spf\.google\.com/i],
  },
  {
    name: "Microsoft 365",
    category: "email_hosting",
    mx: [/mail\.protection\.outlook\.com\.?$/i],
    txt: [/include:spf\.protection\.outlook\.com/i, /^MS=ms\d+/],
  },
  {
    name: "Zoho Mail",
    category: "email_hosting",
    mx: [/mx\d*\.zoho(mail)?\.(com|eu|in)\.?$/i],
    txt: [/include:zoho\.(com|eu)/i],
  },
  { name: "Proofpoint", category: "email_security", mx: [/pphosted\.com\.?$/i] },
  { name: "Mimecast", category: "email_security", mx: [/mimecast\.com\.?$/i] },
  { name: "SendGrid", category: "email_delivery", txt: [/include:sendgrid\.net/i] },
  { name: "Mailgun", category: "email_delivery", txt: [/include:mailgun\.org/i] },
  { name: "Amazon SES", category: "email_delivery", txt: [/include:amazonses\.com/i] },
  {
    name: "Google Analytics",
    category: "analytics",
    script: [/googletagmanager\.com\/gtag\/js|google-analytics\.com\/(analytics|ga)\.js/i],
  },
  {
    name: "Google Tag Manager",
    category: "analytics",
    script: [/googletagmanager\.com\/gtm\.js/i],
    html: [/googletagmanager\.com\/ns\.html/i],
  },
  { name: "Segment", category: "analytics", script: [/cdn\.segment\.com/i] },
  { name: "Hotjar", category: "analytics", script: [/static\.hotjar\.com/i] },
  { name: "Mixpanel", category: "analytics", script: [/cdn\.mxpnl\.com/i] },
  { name: "Amplitude", category: "analytics", script: [/cdn\.amplitude\.com/i] },
  { name: "Heap", category: "analytics", script: [/cdn\.heapanalytics\.com/i] },
  { name: "Optimizely", category: "ab_testing", script: [/cdn\.optimizely\.com/i] },
  { name: "VWO", category: "ab_testing", script: [/visualwebsiteoptimizer\.com/i] },
  {
    name: "Meta Pixel",
    category: "advertising",
    html: [/connect\.facebook\.net\/[a-z_]+\/fbevents\.js/i],
  },
  { name: "LinkedIn Insight Tag", category: "advertising", script: [/snap\.licdn\.com/i] },
  { name: "WordPress", category: "cms", generator: /WordPress/i, html: [/\/wp-content\//i] },
  {
    name: "Webflow",
    category: "cms",
    generator: /Webflow/i,
    html: [/assets\.website-files\.com/i],
  },
  { name: "Wix", category: "cms", generator: /Wix\.com/i, headers: { "x-wix-request-id": /./ } },
  { name: "Squarespace", category: "cms", html: [/static1\.squarespace\.com/i] },
  { name: "Drupal", category: "cms", generator: /Drupal/i, headers: { "x-drupal-cache": /./ } },
  { name: "Ghost", category: "cms", generator: /Ghost/i },
  {
    name: "Next.js",
    category: "framework",
    html: [/__NEXT_DATA__|\/_next\/static\//],
    headers: { "x-powered-by": /Next\.js/i },
  },
  { name: "Cloudflare", category: "hosting", headers: { server: /cloudflare/i, "cf-ray": /./ } },
  { name: "Vercel", category: "hosting", headers: { server: /vercel/i, "x-vercel-id": /./ } },
  { name: "Netlify", category: "hosting", headers: { server: /netlify/i, "x-nf-request-id": /./ } },
];

export interface DetectionInput {
  html: string;
  headers: Headers;
  mx: string[];
  txt: string[];
}

export interface DetectedTech {
  name: string;
  category: TechCategory;
}

function cookieNames(headers: Headers): string[] {
  const values =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie") ?? ""];
  return values
    .flatMap((value) => value.split(/,(?=\s*[^;=\s]+=)/))
    .map((cookie) => cookie.split(";")[0]?.split("=")[0]?.trim() ?? "")
    .filter(Boolean);
}

/** Technologies found in a page, its headers and the domain's DNS records (sorted by name). */
export function detectTechnologies(input: DetectionInput): DetectedTech[] {
  const $ = load(input.html);
  const scripts = $("script[src]")
    .map((_, element) => $(element).attr("src") ?? "")
    .get()
    .filter(Boolean);
  const generator = $('meta[name="generator" i]').attr("content") ?? "";
  const cookies = cookieNames(input.headers);
  const found: DetectedTech[] = [];
  for (const fingerprint of FINGERPRINTS) {
    const hit =
      fingerprint.html?.some((pattern) => pattern.test(input.html)) ||
      fingerprint.script?.some((pattern) => scripts.some((src) => pattern.test(src))) ||
      (fingerprint.generator ? fingerprint.generator.test(generator) : false) ||
      Object.entries(fingerprint.headers ?? {}).some(([name, pattern]) => {
        const value = input.headers.get(name);
        return value !== null && pattern.test(value);
      }) ||
      fingerprint.cookies?.some((pattern) => cookies.some((cookie) => pattern.test(cookie))) ||
      fingerprint.mx?.some((pattern) => input.mx.some((host) => pattern.test(host))) ||
      fingerprint.txt?.some((pattern) => input.txt.some((record) => pattern.test(record)));
    if (hit) found.push({ name: fingerprint.name, category: fingerprint.category });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
