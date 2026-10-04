/**
 * A jar's picture from its shop link (spec 004, ADR 0010): the server fetches the page,
 * reads its `og:image`, downloads that picture and keeps it next to the database, so the
 * phones show it without the internet. Short timeouts and size limits, public addresses
 * only. Any failure just means no picture.
 */
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

export interface ImageFetchLimits {
  /** Per request. */
  timeoutMs: number;
  maxHtmlBytes: number;
  maxImageBytes: number;
  maxRedirects: number;
}

export const IMAGE_FETCH_LIMITS: ImageFetchLimits = {
  timeoutMs: 5_000,
  maxHtmlBytes: 1_000_000,
  maxImageBytes: 3_000_000,
  maxRedirects: 3,
};

export type ImageExt = 'png' | 'jpg' | 'webp' | 'gif';

export const IMAGE_TYPES: Record<ImageExt, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Fetches the picture for a shop link, or null when there isn't one. May throw. */
export type ImageFetcher = (shopUrl: string) => Promise<{ bytes: Buffer; ext: ImageExt } | null>;

/** Resolves a host name to its addresses (faked in tests). */
export type Resolver = (host: string) => Promise<string[]>;

const dnsResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function ipv4Parts(ip: string): number[] {
  return ip.split('.').map(Number);
}

/**
 * Whether an IP address is on the public internet: not loopback, private, link-local,
 * carrier-grade NAT, documentation, multicast or reserved.
 */
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b, c] = ipv4Parts(ip) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (lower === '::' || lower === '::1') return false;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
    if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (lower.startsWith('2001:db8:') || lower.startsWith('64:ff9b:')) return false;
    return true;
  }
  return false;
}

interface FetchOptions {
  limits: ImageFetchLimits;
  resolve: Resolver;
  /** Which addresses may be fetched (public ones; tests also allow loopback). */
  isAllowed: (ip: string) => boolean;
}

async function assertAllowed(url: URL, { resolve, isAllowed }: FetchOptions): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Not an http(s) link: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0 || !addresses.every(isAllowed)) {
    throw new Error(`${host} isn't a public address`);
  }
}

/**
 * GET with manual redirects (each one checked), a timeout per request and a byte limit on
 * the body. Returns the body, its content type and the final address.
 */
async function fetchLimited(
  start: string,
  accept: string,
  maxBytes: number,
  opts: FetchOptions,
): Promise<{ body: Buffer; type: string; url: URL }> {
  const { limits } = opts;
  let url = new URL(start);
  for (let hop = 0; ; hop++) {
    await assertAllowed(url, opts);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(limits.timeoutMs),
      headers: {
        accept,
        'user-agent': 'Mozilla/5.0 (compatible; PocketMoneyPal/0.1; +jar picture)',
      },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hop >= limits.maxRedirects) throw new Error('Too many redirects');
      url = new URL(location, url);
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${url.host}`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > maxBytes) {
      await res.body.cancel();
      throw new Error(`Too big: ${length} bytes`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`Too big: over ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return {
      body: Buffer.concat(chunks),
      type: (res.headers.get('content-type') ?? '').toLowerCase(),
      url,
    };
  }
}

const IMAGE_META = new Set([
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'twitter:image',
  'twitter:image:src',
]);

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The page's `og:image` (or `twitter:image`) as an absolute http(s) address, or null. */
export function findOgImage(html: string, base: URL | string): string | null {
  const found = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(/([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      attrs.set(m[1]!.toLowerCase(), m[3] ?? m[4] ?? m[5] ?? '');
    }
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const content = attrs.get('content');
    if (IMAGE_META.has(key) && content && !found.has(key)) found.set(key, decodeEntities(content));
  }
  for (const key of IMAGE_META) {
    const value = found.get(key);
    if (!value) continue;
    try {
      const url = new URL(value, base);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {
      // Not an address: try the next tag.
    }
  }
  return null;
}

/** What the bytes really are, from their first few (the server's header isn't trusted). */
export function sniffImage(bytes: Buffer): ImageExt | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (bytes.length >= 6 && bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/** The real fetcher: the page, then its `og:image`. A link straight to a picture works too. */
export function createImageFetcher(options: Partial<FetchOptions> = {}): ImageFetcher {
  const opts: FetchOptions = {
    limits: IMAGE_FETCH_LIMITS,
    resolve: dnsResolver,
    isAllowed: isPublicAddress,
    ...options,
  };
  const { limits } = opts;
  return async (shopUrl) => {
    const page = await fetchLimited(
      shopUrl,
      'text/html,application/xhtml+xml,image/*;q=0.8',
      Math.max(limits.maxHtmlBytes, limits.maxImageBytes),
      opts,
    );
    if (page.type.startsWith('image/')) {
      const ext = sniffImage(page.body);
      return ext ? { bytes: page.body, ext } : null;
    }
    const html = page.body.subarray(0, limits.maxHtmlBytes).toString('utf8');
    const imageUrl = findOgImage(html, page.url);
    if (!imageUrl) return null;
    const image = await fetchLimited(imageUrl, 'image/*', limits.maxImageBytes, opts);
    const ext = sniffImage(image.body);
    return ext ? { bytes: image.body, ext } : null;
  };
}

const FILE_NAME = /^goal-\d+-[0-9a-f]{8}\.(png|jpg|webp|gif)$/;

/** Jar pictures on disk, in `images/` next to the database. */
export class GoalImages {
  constructor(
    /** Null with an in-memory database: no pictures are kept. */
    private readonly dir: string | null,
    private readonly fetcher: ImageFetcher,
  ) {}

  /** Fetches and saves the picture for a shop link. Returns the file name, or null. */
  async fetchAndSave(goalId: number, shopUrl: string): Promise<string | null> {
    if (!this.dir) return null;
    const image = await this.fetcher(shopUrl);
    if (!image) return null;
    const name = `goal-${goalId}-${randomBytes(4).toString('hex')}.${image.ext}`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, name), image.bytes);
    return name;
  }

  /** The file for a stored name, and its media type; null for anything unexpected. */
  fileOf(name: string): { path: string; type: string } | null {
    const match = FILE_NAME.exec(name);
    if (!this.dir || !match) return null;
    return { path: join(this.dir, name), type: IMAGE_TYPES[match[1] as ImageExt] };
  }

  /** Removes a picture that's no longer used. Best effort. */
  async remove(name: string | null): Promise<void> {
    const file = name ? this.fileOf(name) : null;
    if (file) await unlink(file.path).catch(() => undefined);
  }

  /** Removes every jar picture (a factory reset, ADR 0014). Best effort. */
  async removeAll(): Promise<void> {
    if (!this.dir) return;
    const names = await readdir(this.dir).catch(() => [] as string[]);
    await Promise.all(names.map((name) => this.remove(name)));
  }
}
