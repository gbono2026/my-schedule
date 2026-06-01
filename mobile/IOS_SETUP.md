# Meridian → Native iOS app (Capacitor + HealthKit + TestFlight)

This turns the existing Meridian web app into a real iOS app with **native Apple
HealthKit access** and **native local notifications**, distributed to your phone
via **TestFlight**. The app loads your live (self-updating) website, so the AI
"edit the app" feature keeps working — you only rebuild in Xcode when you change
native plugins, the icon, or the app version.

> All the web-side code is already done and committed. This file is the part that
> needs **your Mac** and **your Apple Developer account**.

---

## 0. One value to confirm first

Open `mobile/capacitor.config.json` and check **`server.url`**. It must be the
URL you currently open the web app at on your phone. It's currently set to:

```
https://gbono2026.github.io/my-schedule/
```

If that's wrong, fix it (it's the only place that needs changing).

---

## 1. Apple Developer Program — enroll (do this first; can take 24–48h)

You need this for TestFlight ($99/year).

1. Make sure your Apple ID has **two-factor authentication** on.
2. Go to **developer.apple.com/account** → **Enroll** (or use the *Apple Developer*
   app on iPhone, which is the fastest).
3. Entity type: choose **Individual / Sole Proprietor** (uses your legal name —
   simplest, no D-U-N-S number needed).
4. Enter legal name, address, and pay the **$99** annual fee.
5. Accept the license agreement.
6. Wait for the approval email. Sometimes instant, sometimes a day or two.

While that's pending, you can do everything in Section 2 except the final upload.

---

## 2. On your Mac — build the iOS project

### Prerequisites
- **Xcode** (latest, from the Mac App Store) + open it once to install components.
- **Node.js 18+** and **CocoaPods** (`sudo gem install cocoapods`).
- Xcode → Settings → Accounts → **+** → add your Apple ID (the dev account).

### Generate the native project
From the repo root:

```bash
cd mobile
npm install
npx cap add ios       # creates mobile/ios/ (the Xcode project) — done once
npx cap sync          # installs the HealthKit + notifications plugins into iOS
```

### App icon (the web app has none yet)
Drop a **1024×1024 PNG** at `mobile/assets/icon.png`, then:

```bash
npx @capacitor/assets generate --ios
```

(Or set the icon manually in Xcode → `App/Assets.xcassets/AppIcon`.)

### Open Xcode
```bash
npx cap open ios
```

In Xcode, select the **App** target → **Signing & Capabilities**:

1. **Team**: select your Apple Developer account team.
2. **Bundle Identifier**: `com.gbono.meridian` (must be unique in your account;
   change it here *and* in `capacitor.config.json` if you want something else).
3. Click **+ Capability** and add **HealthKit**.
   - Leave "Clinical Health Records" and "Background Delivery" unchecked for v1.

### Info.plist — HealthKit usage strings (required, or the app is rejected/crashes)
Open `App/Info.plist` (right-click → Open As → Source Code) and add inside the
top-level `<dict>`:

```xml
<key>NSHealthShareUsageDescription</key>
<string>Meridian reads your steps, sleep, heart rate, HRV, weight and activity from Apple Health to show your daily wellness dashboard.</string>
<key>NSHealthUpdateUsageDescription</key>
<string>Meridian does not write to Apple Health.</string>
```

> Note: we only **read** HealthKit, so `NSHealthShareUsageDescription` is the one
> that matters. The Update string is included because Apple's tooling expects it.

### Re-sync after any config change
```bash
npx cap sync
```

---

## 3. Run on your own iPhone (quick test before TestFlight)

1. Plug in your iPhone, select it as the run target in Xcode, press **▶**.
2. On first launch the app loads your live site and prompts for **Health** access —
   tap **Turn On All** (or at least Steps, Sleep, Heart Rate, HRV, Weight,
   Active Energy, Walking+Running Distance).
3. Also allow **Notifications** when prompted (for rest-timer alerts).
4. Open the **Health** tab — within a few seconds the metrics should populate from
   HealthKit (the app POSTs them to `…/health/native` on your Railway server).

### Verify units after the first real sync
The bridge assumes: **sleep in hours**, **weight in your Health app's unit**,
**distance summed**. After the first sync, compare the dashboard against Apple
Health and the old Health Auto Export numbers. If anything is off (e.g. sleep
shows minutes, distance in meters vs miles), tell me the field + expected unit and
I'll adjust the conversion in `index.html` (`Native.syncHealth` / `readSleep`).

---

## 4. TestFlight (install without the 7-day expiry)

1. **App Store Connect** → appstoreconnect.apple.com → **Apps** → **+** → **New App**
   - Platform: iOS
   - Name: `Meridian` (if taken, use e.g. `Meridian Wellness` — only the store
     name must be unique; bundle ID is what links it)
   - Bundle ID: `com.gbono.meridian`
   - SKU: anything, e.g. `meridian-001`
2. In Xcode: set the run target to **Any iOS Device (arm64)** → menu **Product →
   Archive**.
3. When the Organizer opens: **Distribute App → TestFlight (Internal Only) →
   Upload**.
4. Back in App Store Connect → your app → **TestFlight** tab. Add yourself under
   **Internal Testing** (your Apple ID email). You'll get an email + the
   **TestFlight** app on your phone installs Meridian.
5. Internal TestFlight builds last **90 days** and don't need Apple review.

---

## 5. When do I need to rebuild in Xcode again?

Almost never. Because the app loads your live website:

- **Changing app content / fixing the UI / AI edits** → just update the site
  (your existing workflow). The app picks it up on next launch. **No rebuild.**
- **Changing native plugins, the icon, or bumping the iOS version** → `npx cap sync`,
  re-Archive, re-upload to TestFlight.

---

## Files in this folder

| File | Purpose |
|------|---------|
| `capacitor.config.json` | App ID, name, and the live `server.url` to load |
| `package.json` | Capacitor + HealthKit + LocalNotifications dependencies |
| `www/index.html` | Offline fallback (shown only if the live site is unreachable) |
| `ios/` | Generated by `npx cap add ios` on your Mac (git-ignored) |

The native behavior itself (HealthKit read + sync, local notifications) lives in
the main `index.html` under the `Native` module and works automatically inside the
app while staying a harmless no-op in a normal browser.
