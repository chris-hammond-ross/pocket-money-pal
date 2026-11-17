// Bundles the server (and @pmp/shared) into dist/server.mjs.
// better-sqlite3 stays external: it is a native module resolved at runtime.
//
// `--node-sqlite` (the Android build, ADR 0029) bundles into dist-node-sqlite/ instead, with
// better-sqlite3 swapped for src/db/node-sqlite-compat.ts over Node's built-in node:sqlite.
// That bundle has no external dependency at all. The PC build is unchanged.
import { build } from 'esbuild';
import { cp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const nodeSqlite = process.argv.includes('--node-sqlite');
const outdir = nodeSqlite ? 'dist-node-sqlite' : 'dist';
const { version } = JSON.parse(await readFile('../../package.json', 'utf8'));

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: `${outdir}/server.mjs`,
  bundle: true,
  platform: 'node',
  target: nodeSqlite ? 'node24' : 'node22',
  format: 'esm',
  sourcemap: true,
  ...(nodeSqlite
    ? {
        alias: {
          'better-sqlite3': fileURLToPath(
            new URL('../src/db/node-sqlite-compat.ts', import.meta.url),
          ),
        },
      }
    : { external: ['better-sqlite3'] }),
  define: { __PMP_VERSION__: JSON.stringify(version) },
  // Some CJS deps call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __pmpCreateRequire } from 'node:module'; const require = __pmpCreateRequire(import.meta.url);",
  },
});
await cp('drizzle', `${outdir}/drizzle`, { recursive: true });
console.log(`server built -> ${outdir}/server.mjs`);
