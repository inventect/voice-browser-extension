/**
 * ScribeMic (local addition): microphone → ElevenLabs Scribe v2 Realtime → transcript callbacks
 * shaped exactly like the Web Speech path ({ text, final, utteranceId }), so the controller in the
 * service worker does not know which recogniser is in use.
 *
 *  - audio: getUserMedia (echo cancel / noise suppression / AGC) → AudioContext @16 kHz →
 *    AudioWorklet (scribe-worklet.js) → 100 ms PCM16 chunks → WebSocket
 *  - auth: a single-use token minted by the service worker (the API key never reaches this page)
 *  - keyterms: labels of the page being controlled; when they change the session is rotated while
 *    the user is silent (keyterms can only be set when a session opens). Audio produced while a
 *    session is (re)connecting is queued (≤ 3 s) and flushed, so words are not lost.
 *  - unexpected close → reconnect with backoff; fatal server errors (auth, quota …) → onError(fatal)
 */
import { buildScribeUrl, scribeMessageToTranscript, sameKeyterms, SCRIBE_FATAL, SCRIBE_SAMPLE_RATE } from "./scribe-util.js";

const QUEUE_MAX_CHUNKS = 60; // 6 s of 100 ms chunks (a slow reconnect must not eat the first words)
const ROTATE_IDLE_MS = 900; // rotate a session only after this much quiet
const VOICE_PEAK = 0.04; // chunk peak above this counts as "someone is talking"
const MAX_RECONNECTS = 5;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class ScribeMic {
  /**
   * @param {{getToken: () => Promise<{ok: boolean, token?: string, error?: string, code?: string}>,
   *          workletUrl: string, onTranscript: Function, onState?: Function, onError?: Function, onLog?: Function,
   *          vadSilenceSecs?: number}} opts
   */
  constructor(opts) {
    this.getToken = opts.getToken;
    this.workletUrl = opts.workletUrl;
    this.onTranscript = opts.onTranscript;
    this.onState = opts.onState || (() => {});
    this.onError = opts.onError || (() => {});
    this.onLog = opts.onLog || (() => {});
    this.vadSilenceSecs = opts.vadSilenceSecs ?? 0.8;
    this.active = false;
    this.session = 0;
    this.ws = null;
    this.queue = [];
    this.connecting = false;
    this.pendingKeyterms = null;
    this.keyterms = [];
    this.partialOpen = false;
    this.lastVoiceAt = 0;
    this.reconnects = 0;
    this.audioSeconds = 0;
  }

  /** @param {{lang: string, keyterms?: string[]}} o */
  async start({ lang, keyterms = [] }) {
    if (this.active) return;
    this.active = true;
    this.lang = lang;
    this.keyterms = keyterms;
    this.pendingKeyterms = null;
    this.reconnects = 0;
    this.audioSeconds = 0;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      this.audioAt = Date.now(); // when the capture device started (probes time actions against it)
      if (!this.active) return this._release();
      let ctx = null;
      try {
        ctx = new AudioContext({ sampleRate: SCRIBE_SAMPLE_RATE }); // Chrome resamples the mic for us
        this.src = ctx.createMediaStreamSource(this.stream);
      } catch {
        try {
          await ctx?.close();
        } catch {}
        ctx = new AudioContext(); // native rate; the worklet decimates to 16 kHz
        this.src = ctx.createMediaStreamSource(this.stream);
      }
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(this.workletUrl);
      this.node = new AudioWorkletNode(ctx, "vb-pcm16", { processorOptions: { inRate: ctx.sampleRate, outRate: SCRIBE_SAMPLE_RATE } });
      this.node.port.onmessage = (ev) => this._onPcm(ev.data);
      this.src.connect(this.node);
      this.node.connect(ctx.destination); // silent output; keeps the node pulled by the graph
      if (ctx.state === "suspended") await ctx.resume();
      this.onLog(`scribe: mic ${this.stream.getAudioTracks()[0]?.label || "?"} · context ${ctx.sampleRate} Hz`);
    } catch (err) {
      this.active = false;
      this._release();
      throw err;
    }
    await this._openSession("start");
  }

  stop() {
    this.active = false;
    this.session += 1; // invalidates any in-flight connect
    const ws = this.ws;
    this.ws = null;
    this.queue = [];
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: SCRIBE_SAMPLE_RATE }));
    } catch {}
    try {
      ws?.close();
    } catch {}
    this._release();
    this.onState({ state: "stopped", audioSeconds: Math.round(this.audioSeconds) });
  }

  /** New page labels: applied by rotating the session at the next quiet moment. */
  updateKeyterms(terms) {
    if (!this.active) return;
    if (sameKeyterms(terms, this.pendingKeyterms || this.keyterms)) return;
    this.pendingKeyterms = terms;
  }

  // ------------------------------------------------------------------ internals
  _release() {
    try {
      this.node?.port && (this.node.port.onmessage = null);
      this.src?.disconnect();
      this.node?.disconnect();
    } catch {}
    for (const t of this.stream?.getTracks() || []) t.stop();
    try {
      this.ctx?.close();
    } catch {}
    this.node = this.src = this.ctx = this.stream = null;
  }

  _onPcm({ pcm, peak }) {
    if (!this.active) return;
    const now = performance.now();
    if (peak > VOICE_PEAK) this.lastVoiceAt = now;
    this.audioSeconds += 0.1;
    const msg = JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: toBase64(pcm), commit: false, sample_rate: SCRIBE_SAMPLE_RATE });
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.connecting) {
      this.ws.send(msg);
    } else {
      this.queue.push(msg);
      if (this.queue.length > QUEUE_MAX_CHUNKS) this.queue.shift();
    }
    if (this.pendingKeyterms && !this.connecting && !this.partialOpen && now - this.lastVoiceAt > ROTATE_IDLE_MS) {
      this.keyterms = this.pendingKeyterms;
      this.pendingKeyterms = null;
      this._openSession("keyterms");
    }
  }

  async _openSession(reason) {
    const my = ++this.session;
    this.connecting = true;
    const t0 = performance.now();
    let tok;
    try {
      tok = await this.getToken();
    } catch (err) {
      tok = { ok: false, error: String(err?.message || err), code: "stt_network" };
    }
    if (!this.active || my !== this.session) return;
    if (!tok?.ok) {
      this.connecting = false;
      const fatal = tok?.code === "no_stt_key" || tok?.code === "stt_key_rejected";
      this.onError({ fatal, code: tok?.code || "stt_token", message: tok?.error || "could not get an ElevenLabs token" });
      if (fatal) this.stop();
      else this._scheduleReconnect();
      return;
    }
    const ws = new WebSocket(buildScribeUrl({ token: tok.token, languageCode: this.lang, keyterms: this.keyterms, vadSilenceSecs: this.vadSilenceSecs }));
    ws._seg = 0;
    ws._session = my;
    ws.onopen = () => {
      ws._opened = true;
      if (!this.active || my !== this.session) {
        try {
          ws.close();
        } catch {}
        return;
      }
      const old = this.ws;
      this.ws = ws;
      this.connecting = false;
      this.reconnects = 0;
      for (const m of this.queue.splice(0)) ws.send(m);
      if (old && old !== ws) {
        try {
          old.close();
        } catch {}
      }
      this.onState({ state: "open", reason, session: my, keyterms: this.keyterms.length, connectMs: Math.round(performance.now() - t0) });
    };
    ws.onmessage = (ev) => this._onServer(ev, ws);
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (!ws._opened) {
        // Handshake failed (network, rejected token …): only the newest attempt may retry.
        if (this.active && my === this.session) {
          this.connecting = false;
          this.onLog(`scribe: session ${my} could not open (${ev.code}${ev.reason ? ` ${ev.reason}` : ""}) — retrying`);
          this._scheduleReconnect();
        }
        return;
      }
      if (ws !== this.ws) return; // rotated away or stopped
      this.ws = null;
      if (!this.active) return;
      if (ws._fatal) return;
      this.onLog(`scribe: session ${ws._session} closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ""}) — reconnecting`);
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    if (!this.active) return;
    this.reconnects += 1;
    if (this.reconnects > MAX_RECONNECTS) {
      this.onError({ fatal: true, code: "stt_reconnect", message: "lost the ElevenLabs connection" });
      this.stop();
      return;
    }
    this.connecting = true;
    setTimeout(() => this.active && this._openSession("reconnect"), Math.min(4000, 400 * 2 ** (this.reconnects - 1)));
  }

  _onServer(ev, ws) {
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    const type = d?.message_type;
    if (type === "session_started") return;
    if (type === "partial_transcript" || type === "committed_transcript") {
      const tr = scribeMessageToTranscript(d, { session: ws._session, segment: ws._seg });
      if (type === "committed_transcript") {
        ws._seg += 1;
        this.partialOpen = false;
      } else if (tr) {
        this.partialOpen = true;
      }
      if (tr) this.onTranscript(tr);
      return;
    }
    if (/transcript/.test(type || "")) return; // *_with_timestamps, entities
    const fatal = SCRIBE_FATAL.has(type);
    const message = String(d?.error || d?.message || type || "unknown error");
    if (fatal) ws._fatal = true;
    this.onError({ fatal, code: type, message });
    if (fatal) this.stop();
  }
}
