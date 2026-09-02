# Android Permissions

This app requests only the permissions it needs to function. The list below matches `app/src/main/AndroidManifest.xml` exactly, with the reason each one is used.

## Bluetooth

- **BLUETOOTH** (maxSdkVersion 30) - connect to the scooter over Bluetooth on Android 11 and older.
- **BLUETOOTH_ADMIN** (maxSdkVersion 30) - manage the Bluetooth adapter and start scans on Android 11 and older.
- **BLUETOOTH_SCAN** (neverForLocation) - find your scooter when connecting. It is flagged `neverForLocation`, so scanning is not used to derive your location.
- **BLUETOOTH_CONNECT** - talk to the scooter over Bluetooth LE on Android 12 and newer.

## Location

- **ACCESS_FINE_LOCATION** - required by Android for BLE scanning on older versions and used for GPS speed, route recording and offline navigation.
- **ACCESS_COARSE_LOCATION** - the coarse counterpart to the above, for the same BLE-scan and GPS needs. (Because BLUETOOTH_SCAN is flagged `neverForLocation`, scanning itself does not derive location.)

## Network and services

- **INTERNET** - download offline maps, routing data and POI databases on your explicit action, plus send the SRT screen stream to your own server. Nothing else uses it.
- **FOREGROUND_SERVICE** - run long-running jobs (map download, ride logging, navigation, screen streaming) as a foreground service so they keep running with the screen off.
- **FOREGROUND_SERVICE_MEDIA_PROJECTION** - the foreground-service type that lets screen streaming run as a foreground service.
- **FOREGROUND_SERVICE_DATA_SYNC** - the foreground-service type for the offline map download, so a large download keeps running with the screen off.
- **FOREGROUND_SERVICE_CONNECTED_DEVICE** - the foreground-service type for the ride logger, so an active ride keeps recording and the Bluetooth link to the scooter stays up with the screen off.
- **FOREGROUND_SERVICE_LOCATION** - the foreground-service type for an active navigation session, so turn-by-turn guidance keeps running when you leave the map screen.
- **POST_NOTIFICATIONS** - show the download, ride-logging, navigation or streaming progress notification.
- **WAKE_LOCK** - keep the CPU awake during a background download.
- **ACCESS_WIFI_STATE** - keep Wi-Fi awake during a background download.

## Permissions this app does NOT request

For clarity, since some scooter apps do ask for these:

- No **REQUEST_INSTALL_PACKAGES** - the app has no way to install anything on your phone.
- No storage permissions - maps, rides and logs live in the app's own app-specific directories, and saving a GPX file into your Downloads folder goes through MediaStore, which needs no permission from Android 10 (minSdk 29) on.
- No camera, microphone, contacts, phone or account permissions.

## Note for Google Play

On Google Play these permissions are additionally declared and justified in the Play Console (the Data Safety form and the permission declarations).
