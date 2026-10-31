import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { isOnPc, lanAddresses, originOfIp } from './net';

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

const interfaces = {
  'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
  'vEthernet (WSL)': [v4('172.22.144.1')],
  Tailscale: [v4('100.101.102.103')],
  'Wi-Fi': [
    v4('192.168.1.20'),
    {
      address: 'fe80::1',
      netmask: 'ffff:ffff:ffff:ffff::',
      family: 'IPv6',
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: 'fe80::1/64',
      scopeid: 1,
    } satisfies NetworkInterfaceInfo,
  ],
  Ethernet: [v4('10.0.0.5')],
  'Ethernet 2': [v4('169.254.215.130')],
};

describe('lanAddresses', () => {
  it('puts home-network adapters first and virtual ones last', () => {
    expect(lanAddresses(interfaces)).toEqual([
      '192.168.1.20',
      '10.0.0.5',
      '172.22.144.1',
      '100.101.102.103',
    ]);
  });
});

describe('isOnPc', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['192.168.1.20', true],
    ['::ffff:192.168.1.20', true],
    ['fe80::1', true],
    ['192.168.1.77', false],
    ['::ffff:10.0.0.6', false],
  ])('%s → %s', (ip, expected) => {
    expect(isOnPc(ip, interfaces)).toBe(expected);
  });
});

describe('originOfIp (ADR 0021)', () => {
  it.each([
    // The PC: loopback, or one of its own addresses, its own Tailscale address included.
    ['127.0.0.1', 'pc'],
    ['::1', 'pc'],
    ['192.168.1.20', 'pc'],
    ['100.101.102.103', 'pc'],
    // The home network.
    ['192.168.1.77', 'lan'],
    ['::ffff:10.0.0.6', 'lan'],
    ['172.16.0.9', 'lan'],
    ['172.31.255.1', 'lan'],
    ['169.254.10.10', 'lan'],
    ['fd12:3456:789a::1', 'lan'],
    ['fe80::abcd%12', 'lan'],
    // Everything else: other tailnet devices (both of Tailscale's ranges), the internet.
    ['100.88.12.34', 'remote'],
    ['100.64.0.1', 'remote'],
    ['fd7a:115c:a1e0::9c39:cd40', 'remote'],
    ['fd7a:115c:a1e0:ab12:4843:cd96:6258:b240', 'remote'],
    ['172.32.0.1', 'remote'],
    ['203.0.113.9', 'remote'],
    ['192.0.2.77', 'remote'],
    ['2a00:1450:4009:81f::200e', 'remote'],
    ['not-an-address', 'remote'],
  ])('%s → %s', (ip, expected) => {
    expect(originOfIp(ip, interfaces)).toBe(expected);
  });
});
