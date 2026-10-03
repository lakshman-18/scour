import { promises as dns } from 'node:dns';
import net from 'node:net';

/**
 * SSRF guard for the HTTP API. A server that fetches arbitrary URLs must not
 * become a proxy into the network it runs on (routers, admin panels, cloud
 * metadata at 169.254.169.254). We resolve the hostname and refuse private,
 * loopback, link-local and reserved addresses.
 *
 * Limitation, stated plainly: this checks the URL you ask for, not every
 * redirect hop or a DNS answer that changes between check and fetch. Keep the
 * server on localhost unless you need it elsewhere.
 */
export class BlockedTarget extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedTarget';
  }
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast and reserved
    );
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true; // not an IP at all: refuse
}

export async function assertPublicUrl(input: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new BlockedTarget(`Not a usable URL: "${input}"`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new BlockedTarget(`Only http(s) URLs are allowed, got ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new BlockedTarget(`Refusing to fetch internal host "${host}" (start the server with --allow-private to permit this)`);
  }
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true, verbatim: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new BlockedTarget(`Could not resolve "${host}"`);
  const bad = addrs.find(isPrivateAddress);
  if (bad) throw new BlockedTarget(`Refusing to fetch "${host}": it resolves to a private address (${bad}). Use --allow-private if this is intended.`);
}
