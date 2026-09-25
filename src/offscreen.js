/**
 * Offscreen document (local addition): the microphone lives here instead of in the side panel, so
 * listening continues while the side panel is closed. The service worker creates this document
 * when the mic is switched on and closes it when the mic is switched off (see mic-host.js).
 *
 * Recognisers (moved here from the side panel):
 *  - ElevenLabs Scribe v2 Realtime (ScribeMic) when the worker says so; tokens come from the worker
 *  - Chrome Web Speech (webkitSpeechRecognition) otherwise, and as the fallback when ElevenLabs fails
 *
 * Transcripts go to the worker as MSG.TRANSCRIPT, exactly what the side panel used to send.
 * Offscreen documents only get chrome.runtime, so everything else arrives in the start message.
 */
import { MSG } from "./protocol.js";
import { ScribeMic } from "./scribe-mic.js";

(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const IDLE_STOP_MS = 3 * 60 * 1000; // ElevenLabs bills streamed audio: pause after 3 quiet minutes
  const KEEPALIVE_MS = 20000; // keep the service worker (controller state) alive while listening
  const st = { on: false, engine: null, lang: "ko-KR", since: 0, audioAt: 0 };
  let scribe = null;
  let rec = null;
  let utteranceBase = 0;
  let lastHeardAt = 0;
  let idleTimer = null;
  let keepAlive = null;
  let restarts = [];

  const toWorker = (m) => chrome.runtime.sendMessage(m).catch(() => {});
  const log = (line) => toWorker({ type: MSG.MIC_EVENT, kind: "log", line });
  function transcript(t, engine, extra = "") {
    lastHeardAt = Date.now();
    log(`${t.final ? "final  " : "interim"} id=${t.utteranceId} “${String(t.text).trim()}”${extra} (${engine})`);
    toWorker({ type: MSG.TRANSCRIPT, text: t.text, final: t.final, utteranceId: t.utteranceId });
  }

  async function micPermission() {
    try {
      return (await navigator.permissions.query({ name: "microphone" })).state;
    } catch {
      return "prompt";
    }
  }

  // ------------------------------------------------------------------ ElevenLabs
  async function startScribe(keyterms) {
    const s = new ScribeMic({
      getToken: () => chrome.runtime.sendMessage({ type: MSG.STT_TOKEN }),
      workletUrl: chrome.runtime.getURL("scribe-worklet.js"),
      onTranscript: (t) => {
        if (s === scribe) transcript(t, "elevenlabs");
      },
      onState: (x) =>
        log(
          `elevenlabs ${x.state}${x.reason ? ` (${x.reason})` : ""}${x.connectMs != null ? ` in ${x.connectMs} ms` : ""}${x.keyterms != null ? ` · ${x.keyterms} page words` : ""}${x.audioSeconds != null ? ` · ${x.audioSeconds}s streamed` : ""}`,
        ),
      onError: (e) => {
        log(`elevenlabs error: ${e.code} — ${e.message}`);
        if (s !== scribe) return;
        if (!e.fatal) {
          toWorker({ type: MSG.MIC_EVENT, kind: "notice", message: `ElevenLabs: ${e.message}` });
          return;
        }
        // While starting, start() handles the failure; once running, keep listening with Chrome.
        if (st.on) {
          scribe = null;
          fallbackToChrome({ code: e.code, message: e.message });
        }
      },
      onLog: (m) => log(m),
    });
    scribe = s;
    try {
      await s.start({ lang: st.lang, keyterms });
    } catch (err) {
      if (scribe === s) scribe = null;
      return { ok: false, code: "stt_start", message: `${err?.name || "Error"}: ${err?.message || err}` };
    }
    if (!s.active || scribe !== s) {
      if (scribe === s) scribe = null;
      return { ok: false, code: "stt_start", message: "the ElevenLabs session did not start" };
    }
    st.audioAt = s.audioAt || Date.now();
    return { ok: true };
  }

  // ------------------------------------------------------------------ Chrome Web Speech
  function startChrome() {
    if (!SR) return { ok: false, code: "no_speech_api", message: "speech recognition isn’t available in this browser" };
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = st.lang;
    r.maxAlternatives = 1;
    r.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const x = ev.results[i];
        transcript({ text: x[0].transcript, final: x.isFinal, utteranceId: `u${utteranceBase}-${i}` }, "chrome", ` ${(x[0].confidence || 0).toFixed(2)}`);
      }
    };
    r.onerror = (e) => {
      log(`error: ${e.error}`);
      if (rec !== r) return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") stop("denied");
      else if (e.error !== "no-speech" && e.error !== "aborted") toWorker({ type: MSG.MIC_EVENT, kind: "notice", message: `speech error: ${e.error}` });
    };
    r.onend = () => {
      if (rec !== r) return;
      log(`end${st.on ? " → restart" : ""}`);
      if (!st.on || st.engine !== "chrome") return;
      const now = Date.now();
      restarts = restarts.filter((t) => now - t < 10000);
      restarts.push(now);
      if (restarts.length > 6) {
        stop("error", { code: "chrome_restart_loop", message: "Chrome’s recogniser keeps stopping" });
        return;
      }
      utteranceBase += 1;
      try {
        r.start();
      } catch {}
    };
    try {
      r.start();
    } catch (err) {
      return { ok: false, code: "chrome_start", message: err?.message || String(err) };
    }
    rec = r;
    st.audioAt = Date.now();
    return { ok: true };
  }

  function fallbackToChrome(problem) {
    const c = startChrome();
    if (!c.ok) {
      stop("error", problem);
      return;
    }
    st.engine = "chrome";
    toWorker({ type: MSG.MIC_EVENT, kind: "engine", engine: "chrome", problem });
  }

  // ------------------------------------------------------------------ lifecycle
  function began(engine, problem = null) {
    st.on = true;
    st.engine = engine;
    st.since = Date.now();
    lastHeardAt = Date.now();
    restarts = [];
    clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (st.on && st.engine === "elevenlabs" && Date.now() - lastHeardAt > IDLE_STOP_MS) stop("idle");
    }, 10000);
    clearInterval(keepAlive);
    keepAlive = setInterval(() => toWorker({ type: MSG.PING }), KEEPALIVE_MS);
    return { ok: true, engine, problem, audioAt: st.audioAt };
  }

  async function start({ lang, engine, keyterms }) {
    if (st.on || scribe || rec) stop("restart", null, { notify: false });
    st.lang = lang || "ko-KR";
    const perm = await micPermission();
    if (perm !== "granted") return { ok: false, code: "mic_permission", state: perm };
    let problem = null;
    if (engine === "elevenlabs") {
      const r = await startScribe(keyterms || []);
      if (r.ok) return began("elevenlabs");
      problem = { code: r.code, message: r.message };
      log(`elevenlabs start failed: ${r.message} — using Chrome`);
    }
    const c = startChrome();
    if (!c.ok) return { ok: false, code: c.code, message: c.message, problem };
    return began("chrome", problem);
  }

  function stop(reason = "user", problem = null, { notify = true } = {}) {
    const was = st.on;
    st.on = false;
    st.engine = null;
    clearInterval(idleTimer);
    clearInterval(keepAlive);
    if (scribe) {
      const s = scribe;
      scribe = null;
      s.stop();
    }
    if (rec) {
      const r = rec;
      rec = null;
      try {
        r.onend = null;
        r.stop();
      } catch {}
    }
    if (notify && was) toWorker({ type: MSG.MIC_EVENT, kind: "stopped", reason, problem });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== "offscreen") return false;
    (async () => {
      switch (msg.type) {
        case MSG.OFF_START:
          return start(msg);
        case MSG.OFF_STOP:
          stop(msg.reason || "user", null, { notify: false });
          return { ok: true };
        case MSG.OFF_KEYTERMS:
          if (scribe) scribe.updateKeyterms(Array.isArray(msg.keyterms) ? msg.keyterms : []);
          return { ok: true };
        case MSG.OFF_STATUS:
          return { on: st.on, engine: st.engine, lang: st.lang, since: st.since, audioAt: st.audioAt };
        default:
          return { ok: false, error: `unknown offscreen message ${msg.type}` };
      }
    })().then(sendResponse, (err) => sendResponse({ ok: false, code: "offscreen", message: String(err?.message || err) }));
    return true;
  });
})();
