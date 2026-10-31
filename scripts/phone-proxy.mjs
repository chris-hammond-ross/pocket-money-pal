/**
 * Development only: lets a browser on the family PC act as a parent phone.
 *
 * The server treats every request from the PC itself as the kiosk, and phones can't pair
 * there (ADR 0005, ADR 0008). This proxy sits in front of the dev server and sends each
 * request on with `X-Forwarded-For` set to a LAN address. The server trusts that header
 * from loopback, so the browser looks like a phone on the home Wi-Fi.
 *
 *   npm run dev          (in one terminal)
 *   npm run dev:phone    (in another), then open http://127.0.0.1:5199/parent
 *
 * Use 127.0.0.1 (not localhost) for the phone and localhost for the kiosk: cookies are per
 * host, so the phone's pairing never leaks into the kiosk's window.
 *
 * Settings: PHONE_PROXY_PORT (5199), PHONE_PROXY_TARGET (http://localhost:5173),
 * PHONE_PROXY_IP (192.168.213.77, a home-network address no real PC is likely to have).
 * To act as a phone away from home (ADR 0021), use a tailnet or public address instead:
 * PHONE_PROXY_IP=100.88.12.34. It then has to be paired for everything but pairing.
 */
import http from 'node:http';
import net from 'node:net';

const port = Number(process.env.PHONE_PROXY_PORT || 5199);
const target = new URL(process.env.PHONE_PROXY_TARGET || 'http://localhost:5173');
const phoneIp = process.env.PHONE_PROXY_IP || '192.168.213.77';
const targetPort = Number(target.port || 80);

/** The browser's headers, as a phone on the LAN talking straight to the dev server. */
function headersFor(req) {
  const headers = { ...req.headers, host: target.host, 'x-forwarded-for': phoneIp };
  // Vite checks where WebSocket connections come from.
  if (headers.origin) headers.origin = target.origin;
  return headers;
}

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      host: target.hostname,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: headersFor(req),
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Phone proxy: can't reach ${target.origin} (${err.message}). Is npm run dev running?`);
  });
  req.pipe(upstream);
});

// WebSockets (the app's live updates, and Vite's hot reload): pass the upgrade through.
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(targetPort, target.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headersFor(req))) {
      for (const v of [value].flat()) lines.push(`${name}: ${v}`);
    }
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Phone proxy: http://127.0.0.1:${port}/parent  ->  ${target.origin} as ${phoneIp}`);
});
