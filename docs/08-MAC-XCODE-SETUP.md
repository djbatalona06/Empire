# 08 · Mac setup for the iPhone and Android apps (and how Claude sees them)

One-time setup for the MacBook, about 45 minutes (plus 15 for Android). You do this part. After it, Claude can build and check both apps two ways.

## How the bridge works

```
                 ┌──────────── Lane 1: cloud (always on) ────────────┐
 Claude (cloud) ─┤ push code → GitHub runners (Mac + Linux):          │
      ▲          │   start local API → seed demo data (Playwright)    │
      │          │   → iPhone simulator + Android emulator            │
      │          │   → tap every screen (XCUITest / Compose tests)    │
      │          │   → screenshots → ci-shots branch + PR checks      │
      └──────────┤ ← Claude reads logs + screenshots, fixes, pushes   │
                 └────────────────────────────────────────────────────┘

                 ┌──────────── Lane 2: your Mac (when it is open) ────┐
 Claude Code  ───┤ XcodeBuildMCP → Xcode + simulator on your Mac      │
 (on the Mac)    │ Gradle + adb  → Android emulator on your Mac       │
                 │ build, run, tap, screenshot, read logs, live       │
                 └────────────────────────────────────────────────────┘
```

- **Lane 1** is the main one. Each pull request runs `.github/workflows/ios.yml` (iPhone simulator), `.github/workflows/android.yml` (Android emulator) and `.github/workflows/worker.yml` (API + admin console in a real browser). Screenshots land on the `ci-shots` branch under `pr-<number>/ios`, `pr-<number>/android`, `pr-<number>/admin-desktop` and `pr-<number>/admin-phone`.
- **Lane 2** is for fast, hands-on work. A Claude Code session running *on your Mac* drives the simulator directly.
- Neither lane needs a paid Apple Developer or Google Play account. You need those only to ship to real users (Phase 5b and 7).

## 1 · Xcode (iPhone app)

1. Mac App Store → install **Xcode** (26 or newer). Open it once and accept the license. When asked which platforms to install, pick **iOS**.
2. Terminal:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app
   xcodebuild -runFirstLaunch
   xcrun simctl list devices available | grep iPhone   # should list iPhones
   ```
3. Optional, for help inside Xcode: **Xcode → Settings → Intelligence** → sign in with your Claude account.

## 2 · Tools

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"   # Homebrew, if missing
brew install xcodegen node@22 git
```

## 3 · Get the code

```bash
mkdir -p ~/Downloads/"AI projects" && cd ~/Downloads/"AI projects"
git clone https://github.com/djbatalona06/Empire.git
cd Empire
```

## 4 · Run the API (terminal tab 1)

```bash
cd worker && npm ci && cd ..
e2e/start-api.sh          # migrates, loads demo data, serves http://localhost:8787
```

Leave it running. Open http://localhost:8787 and sign in as `admin@dealerdoor.test` to see the admin console.

## 5 · Your first Xcode build (terminal tab 2)

```bash
cd e2e && npm ci && npm run seed:customer && cd ..   # adds customer@dealerdoor.test with an order + invoices
cd ios && xcodegen && open DealerDoor.xcodeproj
```

In Xcode, pick an iPhone simulator at the top, then press **⌘R**. Sign in as:

| Who | Email |
|---|---|
| Field coworker | `rep1@dealerdoor.test` |
| Customer | `customer@dealerdoor.test` |

There's no password and no email to check. In development the app signs you in right away.

To run the same UI tests CI runs: **⌘U** in Xcode, or
```bash
xcodebuild test -project DealerDoor.xcodeproj -scheme DealerDoor -destination 'platform=iOS Simulator,name=iPhone 16'
```
(swap in a simulator name from step 1 if `iPhone 16` isn't installed).

`project.yml` is the source of truth. Run `xcodegen` again after pulling changes that add files. Don't edit `DealerDoor.xcodeproj` by hand; it's regenerated and ignored by git.

## 6 · Lane 2: Claude Code on the Mac

```bash
npm install -g @anthropic-ai/claude-code
cd ~/Downloads/"AI projects"/Empire
claude mcp add XcodeBuildMCP -- npx -y xcodebuildmcp@latest mcp
claude
```

Then ask: *"Build DealerDoor for the iPhone simulator, run it, sign in as rep1@dealerdoor.test and screenshot the route map."*

- XcodeBuildMCP (open source, by Sentry) gives Claude tools to build, launch, tap, type and take screenshots in the simulator.
- Optional: newer Xcode versions also ship their own MCP bridge (`xcrun mcpbridge`). Try `claude mcp add xcode -- xcrun mcpbridge`. If the command isn't found, your Xcode doesn't have it yet, and XcodeBuildMCP covers everything.
- Optional: turn on **Remote Control** in that session to steer it from your phone.

## 7 · Android on the Mac (Android Studio)

1. Install **Android Studio** from https://developer.android.com/studio. Open it once and let the setup wizard install the Android SDK and an emulator (a "Medium Phone" on API 34 or newer is fine).
2. **File → Open** → choose the `android` folder inside `Empire`. Let Gradle sync finish (first time takes a few minutes).
3. Keep the API from step 4 running. Pick the emulator at the top and press **▶ Run**. Sign in as `rep1@dealerdoor.test` or `customer@dealerdoor.test`, same as on iPhone.
   The emulator reaches your Mac at `10.0.2.2:8787`. That address is already set for debug builds.
4. To put the location at SeaTac: emulator **⋯ → Location**, search "SeaTac City Hall", **Set location**.
5. Run the UI tests: right-click `app/src/androidTest` → **Run 'Tests in…'**, or in Terminal:
   ```bash
   cd android && ./gradlew connectedDebugAndroidTest
   ```
6. On a real Android phone (USB debugging on, same Wi-Fi as the Mac):
   ```bash
   ./gradlew installDebug -PapiBaseUrl=http://<your-mac-ip>:8787
   ```

## 8 · Watching progress

- **PR checks**: `iOS app / ui-tests`, `Android app / ui-tests` and `Worker API / e2e` show ✅ or ❌. The run's **Summary** tab has a pass/fail table.
- **Screenshots**: on GitHub, switch the branch picker to `ci-shots`. Claude also publishes a private "DealerDoor Build Progress" page after each round.

## Troubleshooting

| Symptom | Fix |
|---|---|
| App says "Couldn't load" | The API in tab 1 isn't running. Run `e2e/start-api.sh` again. |
| Sign-in error in the simulator | Check http://localhost:8787 opens in Safari on the Mac. |
| `xcodegen: command not found` | `brew install xcodegen` |
| Customer tab is empty | `cd e2e && npm run seed:customer` |
| Build error about signing | You picked a real iPhone. Pick a simulator until you have an Apple Developer account. |
| Android app says "Couldn't load" | The API isn't running, or (on a real phone) you didn't pass `-PapiBaseUrl` with your Mac's IP. |
| Android Studio: "SDK location not found" | Open the `android` folder (not `Empire`) so Studio writes `local.properties`. |
