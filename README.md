# VLC Private Bubble

> **VIBE-CODED:** This extension was developed with substantial AI assistance, including AI-generated and AI-edited code. It may contain mistakes; review the source and test it before relying on it.

[Install from Firefox Add-ons](https://addons.mozilla.org/firefox/addon/vlc-private-bubble/)

A Firefox extension (desktop and Android). A small draggable bubble appears over web videos. Tap it to choose **Download** or **VLC View**, then select a detected quality.

- **Download:** direct media files only. Desktop uses Firefox's downloads API. Android hands the direct media link to Firefox, which may download or preview it depending on the server. HLS/DASH streams remain available for VLC but are not offered as standalone video downloads.
- **VLC View:** Android hands the selected stream to VLC through an Android intent. Desktop saves an `.m3u` playlist in Downloads; open it to start VLC. No native helper or installer is required.
- **Privacy:** desktop playback uses VLC's current settings; the extension cannot apply VLC's private-session launch flags without a native helper. On Android, enable VLC's Incognito mode for private playback.

## What was tested

The earlier helper-based version was checked with `web-ext lint` and a fake VLC. **Not tested:** this helper-free playlist handoff in a real Firefox, VLC, or Android device.

## Install on desktop (Windows, macOS, Linux)

1. Install the signed `.xpi` from Firefox's Add-ons Manager, or load `extension/manifest.json` temporarily from `about:debugging#/runtime/this-firefox` while developing. Temporary add-ons vanish when Firefox closes.
2. Open a page with a video and tap the bubble, then choose **Download** or **VLC View** and select a quality.
3. For desktop VLC View, open the `.m3u` item from Firefox Downloads. VLC must be installed and associated with `.m3u` playlist files. If Firefox asks what to do, choose VLC.

To allow it in Firefox private windows: `about:addons`, then the extension, then *Run in Private Windows*.

The playlist contains the selected stream URL and stays in Downloads until you remove it. VLC uses its current privacy settings. Streams that require browser cookies or referrer headers may not play in VLC.

## Install on Android

1. Use Firefox (release, Beta or Nightly), version 142 or newer, plus the VLC app.
2. Get a **signed** `.xpi`. Firefox on Android only installs signed add-ons: see "Signing".
3. In Firefox: Settings, About Firefox, tap the logo five times to enable the debug menu, then Settings, *Install extension from file*, and pick the `.xpi`.
4. Open a page with a video, tap the bubble, choose **Download** or **VLC View**, then select a detected quality.

**Private playback on Android:** VLC for Android has no per-launch private switch that an app can set. Turn on **Incognito mode** in VLC (Settings, Advanced) before you play. The extension reminds you once. It is a global VLC setting, so turn it off when you are done.

## Signing (permanent install)

Create a free account at addons.mozilla.org, then from `extension/` run:

```
npx web-ext sign --channel=unlisted --api-key=<key> --api-secret=<secret>
```

Keys come from addons.mozilla.org/developers/addon/api/key. Signing takes a few minutes and gives you an `.xpi` that installs on desktop and Android.

## How it picks the stream

1. If the `<video>` has a normal `http(s)` source, that is included as a direct-video choice.
2. Otherwise (blob players such as HLS.js), the extension uses the media requests it saw on the tab. HLS master playlists are expanded into their advertised resolutions; direct files are labeled from resolution in the URL when available.
3. DASH remains adaptive: VLC or the site chooses the representation. DRM-protected or inaccessible streams may not appear.

If nothing is found the bubble says so.

## Settings (toolbar button)

- Show floating bubble
- Pause the page video after opening it in VLC

## Limits

- DRM video (Netflix, Disney+, most paid streaming) cannot be played in VLC.
- Firefox for Android does not provide the extension downloads API, so Android direct-file downloads rely on Firefox handling the media link; some servers may preview it instead of saving it.
- Streams that need your login cookies or browser referrer headers may fail in VLC. The helper-free playlist does not copy browser cookies or request headers.
- YouTube and some other sites often fail because VLC's built-in site support lags behind.
- Android's `intent://` hand-off from Firefox may behave differently across Firefox versions. If tapping the bubble does nothing, share the link to VLC from Firefox's share menu as a fallback.

## Older helper cleanup

- Windows: delete `HKCU\Software\Mozilla\NativeMessagingHosts\com.qusai.vlc_private` and `%LOCALAPPDATA%\VlcPrivateBubble`.
- Linux: delete `~/.mozilla/native-messaging-hosts/com.qusai.vlc_private.json` and `~/.local/share/vlc-private-bubble`.
- macOS: delete `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.qusai.vlc_private.json` and `~/.local/share/vlc-private-bubble`.
