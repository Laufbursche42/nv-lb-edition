# Changelog

Notable changes to Laufbursche Edition (NAVEE), newest first.

This history starts fresh with the NAVEE port. The app was forked from a Laufbursche Edition written for a different make of scooter, and none of that release history describes what this app does, so none of it is carried over.

The version series lives in `version.properties`, which both the gradle build and the release workflow read. `versionName` is `<major>.<minor>.<n>` where `n` counts the commits since the series began, so the number rises by one on every release with no manual editing. `versionCode` counts straight through a series change and never goes backwards.

Release notes are built automatically for each release: if this file has a section whose heading matches the released version it is used verbatim, otherwise the commit subjects since the previous release are listed. Either way a fixed Disclaimer and a "phoning home" note are appended (see `.github/release-footer.md`).

To hand-write the notes for a release, add a section headed with its version number at the top of the version list below, for example:

    ## 1.1.1
    - Fixed the light-mode toast readability
    - Corrected the immobilizer help text

If no matching section exists the notes fall back to the commit messages, so keeping this file up to date is optional.

## 1.1 - unreleased

The first NAVEE build. The series is 1.1 per `version.properties`; the patch number is filled in by the build from the commit count, and no release has been tagged yet, so this section is headed by the series rather than by a version and a date that do not exist.

The app now speaks to a NAVEE scooter and to nothing else. It is a feasibility study, not a finished product, and it comes with no warranty. NAVEE is a trademark of its owner and is used here descriptively: this is not an official NAVEE app and it is not affiliated with, endorsed by or connected to NAVEE.

### The Bluetooth transport speaks NAVEE

- The scanner looks for a scooter advertising a name that starts with `NAVEE`. The connection uses GATT service `0000d0ff-3c17-d293-8e48-14fe2e4da212` with `0000b002` for writes and `0000b003` for notifications.
- The frame codec was rewritten for the NAVEE layout: `55 AA 00 <cmd> <len> <payload...> <cksum> FE FD`, where the checksum is the sum of every byte from the leading `0x55` through the last payload byte, taken AND `0xFF`. A read frame leaves the length byte out. Factory frames carry the trailer `AE AD` instead of `FE FD`. On a received frame byte 5 is an error code and the data block starts at byte 6. Multi-byte values are little-endian.
- No account, no login, no user id. The scooter's command dispatcher has no authentication gate for the commands this app sends, so the encrypted 0x30/0x31 handshake is not used at all and nothing has to be registered anywhere.
- A clock sync (`0x6F` sub-command 6) is sent once, right after connecting.

### Scooter settings

Four settings are written, each one on its own command and each one carrying only what was touched:

- **Immobilizer** (`0x51`) - locks and unlocks the scooter electronically.
- **Cruise control** (`0x52`).
- **Zero start** (`0x6A`).
- **Drive mode** (`0x58`).

They are readable back from the `0x70` parameter block, together with the unit, the start speed, the limit speed and its enable bit, the maximum speed and the brake speed.

### What the pages read

- **Dashboard and telemetry** come from the realtime frames `0x90`, `0x91` and `0x92`.
- **Battery** comes from `0x72`: charge level, pack voltage, pack current with its sign bit, state of health, temperature and charge cycles. NAVEE does not send per-cell voltages over Bluetooth, so the page shows pack values only and says so rather than leaving an empty table.
- **Scooter info** reads the serial number (`0x74`) and the five firmware versions (`0x73`) for display, controller, BMS, screen and UWB.
- **Faults**: NAVEE reports a single numeric fault code in the realtime frame. What an individual code means is not documented, so the app shows the raw number and states that its meaning is unknown. It does not pretend to decode it.

### Taken out

Everything below was in the app this one was forked from and is gone. None of it applies to a NAVEE scooter, and shipping a control that quietly does nothing is worse than not shipping it:

- Firmware flashing over Bluetooth, the whole update protocol behind it and every `.hex` file.
- The in-app APK self-update.
- The identity rename that rewrote the vehicle number plus the speed unlock that rode on it.
- Per-gear profile editing.
- Dual-motor, motor-mode and traction-control switches. A NAVEE scooter has one motor.
- Per-cell battery voltages.
- Every model name of the other make.

### Kept

Live dashboard, GPS ride recording with GPX export, offline navigation on Mapsforge maps with BRouter bicycle routing, the ride log with CSV and JSON export, SRT screen streaming, the debug log, the dark and light themes and the English and German interface.

### Identity

The application id is `com.laufbursche.edition.navee` and the app is called **NAVEE Edition**. It needs Android 10 (minSdk 29).
