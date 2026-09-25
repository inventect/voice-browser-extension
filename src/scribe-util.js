/**
 * ElevenLabs Scribe v2 Realtime helpers (local addition, not upstream). Pure functions only, so
 * they are unit-testable in Node and shared by the service worker, the side panel and the probes.
 *
 *  - mintScribeToken(): single-use token (15 min, one session) — runs in the service worker so the
 *                       long-lived key never reaches a page
 *  - buildScribeUrl():  the realtime WebSocket URL (token, language, VAD commit, keyterms)
 *  - buildKeyterms():   ≤ 50 short terms from the current page snapshot + site names, biasing
 *                       recognition toward what is actually on screen ("메일", "쇼핑라이브" …)
 *  - scribeMessageToTranscript(): server message → the side panel's {text, final, utteranceId}
 */

export const SCRIBE_WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
export const SCRIBE_TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
export const SCRIBE_MODEL = "scribe_v2_realtime";
export const SCRIBE_SAMPLE_RATE = 16000;
export const MAX_KEYTERMS = 50; // realtime limit
export const MAX_KEYTERM_CHARS = 20; // realtime limit per term

/** ko-KR → ko, en-US → en (ISO 639-1, what the realtime API expects). */
export function scribeLanguage(lang) {
  return String(lang || "ko").slice(0, 2).toLowerCase();
}

/**
 * @param {{token: string, languageCode?: string, keyterms?: string[], vadSilenceSecs?: number}} o
 */
export function buildScribeUrl({ token, languageCode = "ko", keyterms = [], vadSilenceSecs = 0.8 } = {}) {
  const p = new URLSearchParams();
  p.append("model_id", SCRIBE_MODEL);
  p.append("token", token);
  p.append("audio_format", `pcm_${SCRIBE_SAMPLE_RATE}`);
  p.append("language_code", scribeLanguage(languageCode));
  p.append("commit_strategy", "vad");
  p.append("vad_silence_threshold_secs", String(vadSilenceSecs));
  for (const k of keyterms.slice(0, MAX_KEYTERMS)) p.append("keyterms", k);
  return `${SCRIBE_WS_URL}?${p.toString()}`;
}

/**
 * Mint a single-use realtime token. Never throws; the key is sent only as the xi-api-key header
 * and never appears in the result.
 * @returns {Promise<{ok: true, token: string} | {ok: false, error: string, status?: number, code?: string}>}
 */
export async function mintScribeToken({ apiKey, fetchFn = (...a) => globalThis.fetch(...a), timeoutMs = 8000 } = {}) {
  if (!apiKey) return { ok: false, error: "no ElevenLabs API key set", code: "no_stt_key" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(SCRIBE_TOKEN_URL, { method: "POST", headers: { "xi-api-key": apiKey }, signal: ctl.signal });
    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = j?.detail?.message || j?.detail?.status || (typeof j?.detail === "string" ? j.detail : "");
      } catch {}
      detail = String(detail).split(apiKey).join("…").slice(0, 200);
      return { ok: false, status: res.status, error: `ElevenLabs HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, code: res.status === 401 ? "stt_key_rejected" : "stt_http" };
    }
    const j = await res.json().catch(() => null);
    if (!j?.token) return { ok: false, error: "ElevenLabs returned no token", code: "stt_http" };
    return { ok: true, token: String(j.token) };
  } catch (err) {
    return { ok: false, error: err?.name === "AbortError" ? "ElevenLabs token request timed out" : String(err?.message || err), code: "stt_network" };
  } finally {
    clearTimeout(timer);
  }
}

// Site names people say out loud; always useful as bias terms.
const SITE_TERMS = {
  ko: ["네이버", "유튜브", "위키피디아", "구글", "해커뉴스", "깃허브", "아마존", "다음", "쿠팡"],
  en: ["Wikipedia", "YouTube", "Hacker News", "GitHub", "Google", "Amazon", "Reddit"],
};

const HANGUL = /[\uac00-\ud7a3]/;
const LATIN = /[a-z]/i;

/** Clean one element label into a keyterm candidate, or "" when it is not useful. */
export function cleanTerm(raw) {
  const s = String(raw || "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[^\p{L}\p{N}\s&+'-]/gu, " ") // punctuation, emoji, arrows …
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  if (s.length > MAX_KEYTERM_CHARS) return ""; // long sentences / headlines are not commands
  if (s.split(" ").length > 3) return "";
  if (!HANGUL.test(s) && !LATIN.test(s)) return ""; // numbers, dates, symbols
  if (/^(https?|www)\b/i.test(s)) return "";
  if (s.length < 2) return "";
  return s;
}

/**
 * @param {{elements?: Array<{text?: string, placeholder?: string, popup?: boolean, below_fold?: boolean}>}} snapshot
 * @param {string} lang "ko" | "en" | "ko-KR" …
 * @returns {string[]} ≤ 50 unique terms: pop-up controls, visible labels, below-the-fold labels, site names
 */
export function buildKeyterms(snapshot, lang = "ko") {
  const code = scribeLanguage(lang);
  const sites = SITE_TERMS[code] || SITE_TERMS.ko;
  const out = [];
  const seen = new Set();
  const push = (t) => {
    const c = cleanTerm(t);
    const key = c.toLowerCase();
    if (!c || seen.has(key) || out.length >= MAX_KEYTERMS) return;
    seen.add(key);
    out.push(c);
  };
  const els = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const ordered = [...els.filter((e) => e.popup), ...els.filter((e) => !e.popup && !e.below_fold), ...els.filter((e) => !e.popup && e.below_fold)];
  for (const e of ordered) {
    if (out.length >= MAX_KEYTERMS - sites.length) break;
    push(e.text || e.placeholder || "");
  }
  for (const t of sites) push(t);
  return out;
}

/** Same set of terms (order-insensitive)? Used to skip needless session rotations. */
export function sameKeyterms(a = [], b = []) {
  if (a.length !== b.length) return false;
  const s = new Set(a.map((x) => x.toLowerCase()));
  return b.every((x) => s.has(x.toLowerCase()));
}

/**
 * Map one Scribe server message to the side panel's transcript message, or null.
 * Partials are cumulative for the current segment; a committed transcript closes it.
 */
export function scribeMessageToTranscript(msg, { session = 0, segment = 0 } = {}) {
  if (!msg || typeof msg !== "object") return null;
  const text = String(msg.text || "").trim();
  if (!text) return null;
  const utteranceId = `el${session}-${segment}`;
  if (msg.message_type === "partial_transcript") return { text, final: false, utteranceId };
  if (msg.message_type === "committed_transcript") return { text, final: true, utteranceId };
  return null;
}

/** Server message types that end the session for good (no automatic reconnect). */
export const SCRIBE_FATAL = new Set(["auth_error", "quota_exceeded", "unaccepted_terms", "invalid_request", "resource_exhausted"]);
