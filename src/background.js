/**
 * MV3 service worker entry. Listeners are registered synchronously at top level (required for
 * event-driven wake-ups); the app itself is created once per worker lifetime.
 */
import { createApp } from "./app.js";

const appReady = createApp()
  .then((app) => {
    globalThis.__vbApp = app; // inspectable from the service-worker devtools console and the e2e test
    return app;
  })
  .catch((err) => {
    console.error("voice-browser: failed to start", err);
    throw err;
  });

// Clicking the toolbar icon opens the side panel ("open the extension").
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  appReady
    .then((app) => app.handleMessage(msg, sender))
    .then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true; // async response
});

chrome.runtime.onConnect.addListener((port) => {
  appReady.then((app) => app.onConnect(port)).catch(() => {});
});

// Local addition: keyboard shortcut (manifest "commands") toggles the microphone without the side
// panel — the mic runs in an offscreen document, so it keeps listening while the panel is closed.
chrome.commands?.onCommand.addListener((command) => {
  if (command !== "toggle-mic") return;
  appReady.then((app) => app.micToggle({ fromShortcut: true })).catch(() => {});
});
