# Privacy Policy

Laufbursche Edition is built to keep your data on your device. This policy explains exactly what the app does and does not do with your data.

## The short version

The app collects nothing. There are no accounts, no analytics, no telemetry, no tracking, no ads and no third-party SDKs that phone home. Nothing about you is ever sent to the developer or to any manufacturer backend. The app does check GitHub for a newer version on start and, if you use the firmware patcher, downloads stock firmware from NAVEE's public storage - both are plain downloads that carry no account and no personal data (see below).

## What data the app handles - and where it stays

All of the following stays on your device and is never uploaded anywhere:

- Live scooter telemetry read over Bluetooth LE.
- Recorded GPS tracks (GPX files) and the ride log behind them.
- Your app settings and preferences.
- Debug logs.
- Downloaded offline maps, routing data and POI databases.

You can export a GPX track, a ride as CSV or JSON, or a debug log yourself - through the Android share sheet, or by saving a GPX into your own Downloads folder. Both are local operations on your phone; the app never uploads any of this on its own.

## The only network connections the app makes

The app makes network connections only in the cases below. Every one is either the local Bluetooth link to your scooter or a download - and, apart from the app-update check on start, each one happens only because you asked for it.

### 1. Bluetooth LE to your scooter

A local radio link to your scooter. This is not an internet connection - no data leaves your phone over the network for this. The app talks to the scooter directly: there is no account, no login and no manufacturer backend involved at any point.

### 2. Offline map, routing-data and POI downloads (HTTPS, on demand)

When you tap download or route into an area you do not yet have data for, the app downloads:

- offline vector maps from the Hochschule Esslingen mirror of download.mapsforge.org - base URL https://ftp-stud.hs-esslingen.de/pub/Mirrors/download.mapsforge.org/maps/v5/europe/ with a country map file appended (for example germany.map).
- bicycle-routing segments from the BRouter project server - base URL https://brouter.de/brouter/segments4/ with a 5x5-degree tile file appended (for example E5_N45.rd5).
- offline POI databases (camping and EV-charging points, built from OpenStreetMap data) from this project's GitHub Releases - base URL https://github.com/Laufbursche42/nv-lb-edition/releases/ with a country POI file appended (for example germany.poi). This is served by GitHub, so GitHub sees your IP and the requested file path when you download POI data.

These are public OpenStreetMap-based sources. This happens only on your explicit action - the app never downloads any of them on its own. Those servers (Hochschule Esslingen, BRouter and GitHub) can see your IP address and the requested file path (which country or tile you fetch). The app keeps this to a minimum: it sends a neutral fixed User-Agent (`NAVEE-LB-Edition`), no cookies, no account and no tracking parameters. All this traffic uses HTTPS; the app uses no cleartext HTTP.

These map, routing and POI downloads use the plain Java `HttpURLConnection`; there is no third-party HTTP library. The two other HTTPS requests the app can make - the app-update check and the firmware download described below - use the same plain connection. No host beyond the ones named on this page is ever contacted.

### 3. SRT screen streaming (only to your own server)

Screen streaming goes only to the server URL you configure yourself - typically your own local or LAN server. The stored URL is encrypted on the device using the Android Keystore (AES-256-GCM). SRT is its own transport, not HTTP; it can additionally be AES-encrypted by adding a passphrase to your SRT URL.

### 4. App-update check (HTTPS, on start)

On start the app asks GitHub once for the latest release of this project - https://api.github.com/repos/Laufbursche42/nv-lb-edition/releases/latest - to see whether a newer app version exists. This is the only connection the app opens without you asking for it. It reads a version number and a download link and sends nothing about you; no account is involved. If you then tap the update banner, the app downloads that release APK from GitHub and opens the Android installer, so you decide whether to install. GitHub sees your IP and the request. Nothing goes to the developer.

### 5. Firmware download for the patcher (HTTPS, on your action)

When you use the Firmware Patcher, the app downloads the connected model's own official stock firmware from NAVEE's public storage (https://myusnavee.s3.amazonaws.com) so it can patch it locally and flash it to the scooter over Bluetooth. This is a plain public file download - no account, no login, no user id and no personal data, the same stock firmware the manufacturer's own app fetches. NAVEE's storage server sees your IP address and which firmware file you requested. It happens only when you start a patch; the original and patched files stay in your Downloads folder on the phone.

## What the app does not do

- The app opens exactly **one** connection you did not trigger: the app-update check on start (section 4). Every other connection above is one you started yourself, and nothing runs in the background on its own.
- The only thing the app can install on your phone is its **own** app update, and only after you tap the banner and confirm in the Android installer (section 4). Scooter firmware is never installed on your phone - it is flashed to the scooter over Bluetooth, and only when you start it.
- **No account, no login and no user id anywhere.** The app reads values from the scooter over Bluetooth and writes back only the settings you change yourself. The one time it touches manufacturer infrastructure is the plain firmware download in section 5, which carries no account and nothing about you - no personal data is ever sent to a manufacturer backend.

One thing is worth naming for honesty: if an offline map point of interest carries a website address and you tap it, the app hands that address to your system browser. From that moment on it is your browser talking to that site, not this app.

## No developer or manufacturer backend

Nothing is ever sent to the developer or to any manufacturer backend. There is no cloud account and no server operated by this project that receives your data.

## Android permissions

Each Android permission the app requests is listed and explained in [PERMISSIONS.md](PERMISSIONS.md).

## Contact

For privacy questions, contact the author (Laufbursche) on GitHub: https://github.com/Laufbursche42
