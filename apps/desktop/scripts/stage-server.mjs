// Assembles a self-contained copy of the server for Electron in .stage/server:
//   server.mjs + drizzle/ (from apps/server/dist), web/ (from apps/web/dist),
//   and a node_modules/ holding better-sqlite3, the server's only external dependency.
// electron-builder ships this folder as resources/server. better-sqlite3 >= 13 ships
// Node-API prebuilds, so the same binary loads in Node and in Electron with no rebuild.
import { execSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../..');
const stage = resolve(import.meta.dirname, '../.stage/server');
const serverDist = resolve(root, 'apps/server/dist');
const webDist = resolve(root, 'apps/web/dist');

for (const dir of [serverDist, webDist]) {
  if (!existsSync(dir))
    throw new Error(`${dir} is missing. Run "npm run build" at the repo root first.`);
}

const sqliteVersion = JSON.parse(
  await readFile(require.resolve('better-sqlite3/package.json'), 'utf8'),
).version;

// Reuse the staged node_modules if it already has this better-sqlite3 version.
const markerFile = resolve(stage, '.sqlite-version');
const reuseModules =
  existsSync(markerFile) && (await readFile(markerFile, 'utf8')) === sqliteVersion;

if (reuseModules) {
  for (const entry of ['server.mjs', 'server.mjs.map', 'drizzle', 'web']) {
    await rm(resolve(stage, entry), { recursive: true, force: true });
  }
} else {
  await rm(stage, { recursive: true, force: true });
}
await mkdir(stage, { recursive: true });
await cp(serverDist, stage, { recursive: true });
await cp(webDist, resolve(stage, 'web'), { recursive: true });

if (!reuseModules) {
  await writeFile(
    resolve(stage, 'package.json'),
    JSON.stringify(
      {
        name: 'pmp-server-stage',
        private: true,
        type: 'module',
        dependencies: { 'better-sqlite3': sqliteVersion },
      },
      null,
      2,
    ),
  );
  console.log(`installing better-sqlite3@${sqliteVersion} into the stage…`);
  execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock', {
    cwd: stage,
    stdio: 'inherit',
  });
  await writeFile(markerFile, sqliteVersion);
}

console.log(`server staged -> ${stage}`);
