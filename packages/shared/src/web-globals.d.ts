// The few web globals `tunnel.ts`, `pairing.ts` and `native-bridge.ts` use. Every runtime
// they run in (Node, browsers, Cloudflare Workers) has them, but this package compiles
// without DOM or Node types, so they're declared here. Only what's used: anything more stays out of reach on purpose.

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}

declare class URL {
  constructor(url: string, base?: string);
  protocol: string;
  origin: string;
  pathname: string;
  href: string;
  searchParams: { get(name: string): string | null };
  toString(): string;
}
