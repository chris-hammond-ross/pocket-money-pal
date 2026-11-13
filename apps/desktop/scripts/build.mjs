// Bundles the Electron main process into dist/main.cjs.
// On Windows it also compiles native/startup-task.cs into dist/startup-task.exe, the helper the
// Microsoft Store build uses for start at login (ADR 0027), with the C# compiler that ships with
// Windows' .NET Framework 4.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const here = resolve(import.meta.dirname, '..');

await build({
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(here, 'dist/main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
});
console.log('desktop built -> dist/main.cjs');

if (process.platform === 'win32') {
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const framework = join(windows, 'Microsoft.NET\\Framework64\\v4.0.30319');
  const metadata = join(windows, 'System32\\WinMetadata');
  const csc = join(framework, 'csc.exe');
  if (!existsSync(csc)) throw new Error(`${csc} is missing: it comes with .NET Framework 4.`);
  execFileSync(
    csc,
    [
      '-nologo',
      '-target:winexe',
      '-platform:x64',
      '-optimize',
      `-out:${join(here, 'dist\\startup-task.exe')}`,
      `-r:${join(metadata, 'Windows.ApplicationModel.winmd')}`,
      `-r:${join(metadata, 'Windows.Foundation.winmd')}`,
      `-r:${join(framework, 'System.Runtime.dll')}`,
      join(here, 'native\\startup-task.cs'),
    ],
    { stdio: 'inherit' },
  );
  console.log('desktop built -> dist/startup-task.exe');
}
