"use strict";

const DEFAULTS = { bubble: true, pauseOnLaunch: true };
const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $("status").textContent = text;
}

async function openInVlc(tab, url) {
  setStatus("Preparing VLC playlist...");
  try {
    const res = await browser.runtime.sendMessage({
      type: "play",
      url,
      title: tab.title || "",
      startSec: 0
    });
    if (!res || !res.ok) return setStatus((res && res.error) || "Could not open VLC.");
    if (res.mode === "intent") {
      try {
        await browser.tabs.sendMessage(tab.id, { type: "launchIntent", intent: res.intent }, { frameId: 0 });
        setStatus("Opening in VLC...");
      } catch (e) {
        setStatus("Could not reach the page. Reload it and tap the bubble instead.");
      }
    } else if (res.mode === "playlist") {
        setStatus("Playlist with the stream URL saved in Downloads. Open it to start VLC; VLC uses its current privacy settings.");
    } else {
      setStatus("Ready for VLC.");
    }
  } catch (e) {
    setStatus("Extension error: " + e.message);
  }
}

async function init() {
  const s = await browser.storage.local.get(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) {
    $(key).checked = !!s[key];
    $(key).addEventListener("change", () => browser.storage.local.set({ [key]: $(key).checked }));
  }

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) return;

  const res = await browser.runtime.sendMessage({ type: "getCandidates", tabId: tab.id });
  const list = (res && res.list) || [];
  const box = $("list");
  if (!list.length) {
    const p = document.createElement("div");
    p.textContent = "None yet. Start the video, then reopen this panel.";
    box.appendChild(p);
  }
  for (const item of list.slice().reverse()) {
    const b = document.createElement("button");
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = item.kind === "manifest" ? "Playlist: " : "File: ";
    b.append(kind, document.createTextNode(item.url.length > 90 ? item.url.slice(0, 90) + "..." : item.url));
    b.addEventListener("click", () => openInVlc(tab, item.url));
    box.appendChild(b);
  }

  $("pageUrl").addEventListener("click", () => {
    if (tab.url && /^https?:/i.test(tab.url)) openInVlc(tab, tab.url);
    else setStatus("This page has no http(s) address.");
  });
}

init().catch((e) => setStatus("Error: " + e.message));
