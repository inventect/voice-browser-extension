/**
 * Message protocol between the three extension contexts. One place to review.
 *
 *  side panel / options  ──runtime.sendMessage / port──▶  service worker (controller, Jev, key)
 *  service worker        ──tabs.sendMessage──────────────▶  content script (snapshot, DOM actions, overlay)
 *  service worker        ──port.postMessage──────────────▶  side panel (events, exactly like the old ws server)
 */

export const PORT_NAME = "vb-sidepanel";

export const MSG = {
  // side panel / options / tests → service worker (request/response)
  TRANSCRIPT: "transcript", // { text, final, utteranceId }
  COMMAND: "command", // { text }  typed fallback = final utterance
  UNDO: "undo",
  SNAPSHOT: "snapshot", // re-scan the active page
  STATE: "state", // → uiState()
  SET_WINDOW: "set-window", // { windowId } which window's active tab to control (side panel is per window)
  API_KEY_STATUS: "api-key-status", // → { hasKey, masked }
  SET_API_KEY: "set-api-key", // { apiKey } (options page)
  TEST_CONNECTION: "test-connection", // → { ok, latencyMs, model } one cheap Noul call
  PING: "ping", // keep-alive from the side panel
  // speech-to-text engine (local addition: ElevenLabs Scribe v2 Realtime)
  STT_STATUS: "stt-status", // → { hasKey, masked, engine, resolved }
  SET_STT: "set-stt", // { apiKey?, engine? } (options page) → STT_STATUS
  STT_TOKEN: "stt-token", // → { ok, token } single-use realtime token (side panel), key stays in the worker
  TEST_STT: "test-stt", // { apiKey? } → { ok, latencyMs } mints (and discards) one token
  // microphone (local addition): it lives in an offscreen document, so listening continues while
  // the side panel is closed. The worker owns the on/off state.
  MIC_STATE: "mic-state", // → { on, starting, engine, lang, since, error }
  MIC_START: "mic-start",
  MIC_STOP: "mic-stop", // { reason? }
  MIC_TOGGLE: "mic-toggle",
  SET_LANG: "set-lang", // { lang: "ko-KR" | "en-US" } recognition + panel language
  MIC_EVENT: "mic-event", // offscreen → worker: { kind: "log" | "stopped" | "engine" | "error", ... }

  // service worker → side panel (port broadcast)
  HELLO: "hello",
  DECISION: "decision",
  ACTION: "action",
  LOG: "log",
  CANDIDATES: "candidates",
  PENDING: "pending",
  TABS: "tabs",
  ERROR: "error",
  CONTEXT: "context",
  MIC: "mic", // mic state changed (local addition)
  SPEECH: "speech", // { t, line } raw recogniser event for the Details log (local addition)

  // service worker → offscreen document (local addition; messages carry target: "offscreen")
  OFF_START: "off:start", // { lang, engine, keyterms } → { ok, engine, warning? } | { ok: false, code, error }
  OFF_STOP: "off:stop", // { reason }
  OFF_KEYTERMS: "off:keyterms", // { keyterms }
  OFF_STATUS: "off:status", // → { on, engine, lang, since }

  // service worker → content script
  CS_PING: "vb:ping",
  CS_SNAPSHOT: "vb:snapshot",
  CS_EXEC: "vb:exec", // { action: {type: click|type|select|press_enter|scroll, ...} }
  CS_OVERLAY: "vb:overlay", // { fn, args }
};

/** Pages where content scripts can never run. Navigation / tab commands still work there. */
export function isRestrictedUrl(url) {
  if (!url) return true;
  if (/^(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source|file|data|blob|javascript):/i.test(url)) return true;
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) return true;
  return false;
}

/** Blank pages: restricted, but not worth a warning. */
export function isBlankUrl(url) {
  return !url || url === "about:blank" || /^chrome:\/\/(newtab|new-tab-page)/i.test(url) || url === "chrome://newtab/";
}

/** Our own extension pages (side panel opened in a tab during tests, options page). */
export function isOwnExtensionUrl(url, extensionId) {
  return Boolean(url && extensionId && url.startsWith(`chrome-extension://${extensionId}/`));
}
