// Starts Electron on this package. Clears ELECTRON_RUN_AS_NODE, which tools such as
// VS Code set for their child processes and which would make Electron run as plain Node.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [resolve(import.meta.dirname, '..'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
child.on('exit', (code) => process.exit(code ?? 0));
