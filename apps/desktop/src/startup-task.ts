// Start at login for the Microsoft Store (MSIX) build (ADR 0027).
//
// A packaged app can't use the Run key (`app.setLoginItemSettings`). It declares a startup task in
// its manifest (build/appxmanifest.xml) instead, and reads and changes it through WinRT's
// `Windows.ApplicationModel.StartupTask`, which needs the app's package identity. Electron has no
// WinRT binding, and a system program it starts (PowerShell) runs without the identity, so a tiny
// helper inside the package does it: resources/startup-task.exe (native/startup-task.cs).
//
// The manifest's `Enabled="true"` isn't enough on its own: Windows 11 installs the task disabled,
// so the app asks for it once (`RequestEnableAsync`). Windows lets the user turn it off (Task
// Manager > Startup apps, or Settings). Only the user may turn it back on then, in Settings.
import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** The `TaskId` in build/appxmanifest.xml. */
export const STARTUP_TASK_ID = 'PocketMoneyPalStartup';

/** `Windows.ApplicationModel.StartupTaskState`, plus `unknown` when it couldn't be read. */
export type StartupTaskState =
  'Disabled' | 'DisabledByUser' | 'Enabled' | 'DisabledByPolicy' | 'EnabledByPolicy' | 'unknown';

const STATES: readonly StartupTaskState[] = [
  'Disabled',
  'DisabledByUser',
  'Enabled',
  'DisabledByPolicy',
  'EnabledByPolicy',
];

/**
 * What the helper reported: WinRT's state, and the `State` value Windows keeps in the registry
 * (what Task Manager and Settings show; numbered like `StartupTaskState`), or null if it has none.
 */
export interface StartupTaskReading {
  task: StartupTaskState;
  registry: number | null;
}

export const UNREAD: StartupTaskReading = { task: 'unknown', registry: null };

export type StartupTaskAction = 'read' | 'enable' | 'disable';

/** What the tray's "Start when Windows starts" checkbox shows, and what clicking it does. */
export interface StartupMenu {
  checked: boolean;
  enabled: boolean;
  /** `open-settings`: the app may not change it, so open Settings > Apps > Startup instead. */
  onClick: 'enable' | 'disable' | 'open-settings';
}

export function startupMenu({ task, registry }: StartupTaskReading): StartupMenu {
  switch (task) {
    case 'Enabled':
      return { checked: true, enabled: true, onClick: 'disable' };
    case 'Disabled':
      return { checked: false, enabled: true, onClick: 'enable' };
    case 'DisabledByUser':
      return { checked: false, enabled: true, onClick: 'open-settings' };
    case 'EnabledByPolicy':
      return { checked: true, enabled: false, onClick: 'disable' };
    case 'DisabledByPolicy':
    case 'unknown':
      // WinRT gives no usable answer (a sideloaded build is told DisabledByPolicy even while Task
      // Manager shows the task on). Show what Windows shows, and leave changing it to Settings.
      return {
        checked: registry === 2 || registry === 4,
        enabled: task === 'DisabledByPolicy',
        onClick: 'open-settings',
      };
  }
}

/** Parses the helper's output, e.g. `Enabled 2` or `Disabled none`. */
export function parseReading(output: string): StartupTaskReading {
  const [word = '', registry = ''] = output.trim().split(/\s+/);
  const task = STATES.find((state) => state === word) ?? 'unknown';
  return { task, registry: /^\d+$/.test(registry) ? Number(registry) : null };
}

/** Runs the helper. Never throws: a failure reads as `unknown`, and the reason goes to the log. */
export function runStartupTask(
  action: StartupTaskAction,
  log: (message: string) => void,
): Promise<StartupTaskReading> {
  const helper = join(process.resourcesPath, 'startup-task.exe');
  return new Promise((resolve) => {
    execFile(
      helper,
      [action, STARTUP_TASK_ID],
      { windowsHide: true, timeout: 20_000 },
      (error, stdout, stderr) => {
        const reading = error ? UNREAD : parseReading(stdout);
        if (reading.task === 'unknown') {
          log(`startup task ${action} failed: ${stderr.trim() || error?.message || stdout.trim()}`);
        }
        resolve(reading);
      },
    );
  });
}
