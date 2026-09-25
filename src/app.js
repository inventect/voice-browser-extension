/**
 * Service-worker application: wires ChromeBrowser + Controller + Jev and speaks the message
 * protocol with the side panel / options page. Kept free of top-level chrome.* calls so unit
 * tests can construct it with a chrome shim (see test/helpers/chrome-shim.js).
 *
 * The API key lives in chrome.storage.local and is read only here, in the service worker.
 */
import { ChromeBrowser } from "./chrome-browser.js";
import { Controller } from "./controller.js";
import { configureJev, decide, testConnection } from "./jev.js";
import { execute } from "./executor.js";
import { MODEL, QUESTIONS, T } from "./constants.js";
import { MSG, PORT_NAME } from "./protocol.js";
import { mintScribeToken } from "./scribe-util.js";

const SESSION_KEY = "vbState";
const KEY_NAME = "apiKey";
// Local addition: ElevenLabs key + engine choice ("auto" = ElevenLabs when a key is saved).
const STT_KEY_NAME = "elevenLabsKey";
const STT_ENGINE_NAME = "sttEngine";
export const STT_ENGINES = ["auto", "elevenlabs", "chrome"];

export async function readApiKey(chrome) {
  const got = await chrome.storage.local.get(KEY_NAME);
  return String(got?.[KEY_NAME] || "").trim();
}

export async function readSttKey(chrome) {
  const got = await chrome.storage.local.get(STT_KEY_NAME);
  return String(got?.[STT_KEY_NAME] || "").trim();
}

/** Which recogniser the side panel should use. */
export function resolveEngine(engine, hasKey) {
  if (engine === "chrome") return "chrome";
  if (engine === "elevenlabs") return "elevenlabs";
  return hasKey ? "elevenlabs" : "chrome";
}

export function maskKey(key) {
  if (!key) return "";
  return key.length <= 8 ? "••••" : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/**
 * @param {{chrome?: object, decideFn?: Function, executeFn?: Function}} opts
 * @returns {Promise<{controller: Controller, browser: ChromeBrowser, handleMessage: Function, onConnect: Function, ports: Set}>}
 */
export async function createApp({ chrome = globalThis.chrome, decideFn = decide, executeFn = execute, sttFetch } = {}) {
  configureJev({ getApiKey: () => readApiKey(chrome) });

  const browser = new ChromeBrowser(chrome);
  await browser.init();
  const controller = new Controller({ browser, decideFn, executeFn });

  // Survive service-worker suspension: restore the small bits that matter.
  try {
    const saved = await chrome.storage.session?.get(SESSION_KEY);
    controller.restore(saved?.[SESSION_KEY]);
  } catch {
    /* session storage unavailable (older Chrome) — start fresh */
  }
  let persistTimer = null;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      chrome.storage.session?.set({ [SESSION_KEY]: controller.persistable() })?.catch?.(() => {});
    }, 50);
  };

  const ports = new Set();
  const broadcast = (type, payload) => {
    for (const port of ports) {
      try {
        port.postMessage({ type, payload });
      } catch {
        ports.delete(port);
      }
    }
  };

  controller.on("transcript", (p) => broadcast(MSG.TRANSCRIPT, p));
  controller.on("decision", (p) => {
    broadcast(MSG.DECISION, p);
    persist();
  });
  controller.on("action", (p) => {
    broadcast(MSG.ACTION, { ...p, ui: controller.uiState() });
    persist();
  });
  controller.on("snapshot", () => broadcast(MSG.SNAPSHOT, controller.uiState().snapshot));
  controller.on("log", (p) => broadcast(MSG.LOG, p));
  controller.on("candidates", (p) => broadcast(MSG.CANDIDATES, p));
  controller.on("pending", (p) => broadcast(MSG.PENDING, p));
  controller.on("tabs", (p) => broadcast(MSG.TABS, p));
  controller.on("error", (p) => broadcast(MSG.ERROR, p));
  controller.on("context", (p) => broadcast(MSG.CONTEXT, p));

  // Keep the "controlled page" card current while the user browses (debounced).
  let snapTimer = null;
  browser.onChange((info) => {
    if (!info?.activeChanged && !info?.navigated) return;
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      if (!controller.busy) controller.refreshSnapshot().catch(() => {});
    }, 350);
  });

  async function apiKeyStatus() {
    const key = await readApiKey(chrome);
    return { hasKey: Boolean(key), masked: maskKey(key), model: MODEL };
  }

  async function sttStatus() {
    const key = await readSttKey(chrome);
    const got = await chrome.storage.local.get(STT_ENGINE_NAME);
    const engine = STT_ENGINES.includes(got?.[STT_ENGINE_NAME]) ? got[STT_ENGINE_NAME] : "auto";
    return { hasKey: Boolean(key), masked: maskKey(key), engine, resolved: resolveEngine(engine, Boolean(key)) };
  }
  const mint = (apiKey) => mintScribeToken({ apiKey, ...(sttFetch ? { fetchFn: sttFetch } : {}) });

  /** Request/response handler for chrome.runtime.onMessage (and port messages). */
  async function handleMessage(msg, sender = null) {
    if (!msg || typeof msg.type !== "string") return { error: "bad message" };
    switch (msg.type) {
      case MSG.TRANSCRIPT:
        controller.handleTranscript({ text: msg.text, final: Boolean(msg.final), utteranceId: msg.utteranceId ?? `u-${Date.now()}` });
        return { ok: true };
      case MSG.COMMAND:
        controller.handleCommand(String(msg.text || ""));
        return { ok: true };
      case MSG.UNDO:
        controller.undo();
        return { ok: true };
      case MSG.SNAPSHOT:
        await controller.refreshSnapshot();
        return { ok: true, snapshot: controller.uiState().snapshot };
      case MSG.STATE:
        return { ...controller.uiState(), apiKey: await apiKeyStatus(), questions: msg.withQuestions ? QUESTIONS : undefined, thresholds: T };
      case MSG.SET_WINDOW:
        browser.setPreferredWindow(typeof msg.windowId === "number" ? msg.windowId : null);
        controller.snapshotAt = 0;
        return { ok: true };
      case MSG.API_KEY_STATUS:
        return apiKeyStatus();
      case MSG.SET_API_KEY: {
        const key = String(msg.apiKey || "").trim();
        if (key) await chrome.storage.local.set({ [KEY_NAME]: key });
        else await chrome.storage.local.remove(KEY_NAME);
        return apiKeyStatus();
      }
      case MSG.TEST_CONNECTION: {
        const key = msg.apiKey ? String(msg.apiKey).trim() : await readApiKey(chrome);
        if (!key) return { ok: false, error: "no API key set" };
        return testConnection({ apiKey: key });
      }
      case MSG.PING:
        return { ok: true, t: Date.now() };
      case MSG.STT_STATUS:
        return sttStatus();
      case MSG.SET_STT: {
        if ("apiKey" in msg) {
          const key = String(msg.apiKey || "").trim();
          if (key) await chrome.storage.local.set({ [STT_KEY_NAME]: key });
          else await chrome.storage.local.remove(STT_KEY_NAME);
        }
        if ("engine" in msg && STT_ENGINES.includes(msg.engine)) await chrome.storage.local.set({ [STT_ENGINE_NAME]: msg.engine });
        return sttStatus();
      }
      case MSG.STT_TOKEN:
        return mint(await readSttKey(chrome));
      case MSG.TEST_STT: {
        const t0 = Date.now();
        const r = await mint(msg.apiKey ? String(msg.apiKey).trim() : await readSttKey(chrome));
        return r.ok ? { ok: true, latencyMs: Date.now() - t0 } : r;
      }
      default:
        return { error: `unknown message type ${msg.type}` };
    }
  }

  /** Long-lived port from the side panel: push events, accept the same messages. */
  function onConnect(port) {
    if (port.name !== PORT_NAME) return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener((msg) => {
      handleMessage(msg, port.sender)
        .then((res) => {
          if (msg?.type === MSG.STATE) port.postMessage({ type: MSG.HELLO, payload: res });
          else if (msg?.replyId != null) port.postMessage({ type: "reply", replyId: msg.replyId, payload: res });
        })
        .catch((err) => port.postMessage({ type: MSG.ERROR, payload: { message: String(err?.message || err) } }));
    });
    apiKeyStatus().then((apiKey) => port.postMessage({ type: MSG.HELLO, payload: { ...controller.uiState(), apiKey } })).catch(() => {});
  }

  controller.start().catch((err) => controller._log("warn", `initial snapshot failed: ${err.message || err}`));

  return { controller, browser, handleMessage, onConnect, ports, broadcast, persist };
}
