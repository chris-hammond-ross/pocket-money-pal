// Bundles the server (and @pmp/shared) into dist/server.mjs.
// better-sqlite3 stays external: it is a native module resolved at runtime.
import { build } from 'esbuild';
import { cp, readFile, rm } from 'node:fs/promises';

const { version } = JSON.parse(await readFile('../../package.json', 'utf8'));

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['better-sqlite3'],
  define: { __PMP_VERSION__: JSON.stringify(version) },
  // Some CJS deps call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __pmpCreateRequire } from 'node:module'; const require = __pmpCreateRequire(import.meta.url);",
  },
});
await cp('drizzle', 'dist/drizzle', { recursive: true });
console.log('server built -> dist/server.mjs');
