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

## 1.0.18

- **The switchable speed patch now covers the whole fleet where it is technically possible.** Every downloadable NAVEE firmware was checked. On top of the performance line, the patcher now builds lock/unlock controller firmware for the city and commuter models - S40, S60, S2, V25 / V25i, V50i Pro, V45i, N65i, E20 Lite / E25 Go, UT3 Max - the G5 line (G5, G5 Pro, G5 Max) and the UT5 Max. Same capZ top-gear latch as before: boots throttled to about 22 km/h, the speed release opens the top gear to the motor limit and every restart re-locks. Only the top gear changes. Where a model needs it (UT3 Max, S2, UT5 Max) the patched meter also routes the unlock signal to the controller; the rest forward it on their own.
- **Cruise and zero start (kick-start) were byte-traced on every meter.** Each firmware's command dispatcher was enumerated and the region/state gate located, so the status is verified, not inferred. Newly unlocked by the patcher where the feature is region-gated: E20 Lite / E25 Go (both), E45 / E60 Pro (both), UT5 Max (both), UT5 Ultra X (both), ST5 Pro / Max (both), N65i II 10701 (both), E20 / E25 (cruise), S2 (cruise), K100 Max (kick-start). Already ungated and working stock in every region (no patch): G5, GT5 Pro / Max, UT3 Max (both), NT5 Ultra X (both), N65i II 6001 (both), S40 / S60 (cruise), XT5 (cruise), V40i Pro II (cruise), K100 Max (cruise). Genuinely not in the firmware (complete command table enumerated): S40 / S60 (kick-start), E20 / E25 (kick-start), V40i Pro II (kick-start), Birdie 3 / 3x (both). Could not be verified so nothing is flipped there - proven, not guessed: N65i and V45i (compressed meter body), K100 / K100 Pro (compressed), and the V-series V25 / V25i / V50i Pro (the meter OTA image dispatches through an external SDK ROM that is not part of the flashable file). The README carries the full per-model table.
- **Honest limits.** Some models cannot be switched safely and are deliberately left stock: the E45 / E60 Pro (top speed is a hard-wired flash constant), the V40i / V40i Pro II / V3 Pro and the N65i II builds (no boot-seedable speed cell), the K100 line (encrypted meter body, Cortex-M0 controller) and the Birdie 3 / 3x (display bridge with no throttle path). The patcher recognises these as stock and simply does not offer speed there. The EXO S Pro is not a scooter at all and is ignored.
- **Safer image matching.** The 3553G controller entries (NT5 Max / Ultra) now pin the exact build by CRC, so a UT5 Max or XT5 controller image is no longer mis-identified as an NT5 build; a wrong or foreign file is cleanly refused instead.
- **The live controls now match each model's firmware.** Cruise and zero-start only appear where that model's firmware actually supports them: shown where they work stock or the patch enables them, hidden where the firmware proves them absent, and still shown (to try) where the meter is unreadable. The same per-model scope is shared with the web control tool, so both offer exactly what the scooter can do.
- **First flash of any newly added model belongs on a recoverable unit.** Every patch here is byte-verified and re-seals deterministically; the on-vehicle confirmation ride is still owed.

## 1.0.17

- **Choose what to patch.** The patcher now shows a checkbox per feature after it detects your model - speed unlock, cruise control, zero start (kick-start), and the individual beep silences - in both the app and the web patcher. Only the ticked features are written; the rest of the firmware stays stock. Works for every supported model.
- **The beeps are back by default.** The old patch silenced the whole buzzer, which also killed the confirmation blip when you toggle a setting. Now nothing is silenced unless you tick it, so the confirmation beep returns. You can silence the over-speed warning on its own (available on every model), and where the firmware allows it, the find-me / alarm tone and the startup / error melody, each as its own checkbox. The confirmation blip is always kept.
- **Disclaimer before patching.** A bilingual note now sits right before the patch button in both tools: private ground only, speed unlock voids the road approval (ABE), and the scooter may then no longer be used in public road traffic.
- **XT5 in the patcher.** The XT5 (Pro, Ultra, Max) is now offered in the patcher for zero start plus its beep options; speed stays flash-free (drive mode 4) and cruise already works on stock, so the patcher does not touch the XT5 controller.

## 1.0.16

- **Readable firmware file names.** The patcher now saves the downloaded stock firmware and its patched copy under a readable name - model, component and version, for example `NT5_Max_bldc_0.0.0.6.bin` plus `NT5_Max_bldc_0.0.0.6-patched.bin` - instead of the cryptic hex name from the download URL. The original is the file without `-patched`; the patched copy carries `-patched`. Works for every supported model.

## 1.0.15

- **Cruise control and zero start on the XT5 (Pro, Ultra, Max).** Cruise already works on the XT5 with no patch at all - the display firmware accepts and stores it unconditionally, so the app toggle takes effect flash-free (verified end to end across all three XT5 meters, which are byte-identical). Zero start (kickstart) needs one small display-firmware patch: stock firmware floors the low start levels 0 to 2 outside the USA region, and the patched XT5 meter opens levels 0 to 2 in every region while staying app-switchable. Speed on the XT5 stays flash-free as before (drive mode 4 over Bluetooth).
- **The patcher skips components it has no patch for.** On a model where only one component is patchable - like the XT5, whose controller stays flash-free - the patcher now patches the supported component and skips the rest cleanly, instead of stopping with an error.

## 1.0.14

- **Cruise control and zero start now switch on across the NT3, GT3 and ST3 firmware too.** The meter firmware the patcher builds for NT3 (Pro, Max) and the GT3 / ST3 family (GT3, GT3 Max, GT3 Pro, ST3, ST3 Pro) now lets the app's cruise control and zero-start toggles actually take effect, the same way the NT5 meters already did. On those builds both were previously accepted but silently ignored. Only the guarding region gate is opened; nothing about the speed changes.
- **GT5 Max controller is now built too.** The switchable speed patch now covers the GT5 Max as well, so the whole GT5 pair (Pro and Max) is done. It boots throttled to about 22 km/h, opens the top gear with the speed release and re-locks on every restart, exactly like the others.
- On the GT5 (Pro and Max) the firmware does not region-gate cruise control or zero start at all, so the app's own toggles already take effect there without a patch; both were traced end to end through the meter frame builder and the controller. The Ultra X likewise starts from zero without a patch.
- These controller and meter patches change code inside the scooter and have been verified statically; a first flash belongs on a recoverable unit.

## 1.0.13

- **GT5 Pro joins the switchable speed patch.** The patcher now builds lock/unlock controller firmware for the GT5 Pro as well, alongside the NT5, NT3, GT3 and ST3 families. It boots throttled to about 22 km/h, opens the top gear with the speed release and re-locks on every restart, exactly like the others; only the top gear changes. Reaching the GT5's controller meant reading its full display firmware: its control frame carries the drive mode in a different byte than the earlier models, and the display had to be taught to pass the unlock through for one frame while the handlebar gear button keeps working normally.
- **GT5 Max is not built yet.** It shares the patched display firmware with the GT5 Pro, but its controller is a different build that still needs its own patch. Every other performance model (NT5, NT3, GT3 family, ST3, ST3 Pro, GT5 Pro) is covered.
- The controller patch changes code inside the scooter and has been verified statically; a first flash belongs on a recoverable unit.

## 1.0.12

- **Switchable speed patch for the whole NT / GT3 / ST performance line.** The firmware patcher now builds lock/unlock controller firmware for the NT5 family, NT3 (Pro, Max), GT3 (GT3, GT3 Max, GT3 Pro) and ST3 (ST3, ST3 Pro), not only the NT5 Max. Every build boots throttled to about 22 km/h, opens with the speed release and re-locks on each restart. Only the top gear changes; the lower gears and eco keep their stock feel. As before the cap lives in RAM and is seeded at boot, so it is never a permanently open firmware.
- **The unlock now removes the cap fully.** Instead of a fixed ceiling the top gear opens to what the motor itself allows, well above the previous ~40. The ST3 Pro was raised to match. The real top speed is whatever the motor can hold, so a first flash belongs on a recoverable unit.
- **The over-speed warning beep is silenced on the GT3 / ST3 and NT3 meters too**, the same way it already was on the NT5 meters. Real fault tones are unaffected on the models where a single warning tone could be isolated.
- **Each patched build reports its own controller version** so Scooter Info shows that our firmware is on the scooter, and the app sends the matching lock/unlock command for it.
- GT5 (Pro, Max) is not covered yet and the XT5 family stays flash-free (drive mode 4). These controller patches change code inside the controller and have been verified statically.

## 1.0.11

- **Native GPS route recording.** A foreground service records the ride as a GPX track and keeps logging with the screen off, so a locked phone in a pocket still captures the route. Recorded tracks import into the ride log.
- **Dashboard fits one screen.** The main tiles are laid out two per row and scaled so the set fills a single screen without scrolling, and the pack current sits in the battery detail list the way the NAVEE app shows it, rather than as a large tile.
- **Zero start appears on patched firmware.** The kickstart patch removes the region clamp, so the zero-start setting shows up once the patched firmware that accepts it is flashed.

## 1.0.10

- **Gear changes no longer drop the speed unlock.** On a patched scooter the controller now latches the unlock: changing the drive mode or gear after unlocking keeps the full speed, and only an explicit lock command or a restart returns it to about 22 km/h. Before this, any mode change re-locked the scooter.
- **The over-speed warning beep is silenced on patched firmware.** A de-restricted controller asserts an over-speed warning above its former limit, which the meter turned into a continuous beep past about 30 km/h. The patched meter suppresses that one warning tone while every real fault tone still sounds.
- **Lock and unlock use two paths by model.** The XT5 family plus UT5, E45 and E60 keep their flash-free speed release unchanged. Every other model runs the capZ firmware and locks or unlocks over the drive-mode command; the app picks the path from the controller version marker, so no model loses its existing way.

## 1.0.9

- **Lock and unlock the speed with a firmware patch (NT5 Max / 9301).** The patcher now builds controller firmware that boots throttled to about 22 km/h and can be opened to full speed (about 44) with the existing speed release, then re-locks itself to 22 on every restart. It never ships a permanently open firmware: the cap lives in RAM and is seeded at boot, so a reboot always returns to the throttled state. The patched firmware also reports its own version (controller 5.5.5.6, display 5.0.2.2), so Scooter Info shows that our build is on the scooter. This changes code inside the controller and has been verified statically; the first flash belongs on a recoverable unit.

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
