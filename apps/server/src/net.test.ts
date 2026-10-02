import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { isOnPc, lanAddresses } from './net';

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
