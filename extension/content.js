(() => {
  "use strict";
  if (window.__vlcPrivateBubbleLoaded) return;
  window.__vlcPrivateBubbleLoaded = true;

  const DEFAULTS = { bubble: true, pauseOnLaunch: true };
  const SIZE = 48;
  const MARGIN = 4;

  let settings = Object.assign({}, DEFAULTS);
  let host = null;
  let btn = null;
  let toastEl = null;
  let menuEl = null;
  let toastTimer = 0;
  let target = null; // the video the bubble is attached to
  let userPos = null; // set once the user drags the bubble
  let xy = { x: 0, y: 0 };
  let scheduled = false;
  let drag = null;

  // ---- UI -----------------------------------------------------------------
  function svg(tag, attrs) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function ensureUi() {
    if (host && host.isConnected) return;
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("data-vlc-private-bubble", "");
      host.style.cssText =
        "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;";
      const root = host.attachShadow({ mode: "closed" });

      const style = document.createElement("style");
      style.textContent =
        ".bubble{position:fixed;left:0;top:0;width:" + SIZE + "px;height:" + SIZE + "px;" +
        "box-sizing:border-box;border-radius:50%;background:rgba(24,24,28,.88);" +
        "border:2px solid #ff8a1f;box-shadow:0 2px 10px rgba(0,0,0,.45);display:none;" +
        "align-items:center;justify-content:center;cursor:pointer;touch-action:none;" +
        "user-select:none;-webkit-user-select:none;opacity:.9}" +
        ".bubble.on{display:flex}" +
        ".toast{position:fixed;left:50%;bottom:24px;max-width:80vw;transform:translateX(-50%);" +
        "background:rgba(24,24,28,.95);color:#fff;font:14px/1.35 system-ui,sans-serif;" +
        "padding:10px 14px;border-radius:10px;opacity:0;pointer-events:none;transition:opacity .2s}" +
        ".toast.on{opacity:1}" +
        ".menu{position:fixed;left:0;top:0;width:min(260px,calc(100vw - 24px));max-height:min(65vh,420px);" +
        "overflow:auto;box-sizing:border-box;padding:12px;background:#202127;color:#fff;" +
        "border:1px solid #ff8a1f;border-radius:14px;box-shadow:0 8px 28px #0008;" +
        "font:14px/1.4 system-ui,sans-serif;display:none;pointer-events:auto;touch-action:pan-y}" +
        ".menu.on{display:block}.menu h2{font-size:15px;margin:0 0 8px}.menu .note{font-size:12px;opacity:.8;margin:6px 0 10px}" +
        ".menu button{display:block;width:100%;box-sizing:border-box;margin:0 0 7px;padding:11px 10px;" +
        "border:1px solid #ffffff35;border-radius:9px;background:#303139;color:#fff;text-align:left;" +
        "font:inherit;overflow-wrap:anywhere;touch-action:manipulation}.menu button:active{background:#484955}";

      btn = document.createElement("div");
      btn.className = "bubble";
      btn.setAttribute("role", "button");
      btn.setAttribute("aria-label", "Choose Download or VLC View");
      btn.setAttribute("aria-haspopup", "dialog");
      btn.setAttribute("aria-expanded", "false");
      const icon = svg("svg", { width: "24", height: "24", viewBox: "0 0 24 24" });
      icon.appendChild(svg("path", { d: "M8 5v14l11-7z", fill: "#ff8a1f" }));
      btn.appendChild(icon);

      toastEl = document.createElement("div");
      toastEl.className = "toast";

      menuEl = document.createElement("div");
      menuEl.className = "menu";
      menuEl.setAttribute("role", "dialog");
      menuEl.setAttribute("aria-label", "Choose download or VLC playback");
      menuEl.addEventListener("pointerdown", (event) => event.stopPropagation());
      menuEl.addEventListener("pointerup", (event) => event.stopPropagation());

      root.append(style, btn, menuEl, toastEl);
      wireDrag();
    }
    (document.fullscreenElement && isContainer(document.fullscreenElement)
      ? document.fullscreenElement
      : document.documentElement
    ).appendChild(host);
  }

  function isContainer(el) {
    return el.tagName !== "VIDEO" && el.tagName !== "IFRAME";
  }

  function clamp(x, y) {
    return {
      x: Math.min(Math.max(x, MARGIN), Math.max(MARGIN, innerWidth - SIZE - MARGIN)),
      y: Math.min(Math.max(y, MARGIN), Math.max(MARGIN, innerHeight - SIZE - MARGIN))
    };
  }

  function apply(p) {
    xy = p;
    btn.style.transform = "translate(" + p.x + "px," + p.y + "px)";
  }

  function positionMenu() {
    const viewportWidth = document.documentElement.clientWidth || innerWidth;
    const viewportHeight = document.documentElement.clientHeight || innerHeight;
    const width = Math.max(180, Math.min(260, viewportWidth - 24));
    const height = menuEl.getBoundingClientRect().height || 220;
    const x = Math.min(Math.max(MARGIN, xy.x + SIZE - width), Math.max(MARGIN, viewportWidth - width - MARGIN));
    let y = xy.y + SIZE + 8;
    if (y + height > viewportHeight - MARGIN) y = Math.max(MARGIN, xy.y - height - 8);
    menuEl.style.transform = "translate(" + x + "px," + y + "px)";
  }

  function menuButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function setMenu(title, buttons, note) {
    menuEl.textContent = "";
    const heading = document.createElement("h2");
    heading.textContent = title;
    menuEl.appendChild(heading);
    if (note) {
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = note;
      menuEl.appendChild(p);
    }
    for (const button of buttons) menuEl.appendChild(button);
    menuEl.classList.add("on");
    positionMenu();
    btn.setAttribute("aria-expanded", "true");
  }

  function closeMenu() {
    if (menuEl) menuEl.classList.remove("on");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function showActions() {
    setMenu("Choose an action", [
      menuButton("⬇  Download", () => showQualities("download")),
      menuButton("▶  VLC View", () => showQualities("vlc")),
      menuButton("Close", closeMenu)
    ]);
  }

  async function showQualities(action) {
    const v = target || bestVideo();
    if (!v) {
      closeMenu();
      return toast("No video found on this page.");
    }
    setMenu("Finding available qualities…", [menuButton("Back", showActions)]);
    try {
      const result = await browser.runtime.sendMessage({
        type: "getQualities",
        videoUrls: directSources(v)
      });
      const allOptions = (result && result.list) || [];
      // Download must deliver the media file itself. Saving an HLS/DASH
      // manifest with an .mp4 name creates a misleading, unusable download.
      const list = action === "download"
        ? allOptions.filter((item) => item.kind === "file")
        : allOptions;
      if (!list.length) {
        setMenu(action === "download" && allOptions.length ? "No direct video file" : "No qualities found", [
          menuButton("Try again", () => showQualities(action)),
          menuButton("Back", showActions),
          menuButton("Close", closeMenu)
        ], action === "download" && allOptions.length
          ? "This stream is adaptive (HLS/DASH). VLC can play it, but the extension cannot turn its playlist into a video file."
          : "Start playback and wait a moment for Firefox to detect the stream.");
        return;
      }
      const buttons = list.map((item) => menuButton(item.label, () => startSelected(action, item)));
      buttons.push(menuButton("Back", showActions), menuButton("Close", closeMenu));
      const note = action === "download"
        ? "Only direct video/audio files are listed here. Adaptive playlists cannot be saved as standalone video files."
        : "Choose a stream quality to open in VLC.";
      setMenu("Choose video quality", buttons, note);
    } catch (e) {
      setMenu("Could not list qualities", [menuButton("Back", showActions), menuButton("Close", closeMenu)], e.message);
    }
  }

  async function startSelected(action, item) {
    const v = target || bestVideo();
    if (!v) return toast("No video found on this page.");
    setMenu(action === "download" ? "Starting download…" : "Opening VLC…", [menuButton("Close", closeMenu)]);
    let res;
    try {
      res = await browser.runtime.sendMessage({
        type: "startAction",
        action,
        url: item.url,
        kind: item.kind,
        contentType: item.contentType,
        title: document.title || location.hostname,
        startSec: Number.isFinite(v.duration) && v.currentTime > 5 ? Math.floor(v.currentTime) : 0
      });
    } catch (e) {
      return toast("Extension error: " + e.message, 4500);
    }
    if (!res || !res.ok) return toast((res && res.error) || "Action failed.", 5000);

    if (res.mode === "intent") {
      launchIntent(res.intent);
      let hinted = true;
      try {
        const saved = await browser.storage.local.get({ androidHintShown: false });
        hinted = saved.androidHintShown;
        if (!hinted) await browser.storage.local.set({ androidHintShown: true });
      } catch (e) {
        /* ignore */
      }
      toast(
        !hinted
          ? "Opening VLC. For private playback, turn on Incognito mode in VLC's settings."
          : "Opening selected quality in VLC…",
        !hinted ? 6000 : 3000
      );
      if (settings.pauseOnLaunch) v.pause();
    } else if (res.mode === "download-link") {
      startBrowserDownload(res.url, res.filename);
      toast(res.isPlaylist
        ? "Playlist opened in Firefox; it is not a bundled offline video."
        : "Download requested from Firefox. If the video opens, use Firefox's page menu to save it.", 7000);
    } else if (res.mode === "playlist") {
      toast("VLC playlist saved in Downloads. Open it to start VLC.", 6000);
      if (settings.pauseOnLaunch) v.pause();
    } else if (res.mode === "download") {
      toast(res.isPlaylist
        ? "Stream playlist saved in Downloads; it may still need an internet connection."
        : "Download started: " + res.filename, 6000);
    }
  }

  function wireDrag() {
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: xy.x, oy: xy.y, moved: false };
    });
    btn.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 8) return;
      drag.moved = true;
      userPos = clamp(drag.ox + dx, drag.oy + dy);
      apply(userPos);
    });
    btn.addEventListener("pointerup", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.stopPropagation();
      const moved = drag.moved;
      drag = null;
      if (!moved) activate();
    });
    btn.addEventListener("pointercancel", () => {
      drag = null;
    });
    for (const t of ["click", "mousedown", "mouseup", "touchstart", "touchend", "contextmenu"]) {
      btn.addEventListener(t, (e) => {
        e.stopPropagation();
        if (t === "contextmenu") e.preventDefault();
      });
    }
  }

  function toast(text, ms) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("on"), ms || 3000);
  }

  // ---- Finding the video --------------------------------------------------
  function bestVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      if (r.width < 160 || r.height < 90) continue;
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      if (w <= 0 || h <= 0) continue;
      const visible = w * h;
      if (visible < 0.25 * r.width * r.height) continue;
      const cs = getComputedStyle(v);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      if (visible > bestArea) {
        best = v;
        bestArea = visible;
      }
    }
    return best;
  }

  function directSources(v) {
    const sources = [v.currentSrc, v.src, v.getAttribute("src")];
    for (const child of v.querySelectorAll("source[src]")) {
      sources.push(child.src, child.getAttribute("src"));
    }
    return Array.from(new Set(sources
      .filter(Boolean)
      .map((source) => {
        try { return new URL(source, document.baseURI).href; } catch (e) { return ""; }
      })
      .filter((source) => /^https?:\/\//i.test(source))));
  }

  function refresh() {
    scheduled = false;
    if (!settings.bubble) {
      if (btn) btn.classList.remove("on");
      return;
    }
    target = bestVideo();
    if (!target) {
      if (btn) btn.classList.remove("on");
      return;
    }
    ensureUi();
    btn.classList.add("on");
    if (userPos) {
      apply(clamp(userPos.x, userPos.y));
    } else {
      const r = target.getBoundingClientRect();
      apply(clamp(r.right - SIZE - 10, r.top + 10));
    }
    if (menuEl && menuEl.classList.contains("on")) positionMenu();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(refresh);
  }

  // ---- Action -------------------------------------------------------------
  function launchIntent(intent) {
    if (typeof intent !== "string" || !intent.startsWith("intent:") || !intent.includes("package=org.videolan.vlc")) return;
    const a = document.createElement("a");
    a.href = intent;
    a.rel = "noopener";
    a.style.display = "none";
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
  }

  function startBrowserDownload(url, filename) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename || "video";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.style.display = "none";
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.remove();
  }

  async function activate() {
    if (!target && !bestVideo()) return toast("No video found on this page.");
    showActions();
  }

  // ---- Wiring -------------------------------------------------------------
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "launchIntent") {
      launchIntent(msg.intent);
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });

  browser.storage.local.get(DEFAULTS).then((s) => {
    settings = Object.assign({}, DEFAULTS, s);
    schedule();
  });
  browser.storage.onChanged.addListener((changes) => {
    for (const k in changes) if (k in DEFAULTS) settings[k] = changes[k].newValue;
    schedule();
  });

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener("scroll", schedule, { passive: true, capture: true });
  addEventListener("resize", schedule, { passive: true });
  document.addEventListener("loadedmetadata", schedule, true);
  document.addEventListener("play", schedule, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (menuEl && menuEl.classList.contains("on") && host && !host.contains(event.target)) closeMenu();
  }, true);
  document.addEventListener("fullscreenchange", () => {
    if (host) {
      const fs = document.fullscreenElement;
      const parent = fs && isContainer(fs) ? fs : document.documentElement;
      if (host.parentNode !== parent) parent.appendChild(host);
    }
    schedule();
  });
  setInterval(schedule, 1500);
  schedule();
})();
