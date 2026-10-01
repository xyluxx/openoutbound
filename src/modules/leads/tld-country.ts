/**
 * Country from an email's country-code top-level domain, used as a fallback for the
 * compliance checks when neither the person nor the company has a country. Only ccTLDs that
 * are used mostly inside their country are mapped; generic TLDs (.com, .org, .net) and
 * ccTLDs sold as brand names worldwide (.io, .co, .ai, .me, .tv, .ly and similar) stay unknown.
 */
import { emailDomain } from "./normalize.js";

/** ccTLDs equal to the ISO code, by region. */
const SAME_CODE = [
  "at be bg hr cy cz dk ee fi fr de gr hu ie it lv lt lu mt nl pl pt ro sk si es se",
  "no is li ch ua rs ba mk al md by ru tr ge az kz uz",
  "us ca mx br ar cl pe uy ec bo py cr pa gt sv hn ni do cu ve",
  "au nz jp cn kr in sg hk tw my id ph th vn pk bd lk np kh",
  "ae sa il qa kw bh om jo lb eg ma dz tn za ng ke gh et tz ug rw sn ci zw zm mz ao na bw",
]
  .join(" ")
  .split(" ");

const TLD_COUNTRY = new Map<string, string>([
  ...SAME_CODE.map((tld): [string, string] => [tld, tld.toUpperCase()]),
  ["uk", "GB"],
  ["gb", "GB"],
]);

/** ISO 3166-1 alpha-2 country of a domain's ccTLD (example.com.au gives AU), or null. */
export function countryFromDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const tld = domain.trim().toLowerCase().replace(/\.+$/, "").split(".").pop();
  return tld ? (TLD_COUNTRY.get(tld) ?? null) : null;
}

/** Country of an email address's ccTLD (dana@praxis.de gives DE), or null. */
export function countryFromEmail(email: string | null | undefined): string | null {
  return countryFromDomain(emailDomain(email ?? null));
}
