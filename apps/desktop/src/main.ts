import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  powerSaveBlocker,
  screen,
  utilityProcess,
  type UtilityProcess,
} from 'electron';

const PORT = Number(process.env.PMP_PORT ?? 4789);
/** Set to use an already-running server (e.g. `npm run dev`) instead of the bundled one. */
const EXTERNAL_URL = process.env.PMP_SERVER_URL;
/** True kiosk mode (no way out without a keyboard shortcut). Off by default while developing. */
const KIOSK = process.env.PMP_KIOSK === '1';

let server: UtilityProcess | null = null;
let window: BrowserWindow | null = null;
let quitting = false;

// Sounds are part of the game; don't wait for a click before playing them.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => window?.focus());
  app.whenReady().then(start).catch(fail);
}

async function start(): Promise<void> {
  const baseUrl = EXTERNAL_URL ?? (await startServer());
  window = createKioskWindow();
  await window.loadURL(`${baseUrl}/kiosk`);
  powerSaveBlocker.start('prevent-display-sleep');
}

async function startServer(): Promise<string> {
  const serverDir = app.isPackaged
    ? join(process.resourcesPath, 'server')
    : join(__dirname, '../.stage/server');

  server = utilityProcess.fork(join(serverDir, 'server.mjs'), [], {
    serviceName: 'Pocket Money Pal server',
    stdio: 'inherit',
    env: {
      ...process.env,
      PMP_PORT: String(PORT),
      PMP_DB_PATH: join(app.getPath('userData'), 'pmp.db'),
      // `npm run desktop:dev` gets the movable development clock; a packaged app never does.
      ...(!app.isPackaged && { PMP_DEV_CLOCK: process.env.PMP_DEV_CLOCK ?? '1' }),
    },
  });
  server.on('exit', (code) => {
    server = null;
    if (!quitting) fail(new Error(`Server exited unexpectedly (code ${code})`));
  });

  const url = `http://localhost:${PORT}`;
  await waitForHealth(url);
  return url;
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not become healthy at ${url}`);
}

/** Opens on PMP_DISPLAY (index), else the first non-primary display, else the primary. */
function createKioskWindow(): BrowserWindow {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const requested = process.env.PMP_DISPLAY ? displays[Number(process.env.PMP_DISPLAY)] : undefined;
  const target = requested ?? displays.find((d) => d.id !== primary.id) ?? primary;

  const win = new BrowserWindow({
    ...target.bounds,
    fullscreen: true,
    kiosk: KIOSK,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    title: 'Pocket Money Pal',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.on('closed', () => (window = null));
  return win;
}

app.on('before-quit', () => {
  quitting = true;
  server?.kill();
});
app.on('window-all-closed', () => app.quit());

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox('Pocket Money Pal could not start', message);
  app.exit(1);
}
