/**
 * The single Jev request per transcript update: build state + speculative question fan-out,
 * call the API, return typed answers with latency / usage / cost.
 *
 * Extension port of voice-browser/src/jev.js: no SDK, a plain `fetch` to the System One endpoint
 * so it bundles cleanly into the MV3 service worker. The API key is supplied by a provider
 * function (service worker: chrome.storage.local; Node tests: TYPESAFE_API_KEY / JEV_API_KEY).
 * `buildRequest`, `encodeElement`, `encodeContext` are verbatim from the original.
 */
import { MODEL, PRICE_PER_M_INPUT_TOKENS_USD, QUESTIONS, MAX_TRANSCRIPT_CHARS, MAX_CONTEXT_ACTIONS } from "./constants.js";
import { extractTextCandidates, extractUrlCandidates } from "./spans.js";

export const API_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 8000;

// Question constructors — same wire shape the @typesafe-ai/sdk helpers produce.
export const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });
export const noul = (instructions, criteria) => (criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions });
export const score = (instructions, criteria) => ({ type: "score", instructions, criteria });

function envKey() {
  const env = globalThis.process?.env;
  return env?.TYPESAFE_API_KEY || env?.JEV_API_KEY || "";
}

let _getApiKey = async () => envKey();
let _fetch = (...args) => globalThis.fetch(...args);

/** Configure where the key comes from (and optionally the fetch implementation, for tests). */
export function configureJev({ getApiKey, fetch } = {}) {
  if (getApiKey) _getApiKey = getApiKey;
  if (fetch) _fetch = fetch;
}

/** Sync check used by the Node tests (env var). The service worker checks chrome.storage itself. */
export function hasApiKey() {
  return Boolean(envKey());
}

export function costUsd(usage) {
  const tokens = usage?.input_tokens ?? 0;
  return (tokens / 1_000_000) * PRICE_PER_M_INPUT_TOKENS_USD;
}

export class JevApiError extends Error {
  constructor(message, { status = 0, requestId = null, body = null } = {}) {
    super(message);
    this.name = "JevApiError";
    this.status = status;
    this.requestId = requestId;
    this.body = body;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** `e09 link "GitHub - typesafe-ai" → github.com` — short, human-readable, few tokens. */
export function encodeElement(el, pageHost = "") {
  let s = `${el.id} ${el.role}`;
  const text = el.text || "";
  if (text) s += ` "${text}"`;
  if (el.placeholder && el.placeholder !== text) s += ` (placeholder: ${el.placeholder})`;
  if (el.href) {
    const host = el.href.split("/")[0];
    if (host && host !== pageHost) s += ` → ${host}`;
  }
  if (el.popup) s += " [popup]";
  if (el.frame) s += " [in frame]";
  if (el.below_fold) s += " [below fold]";
  return s;
}

/**
 * Compact conversation context: where the user just came from and the last few executed actions,
 * most recent first. `null` when nothing has happened yet.
 */
export function encodeContext(context) {
  if (!context) return null;
  const out = {};
  if (context.previousPage?.url) {
    out.previous_page = {
      url: String(context.previousPage.url).slice(0, 200),
      title: String(context.previousPage.title || "").slice(0, 120),
    };
  }
  const actions = (context.recentActions || []).slice(-MAX_CONTEXT_ACTIONS).reverse();
  if (actions.length) {
    const now = Date.now();
    out.recent_actions = actions.map((a) => {
      const e = { said: String(a.said || "").slice(0, 120), action: a.type };
      if (a.targetLabel) e.target = String(a.targetLabel).slice(0, 80);
      if (a.text) e.text = String(a.text).slice(0, 80);
      if (a.url) e.url = String(a.url).slice(0, 200);
      e.outcome = a.outcome || (a.ok === false ? "failed" : "done");
      if (a.at) e.seconds_ago = Math.max(0, Math.round((now - a.at) / 1000));
      return e;
    });
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Build the state object and question map for one decision.
 * Exported so tests can inspect exactly what Jev sees.
 */
export function buildRequest({ transcript, snapshot, pendingConfirmation = null, tabs = null, context = null }) {
  const text = String(transcript || "").slice(-MAX_TRANSCRIPT_CHARS);
  const textCandidates = extractTextCandidates(text);
  const urlCandidates = extractUrlCandidates(text);

  const elements = snapshot?.elements || [];
  const pageHost = hostOf(snapshot?.url);
  const state = {
    transcript: text,
    page: {
      url: (snapshot?.url || "about:blank").slice(0, 200),
      title: (snapshot?.title || "").slice(0, 120),
      site: snapshot?.site || "blank",
    },
    // One compact line per element, in visual order (pop-up controls, then viewport, then the rest).
    // The `target` question's options are these ids; their text lives here (semantic-find pattern).
    elements: elements.map((el) => encodeElement(el, pageHost)),
  };
  if (snapshot?.popup) {
    state.page.modal_open = true;
    state.page.modal_kind = snapshot.popup.kind === "banner" ? "banner (e.g. cookie consent)" : "dialog";
    state.page.modal_text = String(snapshot.popup.text || "").slice(0, 120);
  }
  const ctx = encodeContext(context);
  if (ctx) state.context = ctx;
  if (pendingConfirmation) state.pending_confirmation = pendingConfirmation;
  if (tabs && tabs.length > 1) state.open_tabs = tabs.length;

  const targetCriteria = {};
  for (const el of elements) targetCriteria[el.id] = null;
  targetCriteria.none = "No element on this page is referred to";

  const questions = {
    intent: choice(QUESTIONS.intent.instructions, QUESTIONS.intent.criteria),
    target: choice(QUESTIONS.target.instructions, targetCriteria),
    site: choice(QUESTIONS.site.instructions, QUESTIONS.site.criteria),
    complete: noul(QUESTIONS.complete.instructions, QUESTIONS.complete.criteria),
    is_command: noul(QUESTIONS.is_command.instructions, QUESTIONS.is_command.criteria),
    destructive: noul(QUESTIONS.destructive.instructions, QUESTIONS.destructive.criteria),
    scroll_amount: score(QUESTIONS.scroll_amount.instructions, QUESTIONS.scroll_amount.criteria),
    tab_direction: choice(QUESTIONS.tab_direction.instructions, QUESTIONS.tab_direction.criteria),
  };
  if (ctx?.recent_actions?.length) {
    questions.is_correction = noul(QUESTIONS.is_correction.instructions, QUESTIONS.is_correction.criteria);
  }

  if (textCandidates.length) {
    const c = Object.fromEntries(textCandidates.map((s) => [s, null]));
    c.none = "Nothing should be typed or searched";
    questions.text_span = choice(QUESTIONS.text_span.instructions, c);
  }
  if (urlCandidates.length) {
    const c = Object.fromEntries(urlCandidates.map((s) => [s, null]));
    c.none = "No web address is mentioned";
    questions.url_span = choice(QUESTIONS.url_span.instructions, c);
  }

  return { state, questions, candidates: { text: textCandidates, url: urlCandidates } };
}

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const ac = new AbortController();
  const onAbort = () => ac.abort(signal.aborted ? signal.reason : timeout.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  timeout.addEventListener("abort", onAbort, { once: true });
  return ac.signal;
}

/**
 * Low-level System One call. Resolves to { data, requestId, latencyMs }.
 * Retries once on 408/429/5xx or a network error; never on abort.
 */
export async function systemOne({ state, questions, model = MODEL }, { signal, apiKey, timeoutMs = TIMEOUT_MS, maxRetries = 1 } = {}) {
  const key = apiKey ?? (await _getApiKey());
  if (!key) {
    const err = new JevApiError("Missing API key: paste your TypeSafe key in the extension options (or set TYPESAFE_API_KEY for tests).", { status: 401 });
    err.code = "no_api_key";
    throw err;
  }
  const body = JSON.stringify({ state, model, questions });
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    const t0 = performance.now();
    let res;
    try {
      res = await _fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal: combineSignals(signal, timeoutMs),
      });
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw err;
      if (attempt < maxRetries) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 150 * attempt));
        continue;
      }
      throw new JevApiError(`Connection error: ${err?.message || err}`, { status: 0 });
    }
    const requestId = res.headers.get("x-typesafe-request-id");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if ((res.status === 408 || res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        attempt += 1;
        const retryAfter = Number(res.headers.get("retry-after-ms")) || Number(res.headers.get("retry-after")) * 1000 || 150 * attempt;
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 600)));
        continue;
      }
      const msg = res.status === 401 ? "API key rejected (401). Check it in the extension options." : `HTTP ${res.status}: ${text.slice(0, 200)}`;
      throw new JevApiError(msg, { status: res.status, requestId, body: text });
    }
    const data = await res.json();
    return { data, requestId, latencyMs: Math.round(performance.now() - t0) };
  }
}

/**
 * Ask Jev. Resolves to { answers, latencyMs, usage, costUsd, model, requestId, candidates, state }
 * or rejects with an AbortError when `signal` aborts (newer transcript arrived).
 */
export async function decide(input, { signal, apiKey } = {}) {
  const { state, questions, candidates } = buildRequest(input);
  const { data, requestId, latencyMs } = await systemOne({ state, questions, model: MODEL }, { signal, apiKey });
  return {
    answers: data.answers,
    latencyMs,
    usage: data.usage,
    costUsd: costUsd(data.usage),
    model: data.model,
    requestId,
    candidates,
    state,
    questionCount: Object.keys(questions).length,
  };
}

/** One cheap Noul call to verify a key works. Resolves to { ok, latencyMs, model, error }. */
export async function testConnection({ apiKey } = {}) {
  try {
    const { data, latencyMs } = await systemOne(
      { state: { transcript: "go to wikipedia" }, questions: { is_command: noul("Is `transcript` an instruction addressed to a web browser?") } },
      { apiKey, maxRetries: 0 },
    );
    return { ok: true, latencyMs, model: data.model, inputTokens: data.usage?.input_tokens ?? null, noul: data.answers?.is_command?.noul ?? null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), status: err?.status ?? null };
  }
}

export function isAbortError(err) {
  return err?.name === "AbortError" || err?.name === "APIUserAbortError";
}
