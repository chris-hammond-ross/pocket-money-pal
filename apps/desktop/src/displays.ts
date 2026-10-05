/** The bits of Electron's `Display` the kiosk screen choice needs. */
export interface ScreenInfo {
  id: number;
  label?: string;
  size: { width: number; height: number };
}

/**
 * Which screen the kiosk opens on, in order:
 * 1. `PMP_DISPLAY` (an index), for development and odd set-ups;
 * 2. the screen picked in the tray, if it's still connected;
 * 3. the first screen that isn't the main one;
 * 4. the main screen.
 */
export function pickDisplay<T extends ScreenInfo>(
  displays: T[],
  primary: T,
  options: { envIndex?: string; savedId?: number } = {},
): T {
  const fromEnv = options.envIndex ? displays[Number(options.envIndex)] : undefined;
  const saved =
    options.savedId === undefined ? undefined : displays.find((d) => d.id === options.savedId);
  return fromEnv ?? saved ?? displays.find((d) => d.id !== primary.id) ?? primary;
}

/** "Screen 2: DELL U2419H (1920×1080)", "Screen 1 (2560×1440, main)". */
export function displayLabel(display: ScreenInfo, index: number, isPrimary: boolean): string {
  const name = display.label?.trim();
  const details = `${display.size.width}×${display.size.height}${isPrimary ? ', main' : ''}`;
  return `Screen ${index + 1}${name ? `: ${name}` : ''} (${details})`;
}
