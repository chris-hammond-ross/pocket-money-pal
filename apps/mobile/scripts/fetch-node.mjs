// Downloads the pinned Node for Android (node-mobile.json), checks its SHA-256, and unpacks
// libnode.so for each ABI plus the headers into .cache/node-<version>/. Gradle reads them from
// there; nothing from it is committed. Does nothing if that version is already unpacked.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const mobile = resolve(import.meta.dirname, '..');
const pin = JSON.parse(await readFile(resolve(mobile, 'node-mobile.json'), 'utf8'));
const cache = resolve(mobile, '.cache');
const zipFile = resolve(cache, `nodejs-mobile-android-${pin.version}.zip`);
const outDir = resolve(cache, `node-${pin.version}`);
const doneMarker = resolve(outDir, '.complete');

if (existsSync(doneMarker)) {
  console.log(`node ${pin.version} for Android: already in ${outDir}`);
  process.exit(0);
}

await mkdir(cache, { recursive: true });
if (!existsSync(zipFile)) {
  console.log(`downloading ${pin.url}…`);
  const res = await fetch(pin.url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  await writeFile(`${zipFile}.part`, Buffer.from(await res.arrayBuffer()));
  await rename(`${zipFile}.part`, zipFile);
}

const zip = await readFile(zipFile);
const hash = createHash('sha256').update(zip).digest('hex');
if (hash !== pin.sha256) {
  await rm(zipFile);
  throw new Error(`checksum mismatch for ${zipFile}: got ${hash}, expected ${pin.sha256}`);
}

// bin/<abi>/libnode.so → jniLibs/<abi>/libnode.so; include/** → include/**.
await rm(outDir, { recursive: true, force: true });
let count = 0;
for (const entry of zipEntries(zip)) {
  let target;
  const lib = entry.name.match(/^bin\/([^/]+)\/libnode\.so$/);
  if (lib) target = resolve(outDir, 'jniLibs', lib[1], 'libnode.so');
  else if (entry.name.startsWith('include/') && !entry.name.endsWith('/'))
    target = resolve(outDir, entry.name);
  else continue;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, entry.data());
  count++;
}
await writeFile(doneMarker, pin.version);
console.log(`node ${pin.version} for Android: ${count} files -> ${outDir}`);

/** The entries of a (non-zip64) zip file, read from its central directory. */
function* zipEntries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    yield {
      name,
      data() {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + compressedSize);
        if (method === 0) return raw;
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`${name}: unsupported zip method ${method}`);
      },
    };
  }
}
