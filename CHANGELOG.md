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

## 1.0.8

- **Flash order fixed: controller first, display last.** The display/meter is the DFU gateway that relays every flash command to the target component. Flashing it first rebooted the gateway and left the controller (BLDC) unable to enter DFU ("no C" at block 0). The app now flashes the controller first and the display last - the same order the manufacturer app uses - so a two-part flash completes both components.

## 1.0.7

- **Firmware flash reaches the controller.** After the last block the flasher now waits for the scooter's `rsq dfu_ok` result token, the way the manufacturer app does, rather than requiring a separate low-level acknowledgement the scooter does not always send. Previously the "no ACK for EOT" message could appear even after every block had transferred, which stopped the run after the meter and before the controller (BLDC) - so the speed patch, which lives in the controller, never got written.
- **Meter then controller flash reliably in sequence.** If the scooter reboots and reconnects between the two components, the app now waits up to 30 s for the link to come back and flashes the controller anyway, instead of aborting.
- **The patcher covers every NT5 variant.** Meter and controller for NT5 Max (9301/9701), Max+ (9201), Turbo (11101) and Ultra (9401), plus the Ultra X meter (an older build with nothing to patch). Builds that share a board id are told apart by their version word, and each is re-sealed with the correct CRC.
- **Debug log records the wire traffic and the flash.** With debug logging on, the log now carries the detected model (pid plus controller firmware version), every command and reply as hex, the drive-mode / speed-limit state whenever it changes, and each flash step with its result. That makes it possible to see exactly what the scooter does.

## 1.0.6

- **Firmware patcher and flasher.** Two new side-menu entries. The **Firmware Patcher** detects the connected model, downloads that model's own official stock firmware from NAVEE's public storage by itself (there is no URL to enter) and saves both the untouched original and an unlocked copy - speed cap, kickstart and cruise patched, with a fresh checksum - into Downloads, then hands the patched file to the flasher. The **Firmware Update** flasher writes the display/meter first and the controller (BLDC) second over Bluetooth with a live progress log, and can also flash a finished `.bin` you pick yourself. The whole DFU runs with no account and no user id. This brings back the firmware flashing that 1.0.0 had removed, now rebuilt for the NAVEE DFU (XMODEM over the NAVEE GATT service) rather than the `.hex` flashing that was stripped out then. Flashing is the highest-risk action in the app; it is for private ground and your own scooter.

## 1.0.5

- **Light controls.** A new Light section with auto light (the headlight comes on automatically while riding), a daytime running light switch and the tail light. Their state is read live from the scooter's report.
- **Zero-start shown only where it works.** Riding off without pushing (levels 0-2) is a USA-region feature; the scooter's meter clamps those levels away elsewhere. The app now hides them, plus the zero-start quick button, on non-USA units, so it no longer offers a setting the scooter discards.
- Named all four supported speed-release families in the README (XT5, UT5 Ultra X, E45/E60 Pro) and added an iOS pointer to the browser tool.

## 1.0.4

- **Fault codes now show their meaning.** The scooter reports a single number when something is wrong. The app decodes it - the codes are BCD-encoded on the wire, so byte 0x21 is E9, not 33 - against the official NAVEE fault table, which is one shared table across all models, and shows the plain-text cause in English and German. Controller codes are cross-checked against the firmware; any code outside the table is shown raw and never guessed. It all runs on the phone, with no server lookup.
- Documented the triple-tap speed-release gesture in the README, with a screenshot from the app.
- Corrected two stale claims: the error-report help no longer says the code has no meaning, and the README no longer states there is no in-app update (there has been one since 1.0.3).

## 1.0.3

- **In-app app update restored.** The app checks GitHub for a newer release on start and shows a banner in the settings; tapping it downloads the APK and opens the installer. This is the app's own update - not scooter firmware, which the app never writes. It had been removed together with the firmware-OTA cleanup in an earlier build, but it is a generic feature every build should keep, so it is back.
- Fixed the FileProvider Downloads path so the update installer's fallback can open the downloaded APK.
- Corrected PERMISSIONS.md and the GitHub release footer, which had wrongly stated that the app requests no install permission and runs no update check.

## 1.0.2

- **Removed the manual model dropdown.** Model detection is automatic from the serial pid on every connect, so the picker was redundant. The region test panel keys off the auto-detected model only.

## 1.0.1

- **Automatic model detection.** The connected model is read from the scooter's serial and shown in the settings. (1.0.1 also shipped a manual dropdown; it was taken out again in 1.0.2.)
- **Region write** on non-XT5 models - writes a two-letter region code to test a more permissive region. It is hard-blocked on the XT5 family (decided by the real hardware, not the picker) and asks for confirmation, because the screen goes dark and the scooter usually restarts.
- **Accepted state is now shown.** The immobilizer, cruise control, traction control and zero-start quick toggles colour in when the scooter reports the function active. Before this they never highlighted even when the scooter had accepted the command.
- **Zero-start quick toggle** lights up whenever a non-default kick-off level is set.
- **Sturdier frame reassembly** - the parameter report is framed by its length rather than by scanning for the end marker, so a payload that happens to contain the marker bytes no longer truncates it.
- Documentation brought in line with what the app already does.

## 1.0.0

The first NAVEE build.

The app now speaks to a NAVEE scooter and to nothing else. It is a feasibility study, not a finished product, and it comes with no warranty. NAVEE is a trademark of its owner and is used here descriptively: this is not an official NAVEE app and it is not affiliated with, endorsed by or connected to NAVEE.

### The Bluetooth transport speaks NAVEE

- The scanner looks for a scooter advertising a name that starts with `NAVEE`. The connection uses GATT service `0000d0ff-3c17-d293-8e48-14fe2e4da212` with `0000b002` for writes and `0000b003` for notifications.
- The frame codec was rewritten for the NAVEE layout: `55 AA 00 <cmd> <len> <payload...> <cksum> FE FD`, where the checksum is the sum of every byte from the leading `0x55` through the last payload byte, taken AND `0xFF`. A read frame leaves the length byte out. Factory frames carry the trailer `AE AD` instead of `FE FD`. On a received frame byte 5 is an error code and the data block starts at byte 6. Multi-byte values are little-endian.
- No account, no login, no user id. The scooter's command dispatcher has no authentication gate for the commands this app sends, so the encrypted 0x30/0x31 handshake is not used at all and nothing has to be registered anywhere.
- A clock sync (`0x6F` sub-command 6) is sent once, right after connecting.

### Scooter settings

Each setting is written on its own command and carries only what was touched:

- **Immobilizer** (`0x51`) - locks and unlocks the scooter electronically.
- **Cruise control** (`0x52`), **traction control** (`0x5F`) and the **eco / low-power** mode - simple on/off.
- **Zero-start** (`0x6A`) - the kick-off level (0 to 5). The quick toggle lights up whenever a non-default level is set.
- **Drive mode** (`0x58`) - the gear / riding level.
- **Display unit** (`0x55`) - km/h or mph on the scooter's own screen.

They read back from the `0x70` parameter block, together with the start speed, the limit speed and its enable bit, the maximum speed and the brake speed. The four quick toggles under the speed drums - immobilizer, cruise control, traction control and zero-start - now colour in when the scooter reports the function active, so an accepted command is visible at a glance.

### Speed release

The speed release changes how the scooter rides and is the reason for the legal notice. It is for private ground on your own scooter only; on a public road it voids the operating permit and the insurance. It sends the top drive mode to the XT5 family, which makes the meter command the unit's SKU top speed (the firmware clamps the result to the unit). It is also reachable by triple-tapping the km/h VCU tile on the main screen. Confirmed on an XT5 Ultra at 50.8 km/h; the rest of the family is code-derived but not yet ridden, and non-XT5 models ignore it.

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
- Dual-motor and motor-mode switches. A NAVEE scooter has one motor. (Traction control is a real NAVEE setting and stayed - see above.)
- Per-cell battery voltages.
- Every model name of the other make.

### Kept

Live dashboard, GPS ride recording with GPX export, offline navigation on Mapsforge maps with BRouter bicycle routing, the ride log with CSV and JSON export, SRT screen streaming, the debug log, the dark and light themes and the English and German interface.

### Identity

The application id is `com.laufbursche.edition.navee` and the app is called **NAVEE Edition**. It needs Android 10 (minSdk 29).
