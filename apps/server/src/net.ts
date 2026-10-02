import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

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
