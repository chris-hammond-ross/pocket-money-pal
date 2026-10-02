import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createImageFetcher,
  findOgImage,
  GoalImages,
  isPublicAddress,
  sniffImage,
  type ImageFetchLimits,
} from './goal-image';

// The smallest valid PNG header bytes are enough for the sniffer.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

describe('findOgImage', () => {
  const base = 'https://shop.example/products/ps5';

  it('reads og:image whatever the attribute order and quotes', () => {
    expect(
      findOgImage(`<meta property="og:image" content="https://cdn.example/a.jpg">`, base),
    ).toBe('https://cdn.example/a.jpg');
    expect(
      findOgImage(`<META content='https://cdn.example/b.png' property='og:image' />`, base),
    ).toBe('https://cdn.example/b.png');
  });

  it('resolves a relative picture against the page and decodes entities', () => {
    expect(
      findOgImage(`<meta property="og:image" content="/img/p.jpg?w=600&amp;h=600">`, base),
    ).toBe('https://shop.example/img/p.jpg?w=600&h=600');
  });

  it('prefers og:image, then falls back to twitter:image', () => {
    const html = `<meta name="twitter:image" content="https://t.example/t.jpg">
      <meta property="og:image" content="https://o.example/o.jpg">`;
    expect(findOgImage(html, base)).toBe('https://o.example/o.jpg');
    expect(findOgImage(`<meta name="twitter:image" content="https://t.example/t.jpg">`, base)).toBe(
      'https://t.example/t.jpg',
    );
  });

  it('ignores pages without one, and addresses that are not http(s)', () => {
    expect(findOgImage('<html><head><title>Hi</title></head></html>', base)).toBeNull();
    expect(
      findOgImage(`<meta property="og:image" content="javascript:alert(1)">`, base),
    ).toBeNull();
    expect(findOgImage(`<meta property="og:image" content="">`, base)).toBeNull();
  });
});

describe('isPublicAddress', () => {
  it.each([
    ['93.184.216.34', true],
    ['8.8.8.8', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['172.32.0.1', true],
    ['192.168.1.20', false],
    ['169.254.169.254', false],
    ['100.101.102.103', false], // Tailscale / carrier-grade NAT
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['2606:4700::1111', true],
    ['::1', false],
    ['fd7a:115c:a1e0::1', false],
    ['fe80::1', false],
    ['::ffff:192.168.1.1', false],
    ['::ffff:8.8.8.8', true],
    ['not an ip', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe('sniffImage', () => {
  it('trusts the bytes, not the header', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(JPG)).toBe('jpg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffImage(Buffer.from('<html>not a picture</html>'))).toBeNull();
  });
});

describe('createImageFetcher (against a local server)', () => {
  let server: Server;
  let base: string;
  const routes = new Map<string, (res: import('node:http').ServerResponse) => void>();
  const limits: ImageFetchLimits = {
    timeoutMs: 300,
    maxHtmlBytes: 2_000,
    maxImageBytes: 1_000,
    maxRedirects: 2,
  };
  const loopbackOk = createImageFetcher({ limits, isAllowed: () => true });

  beforeEach(async () => {
    routes.clear();
    server = createServer((req, res) => {
      const handler = routes.get(req.url ?? '');
      if (handler) handler(res);
      else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = (html: string) => (res: import('node:http').ServerResponse) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  const image =
    (bytes: Buffer, type = 'image/png') =>
    (res: import('node:http').ServerResponse) =>
      res.writeHead(200, { 'content-type': type }).end(bytes);

  it("downloads the page's og:image", async () => {
    routes.set('/ps5', page(`<meta property="og:image" content="/p.png">`));
    routes.set('/p.png', image(PNG));
    expect(await loopbackOk(`${base}/ps5`)).toEqual({ bytes: PNG, ext: 'png' });
  });

  it('follows a redirect', async () => {
    routes.set('/old', (res) => res.writeHead(301, { location: '/ps5' }).end());
    routes.set('/ps5', page(`<meta property="og:image" content="/p.png">`));
    routes.set('/p.png', image(PNG));
    expect(await loopbackOk(`${base}/old`)).toMatchObject({ ext: 'png' });
  });

  it('gives up after too many redirects', async () => {
    routes.set('/loop', (res) => res.writeHead(302, { location: '/loop' }).end());
    await expect(loopbackOk(`${base}/loop`)).rejects.toThrow(/redirects/);
  });

  it('takes a link straight to a picture', async () => {
    routes.set('/direct.jpg', image(JPG, 'image/jpeg'));
    expect(await loopbackOk(`${base}/direct.jpg`)).toEqual({ bytes: JPG, ext: 'jpg' });
  });

  it('has no picture for a page without og:image, or a "picture" that is not one', async () => {
    routes.set('/plain', page('<title>No picture</title>'));
    expect(await loopbackOk(`${base}/plain`)).toBeNull();
    routes.set('/fake', page(`<meta property="og:image" content="/fake.png">`));
    routes.set('/fake.png', image(Buffer.from('<html>gotcha</html>')));
    expect(await loopbackOk(`${base}/fake`)).toBeNull();
  });

  it('refuses a picture over the size limit', async () => {
    routes.set('/big', page(`<meta property="og:image" content="/big.png">`));
    routes.set('/big.png', image(Buffer.concat([PNG, Buffer.alloc(2_000)])));
    await expect(loopbackOk(`${base}/big`)).rejects.toThrow(/Too big/);
  });

  it('refuses a picture whose size is only known while reading', async () => {
    routes.set('/chunked', page(`<meta property="og:image" content="/chunked.png">`));
    routes.set('/chunked.png', (res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'transfer-encoding': 'chunked' });
      res.write(PNG);
      res.end(Buffer.alloc(2_000));
    });
    await expect(loopbackOk(`${base}/chunked`)).rejects.toThrow(/Too big/);
  });

  it('times out on a slow shop', async () => {
    routes.set('/slow', () => undefined); // never answers
    await expect(loopbackOk(`${base}/slow`)).rejects.toThrow();
  });

  it('refuses the home network by default', async () => {
    const real = createImageFetcher({ limits });
    routes.set('/ps5', page(`<meta property="og:image" content="/p.png">`));
    await expect(real(`${base}/ps5`)).rejects.toThrow(/public/);
  });

  it('refuses a public page that redirects into the home network', async () => {
    // "shop.example" resolves to a public address; the redirect points at the router.
    const resolve = async (host: string) => (host === 'shop.example' ? ['93.184.216.34'] : []);
    const fetcher = createImageFetcher({ limits, resolve });
    await expect(fetcher('http://192.168.1.1/admin')).rejects.toThrow(/public/);
    await expect(fetcher('ftp://shop.example/x')).rejects.toThrow(/http/);
  });
});

describe('GoalImages', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pmp-images-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('saves a fetched picture and serves only names it made', async () => {
    const images = new GoalImages(dir, async () => ({ bytes: PNG, ext: 'png' }));
    const name = await images.fetchAndSave(7, 'https://shop.example/x');
    expect(name).toMatch(/^goal-7-[0-9a-f]{8}\.png$/);
    const file = images.fileOf(name!)!;
    expect(file.type).toBe('image/png');
    expect(readFileSync(file.path)).toEqual(PNG);
    expect(images.fileOf('../pmp.db')).toBeNull();
    expect(images.fileOf('goal-7-zzzzzzzz.png')).toBeNull();
    await images.remove(name);
    expect(() => readFileSync(file.path)).toThrow();
  });

  it('keeps nothing without a folder (in-memory database)', async () => {
    const images = new GoalImages(null, async () => ({ bytes: PNG, ext: 'png' }));
    expect(await images.fetchAndSave(1, 'https://shop.example/x')).toBeNull();
  });
});
