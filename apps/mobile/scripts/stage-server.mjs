// Assembles the server for the Android app in .stage/assets/server, which Gradle packs into
// the APK's assets:
//   server.mjs + drizzle/  the server bundled with better-sqlite3 swapped for the node:sqlite
//                          shim (apps/server `build.mjs --node-sqlite`, ADR 0029). No
//                          node_modules: the bundle has no external dependency left.
//   web/                   the built React app (apps/web/dist).
// The app copies it into its private storage on first run and after each update.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const serverDir = resolve(root, 'apps/server');
const webDist = resolve(root, 'apps/web/dist');
const stage = resolve(import.meta.dirname, '../.stage/assets/server');

if (!existsSync(resolve(webDist, 'index.html'))) {
  throw new Error(`${webDist} is missing. Run "npm run build" at the repo root first.`);
}

execFileSync(process.execPath, ['scripts/build.mjs', '--node-sqlite'], {
  cwd: serverDir,
  stdio: 'inherit',
});

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const bundle = resolve(serverDir, 'dist-node-sqlite');
await cp(resolve(bundle, 'server.mjs'), resolve(stage, 'server.mjs'));
await cp(resolve(bundle, 'drizzle'), resolve(stage, 'drizzle'), { recursive: true });
await cp(webDist, resolve(stage, 'web'), { recursive: true });
// Lets the app tell one staged server from another without hashing it (see ServerFiles).
await writeFile(resolve(stage, 'stage.txt'), `${Date.now()}\n`);
console.log(`server staged -> ${stage}`);
