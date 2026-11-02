/**
 * `npm run relay:fake -w @pmp/server`: a local stand-in for the relay (session 9.2), for
 * trying remote access end to end without Cloudflare. `FAKE_RELAY_PORT` (8787) and
 * `FAKE_RELAY_SECRET` change its port and secret. It prints the steps to connect a server.
 */
import { FakeRelay } from '../relay/fake-relay';

const relay = await new FakeRelay({
  kioskId: 'devfamily',
  secret: process.env.FAKE_RELAY_SECRET || 'dev-relay-secret',
  port: Number(process.env.FAKE_RELAY_PORT ?? 8787),
}).start();

relay.on('connect', () => console.log('PC dialling in…'));
relay.on('pc', () => console.log(`PC connected (app ${relay.hello?.appVersion}).`));
relay.on('pc-gone', () => console.log('PC disconnected.'));

console.log(`Fake relay on ${relay.url}

1. Start a server pointed at it:   PMP_RELAY_URL=${relay.url}
2. On a paired phone, Setup → Remote access, enter the licence key ${relay.licenceKey}
   (or: npm run relay:set -w @pmp/server -- ${relay.kioskId} ${relay.secret} ${relay.familyUrl})
3. On this PC, open                ${relay.familyUrl}/parent
   (it counts as remote: pair it with a code from a paired phone or the kiosk)
`);

const stop = async () => {
  await relay.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
