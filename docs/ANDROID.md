# MASKED for Android

The Android app is the MASKED wallet itself (the same code as the Chrome extension) inside a
[Capacitor](https://capacitorjs.com) app: Public, Shielded, Ecash, Ordinals and RGB, with the RGB engine
built with swaps. Not in the app yet: connecting to websites (the `window.masked` provider); that needs an
in-app browser and comes next.

- App id `com.maskedwallet.app`, version = `package.json` (2.29.10 → versionCode 22910)
- `scripts/build-mobile.mjs` builds the wallet's files into `dist/mobile` (the extension build without the
  background, the website provider and the manifest); `npx cap sync android` copies them into `android/`
- Network calls go through Capacitor's native HTTP (`CapacitorHttp`), as the extension's host permissions did
- Screens are kept out of screenshots and the recent-apps preview (`FLAG_SECURE`); app data isn't backed up to
  the cloud (`allowBackup="false"`). Your recovery phrase and the RGB backup are how you restore

## Build on GitHub

Actions → **Android app** → Run workflow. About 20–30 minutes (it builds the RGB engine first). Download the
`masked-android` artifact: `masked-<version>-debug.apk` installs on a phone for testing.

For Google Play, add four repository secrets (Settings → Secrets and variables → Actions):
`ANDROID_KEYSTORE_BASE64` (`base64 -i masked.keystore`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`. The run then also makes a signed `masked-<version>.apk` and `masked-<version>.aab`
(the file Google Play takes). Keep the keystore safe: every update must be signed with the same key.

## Build on a Mac

Android Studio (it brings the Android SDK), Node 20+, and the RGB engine in `vendor/rgb-lib-wasm`
(`bash engine/build.sh`), then:

```sh
npm run build:android
npx cap open android   # Android Studio: Run ▶ on a phone or emulator
```
