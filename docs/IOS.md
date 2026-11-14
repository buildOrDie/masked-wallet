# MASKED for iPhone

The same app as [Android](ANDROID.md): the MASKED wallet in a Capacitor app (`ios/`, Swift Package Manager, iOS 14+).
When it leaves the screen (app switcher), it shows the MASKED splash, not the wallet. Not in the app yet:
connecting to websites.

## On your own iPhone (free, no Apple Developer account)

Needs a Mac with Xcode (App Store), Node 20+, and the RGB engine in `vendor/rgb-lib-wasm` (`bash engine/build.sh`).

```sh
npm install
npm run build:ios
npx cap open ios
```

In Xcode:
1. Click **App** (left, the blue icon) → target **App** → **Signing & Capabilities** → **Team** → Add an Account… →
   your Apple ID, then pick "(Personal Team)". If Xcode says the bundle identifier isn't available, change it to
   something of your own, e.g. `com.yourname.masked`.
2. Plug in the iPhone (or same Wi-Fi after the first time), pick it at the top of Xcode, press **Run ▶**.
3. First time only, on the iPhone: Settings → Privacy & Security → **Developer Mode** → on (it restarts), then
   Settings → General → VPN & Device Management → your Apple ID → **Trust**.

A free (Personal Team) install works for 7 days; press Run again to renew it.

## TestFlight and the App Store

Needs the Apple Developer Program. Apple takes crypto wallet apps only from an **organisation** account (a company
with a D-U-N-S number), not a personal one. Then: Xcode → Product → **Archive** → Distribute App → App Store
Connect, and invite testers in TestFlight.
