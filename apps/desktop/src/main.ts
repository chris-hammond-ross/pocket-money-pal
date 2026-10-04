import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  powerSaveBlocker,
  screen,
  Tray,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { autoUpdater } from 'electron-updater';

const PORT = Number(process.env.PMP_PORT ?? 4789);
/** Set to use an already-running server (e.g. `npm run dev`) instead of the bundled one. */
const EXTERNAL_URL = process.env.PMP_SERVER_URL;
/** True kiosk mode (no way out without a keyboard shortcut). Off by default while developing. */
const KIOSK = process.env.PMP_KIOSK === '1';
/** Testing only: fetch updates from this folder (laid out like a GitHub release) instead. */
const UPDATE_URL = process.env.PMP_UPDATE_URL;
/** A downloaded update installs during this hour of the night, when nobody is mid-chore. */
const INSTALL_HOUR = Number(process.env.PMP_UPDATE_HOUR ?? 3);
/** An update found this soon after launch installs at once: the kiosk is only just starting. */
const JUST_STARTED_MS = 2 * 60_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;
/** The registry value name for start-at-login, so the uninstaller can remove it. */
const LOGIN_ITEM_NAME = 'Pocket Money Pal';

const startedAt = Date.now();
let server: UtilityProcess | null = null;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let baseUrl = '';
let quitting = false;
/** The version of an update that's downloaded and waiting to install. */
let updateReady: string | null = null;

// Sounds are part of the game; don't wait for a click before playing them.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => void openWindow());
  app.whenReady().then(start).catch(fail);
}

async function start(): Promise<void> {
  log(`starting v${app.getVersion()}`);
  baseUrl = EXTERNAL_URL ?? (await startServer());
  createTray();
  initLoginItem();
  await openWindow();
  powerSaveBlocker.start('prevent-display-sleep');
  startUpdater();
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
      PMP_APP_VERSION: app.getVersion(),
      // `npm run desktop:dev` gets the movable development clock; a packaged app never does.
      ...(!app.isPackaged && { PMP_DEV_CLOCK: process.env.PMP_DEV_CLOCK ?? '1' }),
    },
  });
  server.on('exit', (code) => {
    server = null;
    if (!quitting) {
      fail(
        new Error(
          `The server stopped unexpectedly (code ${code}).

` +
            `If Pocket Money Pal is already running, close that copy first. ` +
            `Otherwise another program may be using port ${PORT}.`,
        ),
      );
    }
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

/** Shows the kiosk window, opening it again if it was closed (the server kept running). */
async function openWindow(): Promise<void> {
  if (!baseUrl) return; // still starting
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  window = createKioskWindow();
  await window.loadURL(`${baseUrl}/kiosk`);
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
    icon: iconPath(),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.on('closed', () => (window = null));
  return win;
}

// ---------------------------------------------------------------------------
// Tray: Open, Restart, Quit. Closing the window leaves the server running for the phones.

function iconPath(): string {
  return join(__dirname, '../assets/icon.png');
}

function createTray(): void {
  const icon = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Pocket Money Pal');
  tray.on('click', () => void openWindow());
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const startAtLogin = app.isPackaged
    ? app.getLoginItemSettings().executableWillLaunchAtLogin
    : false;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Pocket Money Pal v${app.getVersion()}`, enabled: false },
      ...(updateReady
        ? [{ label: `Restart to update to v${updateReady}`, click: installUpdate }]
        : []),
      { type: 'separator' },
      { label: 'Open', click: () => void openWindow() },
      { label: 'Restart', click: restart },
      { type: 'separator' },
      {
        label: 'Start when Windows starts',
        type: 'checkbox',
        checked: startAtLogin,
        enabled: app.isPackaged,
        click: (item) => setStartAtLogin(item.checked),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function restart(): void {
  log('restarting from the tray');
  app.relaunch();
  app.quit();
}

// ---------------------------------------------------------------------------
// Start at login: on by default, turned off from the tray. Only the installed app registers.

interface Prefs {
  loginItemInitialised?: boolean;
}

function prefsFile(): string {
  return join(app.getPath('userData'), 'desktop.json');
}

function readPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(prefsFile(), 'utf8')) as Prefs;
  } catch {
    return {};
  }
}

function initLoginItem(): void {
  if (!app.isPackaged) return;
  const prefs = readPrefs();
  if (prefs.loginItemInitialised) return;
  setStartAtLogin(true);
  writeFileSync(prefsFile(), JSON.stringify({ ...prefs, loginItemInitialised: true }, null, 2));
}

function setStartAtLogin(on: boolean): void {
  app.setLoginItemSettings({ openAtLogin: on, name: LOGIN_ITEM_NAME });
  log(`start at login: ${on ? 'on' : 'off'}`);
  updateTrayMenu();
}

// ---------------------------------------------------------------------------
// Auto-update from GitHub Releases: download in the background, install overnight.

function startUpdater(): void {
  if (!app.isPackaged) return;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => undefined };
  if (UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_URL });
  autoUpdater.autoDownload = true;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version;
    updateTrayMenu();
    if (Date.now() - startedAt < JUST_STARTED_MS) installUpdate();
  });
  autoUpdater.on('error', (err) => log(`update failed: ${err.message}`));

  const check = () =>
    autoUpdater.checkForUpdates().catch((err: Error) => log(`update check: ${err.message}`));
  void check();
  setInterval(check, CHECK_EVERY_MS);
  setInterval(() => {
    if (updateReady && new Date().getHours() === INSTALL_HOUR) installUpdate();
  }, 5 * 60_000);
}

function installUpdate(): void {
  log(`installing v${updateReady}`);
  quitting = true;
  // Silent, then start the new version.
  autoUpdater.quitAndInstall(true, true);
}

// ---------------------------------------------------------------------------

app.on('before-quit', (event) => {
  quitting = true;
  // Let the server let go of the port and the database before the app (or an update) goes.
  if (server) {
    event.preventDefault();
    const running = server;
    running.once('exit', () => app.quit());
    running.kill();
  }
});
// The tray keeps the app (and the server for the phones) running with no window open.
app.on('window-all-closed', () => undefined);

let failed = false;

function fail(error: unknown): void {
  // The server dying also ends the wait for it: say so once.
  if (failed) return;
  failed = true;
  const message = error instanceof Error ? error.message : String(error);
  log(`failed: ${message}`);
  dialog.showErrorBox('Pocket Money Pal could not start', message);
  app.exit(1);
}

/** A small log next to the database, mostly for updates. */
function log(message: string): void {
  try {
    const file = join(app.getPath('userData'), 'desktop.log');
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 1_000_000) writeFileSync(file, '');
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never stop the app
  }
}
