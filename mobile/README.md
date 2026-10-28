# HW Attendance Admin

Free, locally built Android app for the **Super Admin** side of Homeweavers Attendance. The website and app use the same production API and database at `https://attendance.homeweavers.net`. No paid builder, additional hosted backend, or Play Store subscription is required to build the app.

## What is included

- Packaged HTML/JavaScript assets using Capacitor; no remote `server.url` wrapper.
- Super Admin sign-in, including the site's two-step flow and remember-me option.
- Bottom navigation: Overview, Attendance, Requests, Payroll, More.
- Daily staff cards that open the original attendance editor, plus the full month table.
- Original performance calculations, request approvals, leave balances, payroll, work logs, holiday management, user administration and backup tools.
- Payroll rows adapted into phone cards without replacing the existing payroll calculations.
- Android file import and system sharing for exports; Android printing / Save as PDF.
- Existing server authorization, edit versions and locked-month rules remain authoritative.
- Network interruption screen; reloading after reconnect avoids blindly resubmitting uncertain saves.
- Private app storage, disabled Android backups and protected screenshots / recent-app previews.

The office PC continues uploading biometric records. PC folder watching and direct loopback sync are not available on a phone. This app requires internet access for attendance operations. It does not queue offline edits or include employee data in the APK.

## Build

This folder should live at `HW_attendance/mobile`, beside the existing `src` and `public` folders. Its build reads those sources and writes only to `mobile/www` and `mobile/android`; it does not modify the website build or backend.

Requirements: Node 22+, Java 21, Android SDK platform 36 / build tools 36.0.0. Android Studio is optional if the command-line tools are installed. Accept Google's free Android SDK license before installing its components.

```powershell
npm ci
npm run sync
cd android
.\gradlew.bat assembleDebug
```

For a different source location, set `HW_ATTENDANCE_SOURCE` to the existing attendance repo before building.

The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`. It is suitable for local testing, not a release identity. The delivered release APK is signed with a private local key. Keep that key and its passwords safe: future APK updates must use the same key and a higher `versionCode`.

Release builds read `HW_RELEASE_STORE`, `HW_RELEASE_STORE_PASSWORD`, and `HW_RELEASE_KEY_PASSWORD` from the local environment, using alias `hw-attendance-admin`. Secrets and keystores are excluded from Git. Then run `gradlew.bat assembleRelease`.

On this PC, run `./Build-Android.ps1` from PowerShell to rebuild, test, sign and verify the release APK. Local SDK/JDK paths are in the ignored `.local-build.json`. The APK is copied to `artifacts/HW-Attendance-Admin-release.apk` with a SHA-256 checksum. Use `./Build-Android.ps1 -BuildType Debug` for a test build.

The private signing key is in `.signing/hw-attendance-admin.p12`. Its random password is stored in `.signing/password.clixml`, encrypted by Windows for this Windows user. Keep a secure backup of the key and a separately secured recoverable password before moving to a new PC or Windows account; the encrypted file alone is not portable. Never commit `.signing`, `.local-build.json`, or the SDK directories. Future releases must retain this key and increase `versionCode` in `android/app/build.gradle`.

## Install on Android

Copy `artifacts/HW-Attendance-Admin-release.apk` to your Android phone (Android 7.0 or newer), open it, and allow installation from that file manager if Android asks. Open **HW Attendance Admin** and sign in with your existing Super Admin account. The app uses the live attendance database, so changes made after signing in affect the same records as the website. Direct installation does not require a Play Store account.

## Preview and checks

```powershell
npm run build
npm test
npm run preview
```

Open `http://127.0.0.1:4178/phone`. This is a local sample-data preview, initially signed in as Demo Admin. It never contacts the production site, and cannot send emails. The preview server and fixtures are not copied into the APK.

Test real-device login, two-step login if enabled, remember-me, sign-out, resuming after backgrounding, Android back navigation, native imports, sharing and printing before routine use. The browser preview cannot prove native-device behavior.

## Updating and iOS

After changing the existing dashboard or the mobile adapter, run `npm run sync` and rebuild. API changes must be kept compatible with installed app versions. Website frontend updates are not downloaded automatically into the app.

The JavaScript/CSS app is reusable for a later iOS target. iOS needs its own native printing implementation and device checks, plus a macOS/Xcode build environment. This delivery builds Android only.
