// Runs the Gradle wrapper in android/ with the given tasks, e.g. `node scripts/gradle.mjs
// assembleDebug`. Gradle needs a JDK (17+) and the Android SDK: JAVA_HOME and ANDROID_HOME, or
// Android Studio's own JDK and SDK in their default places.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const android = resolve(import.meta.dirname, '../android');
const env = { ...process.env };
const win = process.platform === 'win32';

if (!env.JAVA_HOME) {
  const studioJdk = win
    ? 'C:\\Program Files\\Android\\Android Studio\\jbr'
    : '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
  if (existsSync(studioJdk)) env.JAVA_HOME = studioJdk;
}
if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) {
  const sdk = win
    ? join(env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
    : join(homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
  if (existsSync(sdk)) env.ANDROID_HOME = sdk;
}

// Full path: cmd may be set not to look in the current folder (NoDefaultCurrentDirectoryInExePath).
const wrapper = join(android, win ? 'gradlew.bat' : 'gradlew');
const result = spawnSync(win ? `"${wrapper}"` : wrapper, process.argv.slice(2), {
  cwd: android,
  env,
  stdio: 'inherit',
  shell: win,
});
process.exit(result.status ?? 1);
