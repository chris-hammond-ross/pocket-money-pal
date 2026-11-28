# apps/mobile: the Android apps

Thin shells, like `apps/desktop`. There's no business logic here (ADR 0001). `android/` is one Gradle project, with a module per app (ADR 0033, ADR 0034):

| Module        | What it is                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kiosk`       | The kiosk app (`com.pocketmoneypal.kiosk`): runs the same server on the device and shows the kids' screen. Phones pair with the device as they would with a PC.                                                                                                           |
| `shell`       | An Android library both apps use: the WebView setup (text size fixed at 100%, sounds without a tap, other sites in the browser, the user-agent marker), the page↔app bridge (`NativeBridge`), the theme and the colours.                                                  |
| `build-logic` | Not an app: Gradle plugins for what the apps share. `pmp.android-app` sets the SDK levels, the version and version code, and release signing with the upload key. `pmp.android-library` sets the SDK levels for `shell`. The Android Gradle Plugin's version is set here. |
| `parent`      | The parents' app (`com.pocketmoneypal.parent`): the family server's `/parent` in a WebView, with a code scanner for pairing and the family's addresses (ADR 0035).                                                                                                        |

The page talks to the app around it through a small bridge. Its contract (message names and shapes, `bridgeVersion`, `nativeCan`) is in `packages/shared/src/native-bridge.ts`, and the web side is `apps/web/src/lib/native.ts`. The parents' app implements it (`NativeBridge` in `shell`); the kiosk page doesn't use it.

## The kiosk app

- **The server** runs in `ServerService`, a `specialUse` foreground service in its own process (`:server`). That's Node 24 for Android ([fogtape/nodejs-mobile](https://github.com/fogtape/nodejs-mobile), pinned in `node-mobile.json`) running `server.mjs`. It holds a partial wake lock and a Wi-Fi lock, and starts again after a reboot or an update (`BootReceiver`).
- **SQLite** is Node's built-in `node:sqlite`. The server is bundled with `better-sqlite3` swapped for `apps/server/src/db/node-sqlite-compat.ts` (`build.mjs --node-sqlite`), so there's no native module to build for Android. CI runs the whole server suite on that shim.
- **The kids' screen** is `MainActivity`: a WebView on `http://localhost:4789/kiosk`, full screen and landscape. It's an ordinary app on a family tablet, not a locked kiosk: Back leaves it and the screen sleeps as usual, while the server carries on. On first run it asks once each for notifications and the battery-optimisation exemption.
- **The notification** opens the kids' screen. It has no actions.
- **Unpair all phones** (ADR 0030) is Android's "Additional settings in the app" (Settings → Apps → Kids Board), not in the notification where kids can reach it. It asks for the device's screen lock first (ADR 0032).
- **The data** is in app-private storage (`no_backup/data/pmp.db`), left out of Android's backups. Families move between a PC and a tablet with the app's own backup and restore (ADR 0020).

Decisions: ADR 0029 (the spike) and ADR 0032 (this app).

## The parents' app

- **What it is:** `MainActivity`, a WebView on the family server's `/parent`, as an ordinary portrait phone app: the status bar and Android's navigation stay, and the page is padded so nothing sits under them. Every screen and rule is the server's (ADR 0033).
- **First run** (and after the phone is unpaired): "Scan the code on the family screen" with Google's code scanner (Play services shows the camera, so the app has no camera permission), or "Type the address instead". The scanned `/parent/pair?code=…` (or `/setup?token=…`) link opens in the WebView, and pairing is the normal web flow.
- **Addresses** (`Addresses`): the paired page reports the family's addresses through the bridge's `session` message. The app opens the secure one (the relay) when `/api/health` answers there, the home address when it doesn't, and copies the `pmp_device` cookie between them, so it's one paired device on every address. Turning on remote access switches the app over by itself.
- **Can't reach the PC:** HTTPS has the page's service worker (ADR 0017). On plain HTTP the page is retried from the WebView's own cache, so the web app's own "Can't reach the family PC" shows and keeps trying; with nothing cached, the app's native screen with Try again.
- **Unpaired** (from another phone, or Unpair all): the page reports `session { paired: false }`; the app asks the server with its token, and on a 401 forgets the addresses and cookies and shows the first-run screen.
- **The bridge** (`NativeBridge` in `shell`) answers `info`, `scanQr`, `openExternal` and `session`, for the family's own addresses only.
- **Launcher label** **PMP Parent**; the icon is the kiosk's pig on gold. Cleartext is allowed everywhere (LAN addresses can't be listed). `targetSdk` 36 needs no local-network permission; 37 will (ADR 0035).

Decisions: ADR 0033 and ADR 0035.

## Build

You need Android Studio (its JDK and SDK; Gradle fetches the NDK and CMake it needs) and the repo's usual Node setup.

```sh
npm run mobile:apk                                    # the kiosk app: debug APK, all ABIs
npm run apk:kiosk -w @pmp/mobile -- -Ppmp.abi=arm64-v8a   # one ABI only: a smaller APK for one device
npm run mobile:release                                # the kiosk app: signed release APK and the Play bundle (.aab)
npm run mobile:apk:parent                             # the parents' app: debug APK
npm run mobile:release:parent                         # the parents' app: signed release APK and .aab
```

The parents' app has no server inside, so its scripts (`apk:parent`, `release:parent`) are Gradle alone. Its outputs are in `android/parent/build/outputs/` (`parent-debug.apk`, `parent-release.apk`, `parent-release.aab`). The debug build is `com.pocketmoneypal.parent.debug` ("Parent (debug)"); `chrome://inspect` on the PC can debug its WebView. Logs: `adb logcat -s PmpParent PmpShell`.

`mobile:apk` and `mobile:release` (the kiosk) run `npm run build` first. The per-app scripts in `@pmp/mobile` (`apk:kiosk`, `release:kiosk`) expect it built. The kiosk's run:

1. `scripts/fetch-node.mjs`: downloads Node for Android once into `.cache/`, and checks its SHA-256.
2. `scripts/stage-server.mjs`: bundles the server for `node:sqlite` and stages it, with the web app, in `.stage/assets/server`.
3. Gradle (`scripts/gradle.mjs`). It uses `JAVA_HOME` and `ANDROID_HOME`, or Android Studio's defaults.

Outputs are in `android/kiosk/build/outputs/`: `apk/debug/kiosk-debug.apk`, `apk/release/kiosk-release.apk` and `bundle/release/kiosk-release.aab`. Before session 12.1 the module was called `app`, and the files `app-*.apk`.

- The launcher label is **Kids Board** (ADR 0033); the debug build is `com.pocketmoneypal.kiosk.debug` ("Kids (debug)"), so it installs beside a release build. Both use port 4789, so only one can run at a time.
- `-Ppmp.versionCode=N` overrides the version code, to test an update over an existing install. By default it comes from the repo version: `1.2.3` → `1002003`. In PowerShell, quote it (`'-Ppmp.versionCode=N'`), or PowerShell splits it at the dot. Once a device has a higher code, a default build won't install over it (`INSTALL_FAILED_VERSION_DOWNGRADE`): keep raising it, or `adb install -r -d` for a debug build.
- Server logs go to logcat: `adb logcat -s PmpServer PmpShell`.

## The upload key

Release builds of every app are signed with the **upload key** (set up by `pmp.android-app`). Google re-signs what Play delivers (Play App Signing). The key is never in the repo. Gradle reads a properties file, by default `~/.pocket-money-pal/android-upload.properties`. `-Ppmp.signing=<file>` or `PMP_ANDROID_SIGNING` points elsewhere.

```properties
storeFile=android-upload.jks      # relative to this file
storePassword=…
keyAlias=upload
keyPassword=…
```

Back up both files together, somewhere private (a password manager's file attachments, or an encrypted USB stick). If the upload key is lost, Play can reset it, after a request from the developer account, but that takes days. Without the properties file a release build stops with a message; debug builds don't need it.

## Icons

`scripts/android-icons.ps1` makes the kiosk's launcher icons from `apps/desktop/build/icon.png`. The notification and themed icons are the pig's outline, as vectors in `res/drawable/`. The parents' app needs no PNGs: its adaptive icon is the pig as a vector (`ic_launcher_foreground.xml`) on gold, which every Android it runs on (8+) supports.
