/**
 * Orchestrator: transcript updates -> (debounce, cancel stale) -> one Jev request ->
 * policy -> action on the active tab -> fresh snapshot. Emits events for the side panel / tests.
 *
 * Port of voice-browser/src/controller.js. Differences:
 *  - no Node imports (tiny Emitter instead of node:events) so it runs in the MV3 service worker
 *  - the `browser` is an adapter over chrome.tabs (see chrome-browser.js); its currentUrl() may be async
 *  - conversation context is kept PER TAB (previous page + last MAX_CONTEXT_ACTIONS actions)
 *  - restore()/persistable() so stats + context survive service-worker suspension (chrome.storage.session)
 */
import { Emitter } from "./emitter.js";
import { DEBOUNCE_MS, SILENCE_COMPLETE_MS, CANDIDATE_TTL_MS, MAX_INFLIGHT, MAX_CONTEXT_ACTIONS, MODEL, T } from "./constants.js";
import { decide, isAbortError } from "./jev.js";
import { evaluatePolicy, describe } from "./policy.js";
import { parseCandidatePick, cleanTranscript } from "./spans.js";
import { approxTokens } from "./snapshot.js";

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const emptyContext = () => ({ previousPage: null, recentActions: [] });

export class Controller extends Emitter {
  /**
   * @param {{browser: object, decideFn?: Function, executeFn?: Function}} opts
   *   browser: { onChange, tabInfo, snapshot, overlay, currentUrl?, contextKey? }
   *   decideFn / executeFn are injectable for tests (default: real Jev + chrome executor).
   */
  constructor({ browser, decideFn = decide, executeFn }) {
    super();
    if (!executeFn) throw new Error("Controller needs an executeFn (see executor.js)");
    this.browser = browser;
    this._decide = decideFn;
    this._execute = executeFn;
    this.snapshot = null;
    this.snapshotAt = 0;
    this.utterance = null; // { id, physicalId, prefix, gen, text, final, startedAt, updatedAt, actedOn, actedText }
    this.consumed = null; // { id: physical utterance id, prefix: executed text (lowercase), gen }
    this.pending = null; // destructive action awaiting "confirm"
    this.candidates = null; // { list: [{n,id,label}], intent: {type,text}, at }
    this.lastDecision = null;
    this.debounceTimer = null;
    this.silenceTimer = null;
    this.inflight = []; // [{ac, text, at}] requests currently awaiting Jev
    this.busy = false;
    this.log = [];
    this.stats = { calls: 0, inputTokens: 0, costUsd: 0, latencies: [], actions: 0, model: MODEL, commandToActionMs: [], decisionMs: [] };
    this.history = [];
    // Conversation context sent to Jev with every request (see jev.encodeContext), one per tab:
    // the page before the last navigation and the last few executed actions.
    this.contexts = new Map();
    browser.onChange((info) => {
      this.emit("tabs", browser.tabInfo());
      // The user switched tabs / the active page navigated: the snapshot is stale.
      if (info?.activeChanged || info?.navigated) this.snapshotAt = 0;
    });
  }

  /** Context for the tab currently being controlled. */
  get context() {
    const key = this.browser.contextKey?.() ?? "default";
    if (!this.contexts.has(key)) this.contexts.set(key, emptyContext());
    return this.contexts.get(key);
  }

  async start() {
    await this.refreshSnapshot();
    this._log("info", `ready — model ${MODEL}, ${this.snapshot.elements.length} elements on ${this.snapshot.url}`);
  }

  _log(level, msg, extra = {}) {
    const entry = { t: Date.now(), level, msg, ...extra };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    this.emit("log", entry);
  }

  async refreshSnapshot() {
    const prev = this.snapshot;
    this.snapshot = await this.browser.snapshot();
    this.snapshotAt = Date.now();
    if (this.snapshot.restricted && (!prev || !prev.restricted || prev.url !== this.snapshot.url)) {
      this._log("warn", `can't control this page (${this.snapshot.url}) — navigation and tab commands still work`);
    }
    this.emit("snapshot", this.snapshot);
    return this.snapshot;
  }

  /** Typed command fallback: behaves like a final utterance. */
  handleCommand(text) {
    return this.handleTranscript({ text, final: true, utteranceId: `typed-${Date.now()}` });
  }

  /**
   * Called on every partial transcript from the mic (or the e2e replay).
   * @param {{text: string, final?: boolean, utteranceId: string|number}} msg
   */
  handleTranscript({ text, final = false, utteranceId }) {
    let clean = cleanTranscript(text);
    const now = Date.now();

    // One action per utterance — but if the user keeps talking in the same breath
    // ("go to wikipedia ... search for alan turing"), the words after the already-executed
    // command become a fresh virtual utterance (id "<physical>+<n>"). Fewer than two new words
    // ("please") are ignored.
    const consumed = this.consumed;
    let virtualId = utteranceId;
    if (consumed && consumed.id === utteranceId) {
      if (!clean.toLowerCase().startsWith(consumed.prefix)) return; // recognizer revised the executed words; ignore
      clean = clean.slice(consumed.prefix.length).trim();
      if (clean.split(/\s+/).filter(Boolean).length < 2) return;
      virtualId = `${utteranceId}+${consumed.gen}`;
    }

    if (!this.utterance || this.utterance.id !== virtualId) {
      this.utterance = {
        id: virtualId,
        physicalId: utteranceId,
        prefix: consumed && consumed.id === utteranceId ? consumed.prefix : "",
        gen: consumed && consumed.id === utteranceId ? consumed.gen : 0,
        text: clean,
        final,
        startedAt: now,
        updatedAt: now,
        actedOn: false,
        actedText: null,
      };
      if (virtualId !== utteranceId) this._log("debug", `continuing utterance → new command "${clean}"`);
    } else {
      if (clean === this.utterance.text && final === this.utterance.final) return;
      this.utterance.text = clean;
      this.utterance.final = final || this.utterance.final;
      this.utterance.updatedAt = now;
    }
    this.emit("transcript", { text: clean, final, utteranceId: virtualId, actedOn: this.utterance.actedOn });
    if (!clean || this.utterance.actedOn) return;

    // Deterministic shortcut: numbered candidate overlays + a spoken number => no Jev needed.
    if (this.candidates && now - this.candidates.at < CANDIDATE_TTL_MS) {
      const n = parseCandidatePick(clean, this.candidates.list.length);
      if (n) {
        const c = this.candidates.list[n - 1];
        this._consume(this.utterance, clean);
        this._log("info", `picked candidate ${n} (${c.label}) by number — no model call`);
        const action = { ...this.candidates.intent, targetId: c.id, label: c.label };
        this.candidates = null;
        this._runAction(action, { via: "candidate-pick" });
        return;
      }
    }

    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    this.debounceTimer = setTimeout(() => this.decideNow("debounce"), final ? 0 : DEBOUNCE_MS);
  }

  /** Mark `text` of this utterance as executed so later words in the same breath start a new command. */
  _consume(utt, text) {
    utt.actedOn = true;
    utt.actedText = text;
    this.consumed = {
      id: utt.physicalId,
      prefix: `${utt.prefix} ${text}`.trim().toLowerCase(),
      gen: (utt.gen || 0) + 1,
    };
  }

  /** Ask Jev about the current utterance. Cancels any in-flight request. */
  async decideNow(trigger = "manual") {
    const utt = this.utterance;
    if (!utt || !utt.text || utt.actedOn) return;
    if (this.busy) {
      // An action is executing; re-evaluate once it finishes.
      this.silenceTimer = setTimeout(() => this.decideNow("after-action"), 150);
      return;
    }
    // Allow up to MAX_INFLIGHT overlapping requests (a request for the previous partial may
    // still be useful — if the words already commit to an action we act on it). Anything older
    // is stale and gets cancelled via AbortSignal.
    if (Date.now() - this.snapshotAt > 1500) await this.refreshSnapshot().catch((err) => this._log("warn", `snapshot failed: ${err.message || err}`));
    if (this.utterance !== utt || utt.actedOn) return; // the world moved on while we re-scanned

    while (this.inflight.length >= MAX_INFLIGHT) {
      const old = this.inflight.shift();
      old.ac.abort();
    }
    const ac = new AbortController();
    const req = { ac, text: utt.text, at: Date.now() };
    this.inflight.push(req);

    const textAtRequest = utt.text;
    const context = this.context;
    let result;
    try {
      result = await this._decide(
        {
          transcript: textAtRequest,
          snapshot: this.snapshot,
          pendingConfirmation: this.pending ? describe(this.pending) : null,
          tabs: this.browser.tabInfo(),
          context,
        },
        { signal: ac.signal },
      );
    } catch (err) {
      this.inflight = this.inflight.filter((r) => r !== req);
      if (isAbortError(err) || ac.signal.aborted) {
        this._log("debug", `cancelled stale request for "${textAtRequest}"`);
        return;
      }
      this._log("error", `Jev error: ${err.message || err}`);
      this.emit("error", { message: err.message || String(err), code: err.code || null, status: err.status ?? null });
      return;
    }
    this.inflight = this.inflight.filter((r) => r !== req);
    if (ac.signal.aborted || this.utterance !== utt || utt.actedOn) return;

    this.stats.calls += 1;
    this.stats.inputTokens += result.usage?.input_tokens ?? 0;
    this.stats.costUsd += result.costUsd;
    this.stats.latencies.push(result.latencyMs);
    if (this.stats.latencies.length > 200) this.stats.latencies.shift();
    if (result.model && result.model !== this.stats.model) this.stats.model = result.model;

    // If more words arrived while this request was in flight, its transcript is a prefix of the
    // real one: it may still act on closed-set intents (the words already commit to "go back"),
    // but it must never be treated as final/silent — free-text payloads would be truncated.
    const stale = utt.text !== textAtRequest;
    const silentMs = stale ? 0 : Date.now() - utt.updatedAt;
    const policy = evaluatePolicy({
      answers: result.answers,
      candidates: result.candidates,
      snapshot: this.snapshot,
      silentMs,
      isFinal: utt.final && !stale,
      pending: this.pending,
      context,
    });

    const decision = {
      transcript: textAtRequest,
      trigger,
      decisionLagMs: Math.max(0, Date.now() - utt.updatedAt), // last spoken word -> decision available
      answers: result.answers,
      candidates: result.candidates,
      latencyMs: result.latencyMs,
      usage: result.usage,
      costUsd: result.costUsd,
      model: result.model,
      requestId: result.requestId,
      questionCount: result.questionCount,
      stateTokens: approxTokens(result.state),
      policy,
      silentMs,
      thresholds: T,
      at: Date.now(),
    };
    this.lastDecision = decision;
    this.emit("decision", decision);
    this._log(
      policy.decision === "act" ? "act" : "info",
      `${result.latencyMs}ms · "${textAtRequest}" → ${policy.decision}: ${policy.summary}`,
    );
    // Once the utterance is final (or has been silent past SILENCE_COMPLETE_MS) the completeness
    // gates were already bypassed: asking again with the same words gives the same answer. Only new
    // words (or a spoken candidate number) can change a wait / disambiguate outcome.
    const exhausted = (utt.final && !stale) || silentMs >= SILENCE_COMPLETE_MS;

    switch (policy.decision) {
      case "act":
        this._consume(utt, textAtRequest);
        if (policy.action.confirmed) this.pending = null;
        this.candidates = null;
        await this._runAction(policy.action, { decision, utterance: utt });
        break;
      case "confirm":
        this._consume(utt, textAtRequest);
        this.pending = policy.action;
        await this.browser.overlay("toast", `Say "confirm" to ${describe(policy.action)}`, 6000);
        this.emit("pending", { action: policy.action, summary: policy.summary });
        break;
      case "cancel":
        this._consume(utt, textAtRequest);
        this.pending = null;
        await this.browser.overlay("toast", "cancelled");
        this.emit("pending", null);
        break;
      case "disambiguate": {
        const list = policy.candidates.map((c, i) => ({ n: i + 1, id: c.id, label: c.label, p: c.p }));
        this.candidates = { list, intent: policy.pendingIntent, at: Date.now() };
        await this.browser.overlay("candidates", list, CANDIDATE_TTL_MS);
        await this.browser.overlay("toast", "Which one? Say the number.", 3000);
        this.emit("candidates", list);
        if (!exhausted) this._scheduleSilenceRetry(utt);
        break;
      }
      case "wait":
        if (!exhausted || policy.retryInMs) this._scheduleSilenceRetry(utt, policy.retryInMs);
        break;
      default:
        break;
    }
  }

  /** If the user stops talking, re-evaluate with silentMs so `complete` is bypassed. */
  _scheduleSilenceRetry(utt, retryInMs = null) {
    clearTimeout(this.silenceTimer);
    const waitFor = retryInMs ?? Math.max(50, SILENCE_COMPLETE_MS - (Date.now() - utt.updatedAt));
    this.silenceTimer = setTimeout(() => {
      if (this.utterance === utt && !utt.actedOn) this.decideNow("silence");
    }, waitFor);
  }

  async _runAction(action, meta = {}) {
    this.busy = true;
    const t0 = Date.now();
    const utt = meta.utterance || this.utterance;
    const pageBefore = this.snapshot ? { url: this.snapshot.url, title: this.snapshot.title, site: this.snapshot.site } : null;
    const context = this.context; // the tab we are acting on, resolved before the action may switch tabs
    try {
      const res = await this._execute(action, this.browser);
      const took = Date.now() - t0;
      const sinceLastWord = utt ? Date.now() - utt.updatedAt : null;
      const sinceUtteranceStart = utt ? Date.now() - utt.startedAt : null;
      this.stats.actions += 1;
      if (sinceLastWord != null) this.stats.commandToActionMs.push(sinceLastWord);
      if (meta.decision?.decisionLagMs != null) this.stats.decisionMs.push(meta.decision.decisionLagMs);
      this.history.push({ action, at: Date.now(), url: res.detail });
      if (this.history.length > 50) this.history.shift();
      await this._recordContext({ action, ok: res.ok, detail: res.detail, said: meta.decision?.transcript || utt?.actedText || "", pageBefore, context });
      const decisionMs = meta.decision?.decisionLagMs ?? null;
      const entry = {
        action,
        ok: res.ok,
        detail: res.detail,
        executeMs: took,
        decisionMs, // last word -> decision
        sinceLastWordMs: sinceLastWord, // last word -> action finished (includes page load)
        sinceUtteranceStartMs: sinceUtteranceStart,
        via: meta.via || "jev",
      };
      this._log(res.ok ? "act" : "warn", `${res.ok ? "✓" : "✗"} ${describe(action)} — decided ${decisionMs ?? "?"}ms after last word, executed in ${took}ms ${res.detail || ""}`);
      this.emit("action", entry);
    } catch (err) {
      this._log("error", `action failed: ${describe(action)} — ${err.message || err}`);
      this.emit("action", { action, ok: false, detail: String(err.message || err), via: meta.via || "jev" });
    } finally {
      this.busy = false;
      await this.refreshSnapshot().catch(() => {});
    }
  }

  /**
   * Remember what was just done so the next Jev request can resolve "back to the results",
   * "the other one", "not that one". Called after every executed action; `outcome` is derived
   * from the post-action URL of the controlled tab.
   */
  async _recordContext({ action, ok, detail, said, pageBefore, context = this.context }) {
    let after = null;
    try {
      after = (await this.browser.currentUrl?.()) ?? null;
    } catch {
      after = null;
    }
    const navigated = pageBefore && after && after !== pageBefore.url;
    if (navigated) context.previousPage = pageBefore;
    let outcome = ok ? "done" : "failed";
    if (ok && navigated) outcome = `navigated to ${after.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80)}`;
    else if (ok && typeof detail === "string" && detail && !detail.startsWith("http")) outcome = detail.slice(0, 80);
    context.recentActions.push({
      type: action.type,
      targetId: action.targetId ?? null,
      targetLabel: action.label ?? null,
      text: action.text ?? null,
      url: action.url ?? null,
      said,
      ok,
      outcome,
      at: Date.now(),
    });
    if (context.recentActions.length > MAX_CONTEXT_ACTIONS) context.recentActions.shift();
    this.emit("context", { key: this.browser.contextKey?.() ?? "default", context });
  }

  /** "Undo" = go back in history. */
  async undo() {
    await this._runAction({ type: "go_back", label: "undo (back)" }, { via: "undo" });
  }

  /** The small bits worth surviving a service-worker restart. */
  persistable() {
    return {
      stats: this.stats,
      contexts: Object.fromEntries(this.contexts),
      history: this.history.slice(-20),
      log: this.log.slice(-60),
    };
  }

  restore(saved) {
    if (!saved) return;
    if (saved.stats) this.stats = { ...this.stats, ...saved.stats, latencies: saved.stats.latencies || [], commandToActionMs: saved.stats.commandToActionMs || [], decisionMs: saved.stats.decisionMs || [] };
    if (saved.contexts) for (const [k, v] of Object.entries(saved.contexts)) this.contexts.set(k, { previousPage: v.previousPage ?? null, recentActions: v.recentActions ?? [] });
    if (Array.isArray(saved.history)) this.history = saved.history;
    if (Array.isArray(saved.log)) this.log = saved.log;
  }

  uiState() {
    const lat = this.stats.latencies;
    const sorted = [...lat].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return {
      model: this.stats.model,
      thresholds: T,
      stats: {
        calls: this.stats.calls,
        actions: this.stats.actions,
        inputTokens: this.stats.inputTokens,
        costUsd: this.stats.costUsd,
        lastLatencyMs: lat[lat.length - 1] ?? null,
        p50LatencyMs: p50,
        avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        avgCommandToActionMs: avg(this.stats.commandToActionMs),
        avgDecisionMs: avg(this.stats.decisionMs),
      },
      snapshot: this.snapshot && {
        url: this.snapshot.url,
        title: this.snapshot.title,
        site: this.snapshot.site,
        searchBoxId: this.snapshot.searchBoxId,
        elements: this.snapshot.elements,
        tabs: this.snapshot.tabs,
        restricted: Boolean(this.snapshot.restricted),
        error: this.snapshot.error || null,
      },
      lastDecision: this.lastDecision,
      context: this.context,
      pending: this.pending ? { summary: describe(this.pending) } : null,
      candidates: this.candidates?.list ?? null,
      log: this.log.slice(-60),
    };
  }

  async close() {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    for (const r of this.inflight) r.ac.abort();
    this.inflight = [];
  }
}
