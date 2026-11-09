# Tally

Floating always-on-top screen recorder for Windows. Records the whole primary display with system audio — and, if you switch it on, your microphone for narration — counts you in for 3 seconds, and writes an MP4 straight into Downloads.

## Install

Two builds, both x64:

- **Tally-setup-0.1.0.exe** — installer. Choose a folder, get Start-menu and desktop shortcuts, uninstall through Settings.
- **Tally-portable-0.1.0.exe** — single file, no install. Runs from anywhere, including a USB stick.

Neither is code-signed, so Windows SmartScreen will show "Windows protected your PC" the first time. More info → Run anyway. Signing needs a certificate.

## Controls

| Control | Behaviour |
| --- | --- |
| ● Record | Grabs the screen, counts 3 → 2 → 1, then rolls. |
| ■ Cancel | During the countdown, abandons the take. Escape does the same. |
| ⏸ Pause / ▶ Resume | Suspends the stream; the counter freezes. |
| 🎙 Mic | Before a take: adds your microphone as narration on top of system audio. Slashed and dim = off, bright = on. Remembered between sessions. During the take a green ring around it moves with your voice so you can see you're being heard. |
| ■ Stop | Ends the take, converts, saves to Downloads. |
| Space | Toggles pause while a take is live. |
| × | Closes. Finishes an in-progress take first; if a save is already running, closes once it lands. |

The lamp is red while recording, amber while paused, grey while saving. It blinks once per second through the countdown, in step with the number.

## The countdown

The screen is captured and the output file is opened before 3 is shown, so the take starts the instant the counter reaches zero — no permission dialog or disk setup eating into the first second. The bar sits at full opacity through the count so you can read it without chasing it with the cursor, then drops back to its resting transparency.

Change the length with `COUNTDOWN_FROM` at the top of the countdown section in `renderer/bar.js`. Setting it to 0 skips the count entirely.

## Window behaviour

- Always on top at the screen-saver level, so it survives fullscreen apps.
- Hidden from capture via `setContentProtection(true)` — the bar does not appear in its own recording, or in Teams/OBS.
- Transparency: 32% at rest, 58% during a take, 100% while counting in or on hover. Done in CSS so the window stays hit-testable.
- Hover covers the whole bar, timer included. The bar is a drag region, and Windows drag regions swallow mouse events, so CSS `:hover` alone only fires over the buttons; the main process polls the cursor position instead and tells the bar when it is over it.
- Draggable anywhere except the buttons, which carry `-webkit-app-region: no-drag`. Position persists in `%APPDATA%/tally/bar-position.json`, with an off-screen check so an unplugged monitor doesn't strand the bar.
## How the recording path works

- `setDisplayMediaRequestHandler` auto-selects the primary display, so there is no source picker. System audio comes from `audio: 'loopback'`.
- `MediaRecorder` emits a chunk every second. Each chunk goes over IPC and is appended to a temp file immediately — video never accumulates in renderer memory, so a two-hour take costs no more RAM than a two-minute one. A promise chain keeps the writes ordered.
- On stop, ffmpeg converts the temp file into `Downloads/Screen recording YYYY-MM-DD HHMMSS.mp4`. Collisions get `(2)`.

## Audio

- **System audio** (whatever the speakers are playing) is always recorded, in stereo, with Chromium's voice processing (noise suppression, auto gain, echo cancellation) switched off. Left on, those filters treat steady sound such as music as noise and fade it out within seconds.
- **Microphone** is optional (the mic key). When on, the mic gets the voice clean-up and is mixed with system audio through Web Audio into one stereo track, since MediaRecorder records only one audio track. If the mic cannot be opened, the take does not start and the bar says "Mic unavailable" — check Windows Settings → Privacy & security → Microphone → "Let desktop apps access your microphone".
- Narrating over loud system audio on open speakers records some of that audio twice (once directly, once through the mic). Use headphones for clean narration over music or video.

## Why H.264 and not VP9

The recorder asks for `video/webm;codecs=h264,opus` first. That lets ffmpeg stream-copy the video (`-c:v copy`) into MP4 — no re-encode, seconds for a long recording. Only the audio is transcoded to AAC, because Opus in an MP4 container has the same poor-playback problem H.264 solves for video.

If Chromium refuses H.264 the fallback is VP9 and the save re-encodes with libx264. Still a working MP4, just slow. The label reads "Converting" rather than "Saving" so you know which path ran.

If ffmpeg fails outright, the raw `.webm` is copied to Downloads rather than discarded. A take is never lost to a conversion error.

## Building it yourself

Needs Node.js 22.12 or newer.

```
npm install
npm start   # run from source
npm run build   # installer + portable into dist/
```

Electron fetches its runtime (about 130 MB) the first time `npm start` runs, not during `npm install`, so the first launch takes a while. If that download is interrupted, Electron says "failed to install correctly"; delete `node_modules/electron`, run `npm install`, then `npx install-electron --no` to fetch it again.

Building on Windows needs nothing extra. On Linux, electron-builder shells out to Wine for the NSIS steps — install `wine64` and `wine32:i386`, or the build stops after `dist/win-unpacked`.

`ffmpeg-static` downloads a binary matching the host platform at install time, so a cross-build needs it forced:

```
npm_config_platform=win32 npm_config_arch=x64 node node_modules/ffmpeg-static/install.js
```

`asarUnpack` in package.json keeps that binary executable inside the package. Along with Electron itself it makes up most of the ~145 MB installer. The portable build uses maximum compression and takes far longer to produce than the installer (20+ minutes on a laptop).

## Icon

`build/icon.ico` (16–256 px) is the app icon electron-builder puts on the exe, installer and shortcuts; `build/icon.png` is a 512 px copy. Both are drawn by `scripts/make-icon.js` — the bar's dark housing with the lit tally lamp — so tweak the colours or proportions there and run `node scripts/make-icon.js` to regenerate.

## The name

A tally light is the red lamp on a broadcast camera that tells everyone in the studio which camera is live. That lamp is the whole interface here — red for rolling, amber for held, blinking through the count-in — so the app took its name from it.

## Publishing

`.github/workflows/release.yml` builds both installers on a real Windows runner whenever you push a tag:

```
git tag v0.1.0
git push origin v0.1.0
```

The .exe files land on a draft release. Building on windows-latest also means ffmpeg-static fetches the right binary on its own — none of the cross-build workarounds above apply.

## Known limits

- Primary display only. Multi-monitor would mean surfacing the desktopCapturer source list in a picker.
- `-movflags +faststart` rewrites the file at the end, so the save touches the MP4 twice. Negligible at typical lengths.
- No global hotkeys yet. `globalShortcut` for start/pause is the obvious next addition, with a tray icon and a "show in folder" action wired to the already-exposed `tally.reveal`.
