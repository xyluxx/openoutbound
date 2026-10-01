/**
 * Which IP addresses outbound requests may reach (spec 6): private, loopback, link-local,
 * CGNAT, multicast, reserved and cloud metadata ranges are blocked. Cloud metadata endpoints
 * stay blocked even when OPENOUTBOUND_ALLOW_PRIVATE_NETWORK lifts the private-range block.
 */
import { BlockList, isIP } from "node:net";

const privateRanges = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  // Unspecified, loopback and the deprecated IPv4-compatible range (::a.b.c.d).
  ["::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv6");
}

const METADATA_ADDRESSES = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
]);

/** The IPv4 address embedded in IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) forms. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:(?:0:)?|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted?.[1]) return dotted[1];
  const hex = /^(?:::ffff:(?:0:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return null;
}

function normalize(address: string): string {
  return address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
}

/** Canonical text form of an IPv6 address (so "fd00:0ec2:0::254" matches "fd00:ec2::254"). */
function canonicalIpv6(address: string): string {
  try {
    return new URL(`http://[${address}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return address;
  }
}

/** Lowercase address without brackets or zone id; IPv6 in canonical form. */
function canonical(address: string): string {
  const ip = normalize(address).toLowerCase();
  return isIP(ip) === 6 ? canonicalIpv6(ip) : ip;
}

export function isMetadataAddress(address: string): boolean {
  const ip = canonical(address);
  return METADATA_ADDRESSES.has(embeddedIpv4(ip) ?? ip);
}

/** True when the address is not a public unicast address. Non-IP strings count as blocked. */
export function isPrivateAddress(address: string): boolean {
  const ip = canonical(address);
  const version = isIP(ip);
  if (version === 4) return privateRanges.check(ip, "ipv4");
  if (version === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return privateRanges.check(v4, "ipv4");
    return privateRanges.check(ip, "ipv6");
  }
  return true;
}

/** Whether a request may connect to `address`. */
export function isAddressAllowed(address: string, allowPrivate: boolean): boolean {
  if (isMetadataAddress(address)) return false;
  return allowPrivate || !isPrivateAddress(address);
}
