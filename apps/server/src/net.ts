import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { FastifyRequest } from 'fastify';

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** Adapters that are rarely how a phone on the home Wi-Fi reaches the PC. */
const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|wsl|docker|hyper-v|tailscale|zerotier|vpn/i;

function privateRank(address: string): number {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

/**
 * The PC's IPv4 addresses a phone could use, likeliest first: home-network ranges before
 * others, real adapters before virtual ones (Hyper-V, WSL, VPNs). Link-local addresses
 * (169.254.x.x, an adapter with no DHCP) are left out. Used for the setup QR.
 */
export function lanAddresses(interfaces: Interfaces = networkInterfaces()): string[] {
  return Object.entries(interfaces)
    .flatMap(([name, infos]) =>
      (infos ?? [])
        .filter((i) => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
        .map((i) => ({
          address: i.address,
          rank: privateRank(i.address) + (VIRTUAL_ADAPTER.test(name) ? 10 : 0),
        })),
    )
    .sort((a, b) => a.rank - b.rank)
    .map((a) => a.address);
}

/** "::ffff:192.168.1.5" → "192.168.1.5", so IPv4 clients on a dual-stack socket compare. */
function normalise(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * Whether a request comes from the family PC itself: a loopback address, or one of the
 * machine's own addresses (a browser on the PC opening its LAN URL). ADR 0005.
 */
export function isOnPc(ip: string, interfaces: Interfaces = networkInterfaces()): boolean {
  const address = normalise(ip);
  if (address === '::1' || address.startsWith('127.')) return true;
  return Object.values(interfaces).some((infos) =>
    (infos ?? []).some((i) => normalise(i.address) === address),
  );
}

/** Where a request comes from (ADR 0021): the family PC, the home network, or anywhere else. */
export type RequestOrigin = 'pc' | 'lan' | 'remote';

/** Tailscale's IPv6 range. It sits inside the ULA range, but it's a tailnet, not the home. */
const TAILSCALE_V6 = new BlockList();
TAILSCALE_V6.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

/** Home-network ranges. Tailscale's `100.64.0.0/10` isn't one: it's remote. */
const LAN = new BlockList();
LAN.addSubnet('10.0.0.0', 8, 'ipv4');
LAN.addSubnet('172.16.0.0', 12, 'ipv4');
LAN.addSubnet('192.168.0.0', 16, 'ipv4');
LAN.addSubnet('169.254.0.0', 16, 'ipv4');
LAN.addSubnet('fc00::', 7, 'ipv6');
LAN.addSubnet('fe80::', 10, 'ipv6');

function isLan(address: string): boolean {
  const type = address.includes(':') ? 'ipv6' : 'ipv4';
  try {
    if (type === 'ipv6' && TAILSCALE_V6.check(address, type)) return false;
    return LAN.check(address, type);
  } catch {
    return false; // not an address at all
  }
}

/**
 * The origin of a client address alone: the PC itself (loopback or one of its own
 * addresses, its own Tailscale address included), a private home-network range, or remote.
 */
export function originOfIp(
  ip: string,
  interfaces: Interfaces = networkInterfaces(),
): RequestOrigin {
  if (isOnPc(ip, interfaces)) return 'pc';
  // A link-local IPv6 address can carry its zone ("fe80::1%12").
  return isLan(normalise(ip).split('%')[0]!) ? 'lan' : 'remote';
}

/**
 * The tunnel's mark (ADR 0021). The tunnel client (session 9.2) adds this header, with a
 * secret made fresh each time the server starts, to every request it injects. Nothing
 * outside this process knows the secret, and `requestOrigin` strips the header, so no
 * request a phone makes can claim it. The mark only ever makes a request less trusted.
 */
const TUNNEL_HEADER = 'x-pmp-tunnelled';
const tunnelSecret = randomBytes(32).toString('base64url');

/** Headers the tunnel client puts on each injected request, over any the relay sent. */
export function tunnelledHeaders(): Record<string, string> {
  return { [TUNNEL_HEADER]: tunnelSecret };
}

function isTunnelled(req: FastifyRequest): boolean {
  const value = req.headers[TUNNEL_HEADER];
  if (typeof value !== 'string' || value.length !== tunnelSecret.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(tunnelSecret));
}

/**
 * Headers only a proxy sends. A loopback request carrying one but no `X-Forwarded-For`
 * came through a proxy that doesn't say who the client is (a half-configured reverse
 * proxy), so it can't be taken for the PC.
 */
const PROXY_HEADERS = [
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'via',
  'cf-connecting-ip',
];

const origins = new WeakMap<object, RequestOrigin>();

/**
 * Where a request comes from (ADR 0021). A tunnelled request is always remote. Otherwise
 * the client address decides, which `trustProxy: 'loopback'` takes from a local proxy's
 * `X-Forwarded-For` (Vite in development, `tailscale serve`, `cloudflared`). Worked out
 * once per request: the remote guard's `onRequest` hook asks first.
 */
export function requestOrigin(req: FastifyRequest): RequestOrigin {
  const known = origins.get(req.raw);
  if (known) return known;
  let origin: RequestOrigin;
  // No socket to say who's asking (only a test's fake upgrade): never trusted.
  if (isTunnelled(req) || !req.raw.socket) origin = 'remote';
  else if (
    req.headers['x-forwarded-for'] === undefined &&
    PROXY_HEADERS.some((h) => req.headers[h] !== undefined)
  ) {
    origin = 'remote';
  } else origin = originOfIp(req.ip);
  delete req.headers[TUNNEL_HEADER];
  delete req.raw.headers[TUNNEL_HEADER];
  origins.set(req.raw, origin);
  return origin;
}
