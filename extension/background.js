"use strict";

const VLC_ANDROID_PACKAGE = "org.videolan.vlc";
const DEFAULTS = { bubble: true, pauseOnLaunch: true };

// ---------------------------------------------------------------------------
// Stream detection: remember media requests per tab, so pages that play from
// blob: URLs (HLS/DASH players) can still be handed to VLC.
// ---------------------------------------------------------------------------
const MANIFEST_RE = /\.(m3u8|mpd)(?:$|[?#])/i;
const FILE_RE = /\.(mp4|webm|mkv|mov|m4v|mp3|m4a|flv|ogv|ogg|opus)(?:$|[?#])/i;
const SEGMENT_RE = /\.(m4s|ts|aac|cmfv|cmfa)(?:$|[?#])/i;
const CT_MANIFEST = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|audio\/(x-)?mpegurl)$/i;
const CT_MEDIA = /^(video|audio)\//i;
const MIN_FILE_BYTES = 300000; // smaller responses are usually segments or ads
const MAX_PER_TAB = 20;

const found = new Map(); // tabId -> [{url, kind, ct, time}]
const lastPage = new Map(); // tabId -> page URL without hash
const pendingPlaylistUrls = new Map(); // downloadId -> object URL

function releasePlaylistUrl(downloadId) {
  const objectUrl = pendingPlaylistUrls.get(downloadId);
  if (!objectUrl) return;
  pendingPlaylistUrls.delete(downloadId);
  URL.revokeObjectURL(objectUrl);
}

if (browser.downloads && browser.downloads.onChanged) {
  browser.downloads.onChanged.addListener((delta) => {
    if (delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
      releasePlaylistUrl(delta.id);
    }
  });
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h && h.value ? String(h.value) : "";
}

function totalBytes(contentRange, contentLength) {
  const m = /\/(\d+)\s*$/.exec(contentRange || "");
  if (m) return Number(m[1]);
  if (!contentRange && /^\d+$/.test(contentLength || "")) return Number(contentLength);
  return 0; // unknown
}

function addCandidate(tabId, entry) {
  const list = found.get(tabId) || [];
  if (list.some((e) => e.url === entry.url)) return;
  list.push(entry);
  while (list.length > MAX_PER_TAB) list.shift();
  found.set(tabId, list);
}

function onHeadersReceived(d) {
  if (d.tabId < 0 || d.statusCode >= 400 || !/^https?:/i.test(d.url)) return;
  const ct = headerValue(d.responseHeaders, "content-type").split(";")[0].trim();
  let kind = null;
  if (MANIFEST_RE.test(d.url) || CT_MANIFEST.test(ct)) {
    kind = "manifest";
  } else if (!SEGMENT_RE.test(d.url) && (FILE_RE.test(d.url) || CT_MEDIA.test(ct))) {
    if (/^video\/mp2t$/i.test(ct)) return;
    const total = totalBytes(
      headerValue(d.responseHeaders, "content-range"),
      headerValue(d.responseHeaders, "content-length")
    );
    if (total && total < MIN_FILE_BYTES) return;
    kind = "file";
  }
  if (kind) {
    const size = kind === "file" ? totalBytes(
      headerValue(d.responseHeaders, "content-range"),
      headerValue(d.responseHeaders, "content-length")
    ) : 0;
    addCandidate(d.tabId, { url: d.url, kind, ct, size, time: Date.now() });
  }
}

browser.webRequest.onHeadersReceived.addListener(
  onHeadersReceived,
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other", "object"] },
  ["responseHeaders"]
);

browser.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  const base = info.url.split("#")[0];
  if (lastPage.get(tabId) !== base) {
    lastPage.set(tabId, base);
    found.delete(tabId);
  }
});
browser.tabs.onRemoved.addListener((tabId) => {
  found.delete(tabId);
  lastPage.delete(tabId);
});

// Best guess: the first manifest seen is normally the master playlist; with no
// manifest, the most recent large media file.
function pickBest(list) {
  const manifests = list.filter((e) => e.kind === "manifest");
  if (manifests.length) return manifests[0].url;
  const files = list.filter((e) => e.kind === "file");
  return files.length ? files[files.length - 1].url : "";
}

function qualityLabel(height, width, bandwidth, name) {
  const parts = [];
  if (height) parts.push(height + "p");
  else if (name) parts.push(name);
  if (width && height) parts.push(width + "×" + height);
  if (bandwidth) parts.push((bandwidth / 1000000).toFixed(1) + " Mbps");
  return parts.join(" · ") || "Adaptive stream";
}

function guessHeight(url) {
  const m = /(?:^|[._/-])(2160|1440|1080|900|720|576|540|480|360|240)p?(?=$|[._/?#-])/i.exec(url);
  return m ? Number(m[1]) : 0;
}

function parseHlsVariants(text, manifestUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = {};
    const raw = lines[i].slice("#EXT-X-STREAM-INF:".length);
    const re = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/g;
    let match;
    while ((match = re.exec(raw))) attrs[match[1]] = match[2].replace(/^"|"$/g, "");
    let uri = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && !lines[j].startsWith("#")) {
        uri = lines[j];
        break;
      }
    }
    if (!uri) continue;
    const resolution = /^(\d+)x(\d+)$/i.exec(attrs.RESOLUTION || "");
    const width = resolution ? Number(resolution[1]) : 0;
    const height = resolution ? Number(resolution[2]) : 0;
    const bandwidth = Number(attrs["AVERAGE-BANDWIDTH"] || attrs.BANDWIDTH) || 0;
    variants.push({
      url: new URL(uri, manifestUrl).href,
      kind: "hls-variant",
      height,
      width,
      bandwidth,
      label: qualityLabel(height, width, bandwidth, attrs.NAME)
    });
  }
  return variants;
}

async function getQualities(tabId, videoUrls) {
  const candidates = (found.get(tabId) || []).slice();
  const directUrls = Array.from(new Set((Array.isArray(videoUrls) ? videoUrls : [videoUrls])
    .map((url) => String(url || ""))
    .filter((url) => /^https?:\/\//i.test(url))));
  for (const url of directUrls) {
    if (candidates.some((item) => item.url === url)) continue;
    const kind = MANIFEST_RE.test(url) ? "manifest" : "file";
    candidates.unshift({ url, kind, ct: "", size: 0, time: Date.now() });
  }

  const options = [];
  const files = candidates.filter((item) => item.kind === "file");
  for (const item of files) {
    const height = guessHeight(item.url);
    const size = Number(item.size) || 0;
    const details = [height ? height + "p" : "Direct video"];
    if (size) details.push((size / 1048576).toFixed(1) + " MB");
    options.push({ url: item.url, kind: "file", height, size, contentType: item.ct || "", label: details.join(" · ") });
  }

  // Only inspect the first HLS playlist: a playing tab may have already
  // requested many variant/media playlists, and fetching them serially made
  // the picker appear stuck on slower mobile connections.
  const hlsItem = candidates.find((item) =>
    /\.m3u8(?:$|[?#])/i.test(item.url) || /mpegurl/i.test(item.ct || "")
  );
  if (hlsItem) {
    const item = hlsItem;
    {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        let response;
        let text = "";
        try {
          response = await fetch(item.url, { credentials: "include", signal: controller.signal });
          if (response.ok) text = await response.text();
        } finally {
          clearTimeout(timeout);
        }
        if (response.ok) {
          const variants = parseHlsVariants(text, item.url);
          if (variants.length) options.push(...variants);
          else options.push({ url: item.url, kind: "hls-playlist", label: "Adaptive HLS · site chooses quality" });
        } else options.push({ url: item.url, kind: "hls-playlist", label: "HLS playlist · quality list unavailable" });
      } catch (e) {
        options.push({ url: item.url, kind: "hls-playlist", label: "HLS playlist · adaptive quality" });
      }
    }
  }

  const dashItem = candidates.find((item) =>
    /\.mpd(?:$|[?#])/i.test(item.url) || /dash\+xml/i.test(item.ct || "")
  );
  if (dashItem) options.push({ url: dashItem.url, kind: "dash-playlist", label: "Adaptive DASH · VLC/site chooses quality" });

  const unique = [];
  const seen = new Set();
  for (const option of options) {
    if (!seen.has(option.url)) {
      seen.add(option.url);
      unique.push(option);
    }
  }
  unique.sort((a, b) => (b.height || 0) - (a.height || 0) || a.label.localeCompare(b.label));
  return unique;
}

// ---------------------------------------------------------------------------
// Preparing a playlist for VLC
// ---------------------------------------------------------------------------
function buildIntent(url, title, startSec) {
  const u = new URL(url);
  const scheme = u.protocol.replace(":", "");
  const withoutHash = u.hash ? url.slice(0, url.length - u.hash.length) : url;
  const rest = withoutHash.replace(/^https?:/i, ""); // "//host/path?query"
  const parts = [
    "scheme=" + scheme,
    "action=android.intent.action.VIEW",
    "type=video/*",
    "package=" + VLC_ANDROID_PACKAGE
  ];
  if (title) parts.push("S.title=" + encodeURIComponent(String(title).slice(0, 200)));
  if (startSec > 0) parts.push("l.position=" + Math.floor(startSec) * 1000);
  parts.push(
    "S.browser_fallback_url=" +
      encodeURIComponent("https://play.google.com/store/apps/details?id=" + VLC_ANDROID_PACKAGE)
  );
  return "intent:" + rest + "#Intent;" + parts.join(";") + ";end";
}

function safeFilenamePart(value) {
  return String(value || "video")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .trim()
    .slice(0, 80) || "video";
}

async function downloadVlcPlaylist(url, title) {
  if (!browser.downloads) throw new Error("Firefox downloads are unavailable.");

  const label = String(title || "Video").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
  const playlist = "#EXTM3U\n#EXTINF:-1," + label + "\n" + url + "\n";
  const objectUrl = URL.createObjectURL(new Blob([playlist], { type: "audio/x-mpegurl" }));
  const filename = "VLC Private Bubble - " + safeFilenamePart(title) + ".m3u";
  try {
    const downloadId = await browser.downloads.download({
      url: objectUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
    pendingPlaylistUrls.set(downloadId, objectUrl);
    const [item] = await browser.downloads.search({ id: downloadId });
    if (item && (item.state === "complete" || item.state === "interrupted")) {
      releasePlaylistUrl(downloadId);
    }
    return { ok: true, mode: "playlist", filename };
  } catch (e) {
    URL.revokeObjectURL(objectUrl);
    throw e;
  }
}

async function play(msg) {
  const url = String(msg.url || "");
  if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, error: "Not a playable http(s) address." };
  const startSec = Number(msg.startSec) > 0 ? Number(msg.startSec) : 0;
  const info = await browser.runtime.getPlatformInfo();

  if (info.os === "android") {
    // The page (a real tap) launches the intent; see content.js.
    return { ok: true, mode: "intent", intent: buildIntent(url, msg.title, startSec) };
  }

  try {
    return await downloadVlcPlaylist(url, msg.title);
  } catch (e) {
    return {
      ok: false,
      error: "Could not save a VLC playlist. Check Firefox's download permissions. (" + e.message + ")"
    };
  }
}

async function startAction(msg) {
  const url = String(msg.url || "");
  if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, error: "Not a playable http(s) address." };
  if (msg.action === "vlc") return play({ ...msg, url });
  if (msg.action !== "download") return { ok: false, error: "Unknown action." };
  if (msg.kind !== "file") {
    return { ok: false, error: "This is a streaming playlist, not a video file. Choose a direct file to download." };
  }

  const title = safeFilenamePart(msg.title || "Video");
  let extension = "mp4";
  try {
    const path = new URL(url).pathname;
    const match = /\.([a-z0-9]{2,5})$/i.exec(path);
    if (match) extension = match[1].toLowerCase();
  } catch (e) {
    /* retain the default extension */
  }
  if (extension === "mp4" && msg.contentType) {
    const mimeExtensions = {
      "video/webm": "webm", "video/ogg": "ogv", "video/quicktime": "mov",
      "video/x-matroska": "mkv", "audio/mpeg": "mp3", "audio/mp4": "m4a",
      "audio/ogg": "ogg", "audio/webm": "webm"
    };
    extension = mimeExtensions[String(msg.contentType).split(";")[0].trim().toLowerCase()] || extension;
  }
  const filename = title + "." + extension;
  const platform = await browser.runtime.getPlatformInfo();
  const isPlaylist = false;
  if (platform.os === "android") {
    // Firefox for Android does not expose browser.downloads; let Firefox
    // handle a user-initiated media link from the page.
    return { ok: true, mode: "download-link", url, filename, isPlaylist };
  }
  if (!browser.downloads) return { ok: false, error: "Firefox downloads are unavailable on this device." };
  try {
    const id = await browser.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
    return {
      ok: true,
      mode: "download",
      filename,
      isPlaylist,
      downloadId: id
    };
  } catch (e) {
    return { ok: false, error: "Could not start the download. The stream may require the page's session. (" + e.message + ")" };
  }
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return undefined;
  if (msg.type === "getCandidates") {
    const tabId = msg.tabId !== undefined ? msg.tabId : sender.tab && sender.tab.id;
    const list = found.get(tabId) || [];
    return Promise.resolve({ list, best: pickBest(list) });
  }
  if (msg.type === "getQualities") {
    const tabId = sender.tab && sender.tab.id;
    return getQualities(tabId, msg.videoUrls || msg.videoUrl).then((list) => ({ list }));
  }
  if (msg.type === "startAction") return startAction(msg);
  if (msg.type === "play") return play(msg);
  return undefined;
});
