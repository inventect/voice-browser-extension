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
import { buildKeyterms, mintScribeToken, sameKeyterms } from "./scribe-util.js";
import { createMicHost } from "./mic-host.js";

const SESSION_KEY = "vbState";
const KEY_NAME = "apiKey";
// Local addition: ElevenLabs key + engine choice ("auto" = ElevenLabs when a key is saved).
const STT_KEY_NAME = "elevenLabsKey";
const STT_ENGINE_NAME = "sttEngine";
export const STT_ENGINES = ["auto", "elevenlabs", "chrome"];
// Local addition: recognition / UI language, owned by the worker (the mic lives offscreen now).
const LANG_NAME = "vbLang";
export const LANGS = ["ko-KR", "en-US"];
const SPEECH_RING = 80; // raw recogniser lines kept for a side panel opened later
const BADGE_ON = { text: "ON", color: "#0071E3" };

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
export async function createApp({ chrome = globalThis.chrome, decideFn = decide, executeFn = execute, sttFetch, micHost = null } = {}) {
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

  // ---------------------------------------------------------------- microphone (local addition)
  // The recognisers run in an offscreen document so listening survives closing the side panel.
  // The worker owns the on/off state, keeps a short raw speech log for a panel opened later,
  // pushes page words (ElevenLabs keyterms) and shows an "ON" badge on the toolbar icon.
  const host = micHost || createMicHost(chrome);
  const mic = { on: false, starting: false, engine: null, lang: "ko-KR", since: null, audioAt: null, error: null, notice: null, stopReason: null };
  const speech = [];
  let lastKeyterms = [];
  let cancelStart = false;
  try {
    const got = await chrome.storage.local.get(LANG_NAME);
    if (LANGS.includes(got?.[LANG_NAME])) mic.lang = got[LANG_NAME];
  } catch {}
  const micState = () => ({ ...mic });
  function speechLine(line) {
    const e = { t: Date.now(), line: String(line) };
    speech.push(e);
    if (speech.length > SPEECH_RING) speech.shift();
    broadcast(MSG.SPEECH, e);
  }
  function setBadge() {
    const a = chrome.action;
    if (!a) return;
    const quiet = (p) => p?.catch?.(() => {});
    try {
      quiet(a.setBadgeText?.({ text: mic.on ? BADGE_ON.text : "" }));
      if (mic.on) quiet(a.setBadgeBackgroundColor?.({ color: BADGE_ON.color }));
      if (mic.on) quiet(a.setBadgeTextColor?.({ color: "#FFFFFF" }));
      quiet(a.setTitle?.({ title: mic.on ? "Voice Browser — listening (click for the panel)" : "Voice Browser — open the side panel" }));
    } catch {}
  }
  function micChanged() {
    setBadge();
    broadcast(MSG.MIC, micState());
  }
  const pageKeyterms = () => buildKeyterms(controller.uiState().snapshot || null, mic.lang);
  function pushKeyterms() {
    if (!mic.on || mic.engine !== "elevenlabs") return;
    const kt = pageKeyterms();
    if (sameKeyterms(kt, lastKeyterms)) return;
    lastKeyterms = kt;
    host.send({ type: MSG.OFF_KEYTERMS, keyterms: kt }).catch(() => {});
  }
  function openPermissionTab(state) {
    const reason = state === "denied" ? "denied" : "prompt";
    chrome.tabs?.create?.({ url: chrome.runtime.getURL(`permission.html?reason=${reason}&start=1`) })?.catch?.(() => {});
  }

  async function micStart({ fromShortcut = false } = {}) {
    if (mic.on || mic.starting) return micState();
    mic.starting = true;
    mic.error = null;
    mic.notice = null;
    mic.stopReason = null;
    cancelStart = false;
    micChanged();
    try {
      const stt = await sttStatus();
      lastKeyterms = pageKeyterms();
      await host.ensure();
      const r = await host.send({ type: MSG.OFF_START, lang: mic.lang, engine: stt.resolved, keyterms: lastKeyterms });
      if (!r?.ok) {
        mic.error = { code: r?.code || "mic_start", message: r?.message || r?.error || "could not start the microphone", state: r?.state || null };
        speechLine(`mic failed: ${mic.error.code}${mic.error.state ? ` (${mic.error.state})` : ""} — ${mic.error.message}`);
        await host.close();
        if (mic.error.code === "mic_permission" && fromShortcut) openPermissionTab(mic.error.state);
        return micState();
      }
      if (cancelStart) {
        await host.send({ type: MSG.OFF_STOP, reason: "cancelled" }).catch(() => {});
        await host.close();
        return micState();
      }
      mic.on = true;
      mic.engine = r.engine;
      mic.since = Date.now();
      mic.audioAt = r.audioAt ?? null;
      if (r.problem) mic.notice = { code: r.problem.code, message: r.problem.message };
      speechLine(`mic on · ${r.engine === "elevenlabs" ? "ElevenLabs Scribe v2 Realtime" : "Chrome Web Speech"} · ${mic.lang}${r.problem ? ` · ElevenLabs unavailable: ${r.problem.message}` : ""}`);
    } catch (err) {
      mic.error = { code: "mic_start", message: String(err?.message || err) };
      speechLine(`mic failed: ${mic.error.message}`);
      await host.close().catch(() => {});
    } finally {
      mic.starting = false;
      micChanged();
    }
    return micState();
  }

  async function micStop(reason = "user") {
    if (mic.starting) cancelStart = true;
    const was = mic.on;
    mic.on = false;
    mic.engine = null;
    mic.since = null;
    mic.stopReason = reason;
    if (was) {
      await host.send({ type: MSG.OFF_STOP, reason }).catch(() => {});
      await host.close();
      speechLine(`mic off (${reason})`);
    }
    micChanged();
    return micState();
  }
  const micToggle = (opts) => (mic.on || mic.starting ? micStop("user") : micStart(opts));

  function onMicEvent(ev) {
    switch (ev?.kind) {
      case "log":
        speechLine(ev.line);
        return;
      case "notice":
        mic.notice = { code: "notice", message: String(ev.message || ""), transient: true };
        broadcast(MSG.MIC, micState());
        return;
      case "engine":
        mic.engine = ev.engine;
        mic.notice = ev.problem ? { code: ev.problem.code, message: ev.problem.message } : null;
        speechLine(`switched to ${ev.engine === "chrome" ? "Chrome Web Speech" : ev.engine}${ev.problem ? ` (${ev.problem.message})` : ""}`);
        micChanged();
        return;
      case "stopped":
        if (!mic.on) return;
        mic.on = false;
        mic.engine = null;
        mic.since = null;
        mic.stopReason = ev.reason || "stopped";
        if (ev.reason === "denied") mic.error = { code: "mic_permission", state: "denied", message: "microphone blocked" };
        else if (ev.problem) mic.error = { code: ev.problem.code || "mic", message: ev.problem.message || "" };
        speechLine(`mic off (${mic.stopReason})`);
        host.close();
        micChanged();
        return;
      default:
    }
  }

  async function setLang(lang) {
    if (!LANGS.includes(lang) || lang === mic.lang) return micState();
    mic.lang = lang;
    await chrome.storage.local.set({ [LANG_NAME]: lang }).catch?.(() => {});
    if (mic.on) {
      await micStop("language");
      return micStart();
    }
    micChanged();
    return micState();
  }

  // Keep ElevenLabs' page words current while listening (applied at the next quiet moment).
  controller.on("snapshot", () => pushKeyterms());
  controller.on("action", () => pushKeyterms());

  // A restarted service worker re-adopts a microphone that is still running offscreen.
  (async () => {
    try {
      if (!(await host.exists())) return;
      const s = await host.send({ type: MSG.OFF_STATUS });
      if (s?.on) {
        Object.assign(mic, { on: true, engine: s.engine, lang: s.lang || mic.lang, since: s.since || Date.now(), audioAt: s.audioAt ?? null });
        micChanged();
      } else {
        await host.close();
      }
    } catch {}
  })();

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
        return { ...controller.uiState(), apiKey: await apiKeyStatus(), mic: micState(), speech: speech.slice(), stt: await sttStatus(), questions: msg.withQuestions ? QUESTIONS : undefined, thresholds: T };
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
      case MSG.MIC_STATE:
        return micState();
      case MSG.MIC_START:
        return micStart();
      case MSG.MIC_STOP:
        return micStop(typeof msg.reason === "string" ? msg.reason : "user");
      case MSG.MIC_TOGGLE:
        return micToggle();
      case MSG.SET_LANG:
        return setLang(msg.lang);
      case MSG.MIC_EVENT:
        onMicEvent(msg);
        return { ok: true };
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
    Promise.all([apiKeyStatus(), sttStatus()])
      .then(([apiKey, stt]) => port.postMessage({ type: MSG.HELLO, payload: { ...controller.uiState(), apiKey, stt, mic: micState(), speech: speech.slice() } }))
      .catch(() => {});
  }

  controller.start().catch((err) => controller._log("warn", `initial snapshot failed: ${err.message || err}`));

  return { controller, browser, handleMessage, onConnect, ports, broadcast, persist, micState, micToggle, speechLog: () => speech.slice() };
}
