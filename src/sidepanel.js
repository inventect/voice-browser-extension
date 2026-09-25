/**
 * Side panel: the consumer face of the extension.
 *  - big mic button (Web Speech API) with listening state, plain-language status line
 *  - conversation: what you said (bubbles) and what the extension did (cards)
 *  - suggestion chips, typed-command composer, friendly error cards
 *  - a collapsed "Details" section with the developer view (gates, bars, elements, cost, raw speech events)
 * Talks to the service worker over a long-lived port using protocol.js message types.
 */
import { MSG, PORT_NAME } from "./protocol.js";
import { ScribeMic } from "./scribe-mic.js";
import { buildKeyterms } from "./scribe-util.js";

(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (x, d = 2) => (x == null ? "–" : Number(x).toFixed(d));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    ask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><circle cx="12" cy="16.5" r=".6" fill="currentColor"/><path d="M10.3 4.3 3.6 16.2A2 2 0 0 0 5.3 19h13.4a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor"/></svg>',
  };

  let port = null;
  let ui = null;
  let hotIds = new Set();
  let candIds = new Set();
  let keepAlive = null;
  const convo = []; // [{ id, role: "user"|"app", text, kind, meta, interim, actions }]
  const MAX_CONVO = 6;

  // ------------------------------------------------------------ service worker port
  function connect() {
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      setConn("warn", "no worker");
      setTimeout(connect, 1000);
      return;
    }
    setConn("ok", "ready");
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      setConn("warn", "reconnecting");
      clearInterval(keepAlive);
      setTimeout(connect, 500);
    });
    chrome.windows.getCurrent().then((w) => send({ type: MSG.SET_WINDOW, windowId: w.id })).catch(() => {});
    clearInterval(keepAlive);
    keepAlive = setInterval(() => send({ type: MSG.PING }), 20000);
  }
  const send = (obj) => {
    try {
      port?.postMessage(obj);
    } catch {}
  };
  function setConn(state, text) {
    $("conn").className = `pill ${state}`;
    $("conntext").textContent = text;
  }

  function onMessage({ type, payload }) {
    switch (type) {
      case MSG.HELLO:
        ui = payload;
        renderAll();
        pushKeyterms();
        break;
      case MSG.TRANSCRIPT:
        onTranscript(payload);
        break;
      case MSG.DECISION:
        onDecision(payload);
        break;
      case MSG.ACTION:
        ui = { ...ui, ...payload.ui };
        onAction(payload);
        renderStats();
        renderPage();
        pushKeyterms();
        break;
      case MSG.SNAPSHOT:
        if (ui) ui.snapshot = payload;
        renderPage();
        renderAlerts();
        pushKeyterms();
        break;
      case MSG.LOG:
        appendLog(payload);
        break;
      case MSG.CANDIDATES:
        candIds = new Set((payload || []).map((c) => c.id));
        onCandidates(payload);
        renderElements();
        break;
      case MSG.PENDING:
        onPending(payload);
        break;
      case MSG.TABS:
        $("tabs").textContent = `${payload.length}`;
        break;
      case MSG.ERROR:
        onError(payload);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ plain-language helpers
  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };
  const q = (s) => `“${s}”`;
  /** Friendly past-tense description of an executed action. */
  function friendly(entry) {
    const a = entry.action || {};
    const label = (a.label || "").replace(/^(link|button|textbox|searchbox|combobox|select|clickable)\s+"(.*)"$/, "$2");
    switch (a.type) {
      case "navigate_url":
        return a.query ? `Searched for ${q(a.query)}` : `Opened ${hostOf(a.url || a.label)}`;
      case "click_element":
        return a.via === "close_popup" ? `Dismissed the pop-up (${label || "close"})` : `Clicked ${q(label || "the element")}`;
      case "type_into_field":
        return a.text ? `Typed ${q(a.text)}${a.submit ? " and pressed Enter" : ""}` : `Cleared ${label || "the field"}`;
      case "select_option":
        return `Selected ${q(a.text)}`;
      case "press_enter":
        return "Pressed Enter";
      case "scroll_down":
        return a.amount === "end" ? "Scrolled to the bottom" : a.amount === "little" ? "Scrolled down a little" : "Scrolled down";
      case "scroll_up":
        return a.amount === "end" ? "Scrolled to the top" : a.amount === "little" ? "Scrolled up a little" : "Scrolled up";
      case "go_back":
        return entry.via === "undo" ? "Went back (undo)" : "Went back";
      case "go_forward":
        return "Went forward";
      case "reload":
        return "Reloaded the page";
      case "open_new_tab":
        return "Opened a new tab";
      case "close_tab":
        return "Closed the tab";
      case "switch_tab":
        return "Switched tab";
      default:
        return a.label || a.type || "Done";
    }
  }
  function setStatus(text, sub = "", cls = "") {
    const s = $("status");
    s.textContent = text;
    s.className = `status ${cls}`;
    $("substatus").textContent = sub;
  }

  // ------------------------------------------------------------ conversation
  function upsert(item) {
    const i = convo.findIndex((c) => c.id === item.id);
    if (i >= 0) convo[i] = { ...convo[i], ...item };
    else convo.push(item);
    while (convo.length > MAX_CONVO) convo.shift();
    renderConvo();
  }
  function renderConvo() {
    const el = $("convo");
    el.innerHTML = convo
      .map((c) => {
        if (c.role === "user") return `<div class="bubble user${c.interim ? " interim" : ""}"><span${c.interim ? ' class="ellipsis"' : ""}>${esc(c.text)}</span></div>`;
        const icon = ICON[c.kind === "act" ? "check" : c.kind === "ask" ? "ask" : c.kind === "warn" ? "warn" : "info"];
        const actions = (c.actions || []).map((a) => `<button class="btn sm${a.primary ? " primary" : ""} numbtn" data-say="${esc(a.say)}">${esc(a.label)}</button>`).join("");
        return `<div class="bubble app ${c.kind}"><span class="ic">${icon}</span><div class="txt">${c.html || esc(c.text)}${c.meta ? `<span class="meta">${esc(c.meta)}</span>` : ""}${actions ? `<div class="row">${actions}</div>` : ""}</div></div>`;
      })
      .join("");
    el.querySelectorAll("[data-say]").forEach((b) => (b.onclick = () => say(b.dataset.say)));
    $("empty").style.display = convo.length ? "none" : "";
    document.body.classList.toggle("active", convo.length > 0);
    // keep the newest card in view (the composer is sticky, so it stays reachable)
    const last = el.lastElementChild;
    if (last && !$("details").open) requestAnimationFrame(() => last.scrollIntoView({ block: "nearest" }));
  }
  function say(text) {
    // Typed commands are final utterances; the panel picks the id so the worker's echo lands in the same bubble.
    const id = `typed-${Date.now()}`;
    send({ type: MSG.TRANSCRIPT, text, final: true, utteranceId: id });
    upsert({ id: `u-${id}`, role: "user", text, interim: false });
    setStatus(`Heard: ${q(text)}`, "thinking…");
  }

  function onTranscript(p) {
    if (p.duplicate) {
      speechLog(`↩ duplicate ignored: “${p.text}”`);
      return;
    }
    if (!p.text) return;
    const id = String(p.utteranceId).split("+")[0];
    upsert({ id: `u-${id}`, role: "user", text: p.text, interim: !p.final && !p.actedOn });
    if (!p.actedOn) setStatus(`Heard: ${q(p.text)}`, p.final ? "thinking…" : "listening…");
  }
  function onDecision(d) {
    renderDecision(d);
    const pol = d.policy || {};
    if (pol.decision === "wait") $("substatus").textContent = pol.summary?.startsWith("waiting") ? "waiting for the rest…" : pol.summary || "thinking…";
    else if (pol.decision === "ignore" && !pol.repeated) {
      $("substatus").textContent = "that didn’t sound like a command";
    } else if (pol.decision === "ignore" && pol.repeated) {
      upsert({ id: `d-${d.at}`, role: "app", kind: "info", text: "Already did that a moment ago — say “again” to repeat.", meta: "" });
      setStatus("Heard you twice", "say “again” if you meant it");
    }
  }
  function onAction(entry) {
    const text = friendly(entry);
    const took = entry.sinceLastWordMs != null ? `${(entry.sinceLastWordMs / 1000).toFixed(1)} s after your last word` : entry.executeMs != null ? `${entry.executeMs} ms` : "";
    if (entry.ok) {
      upsert({ id: `a-${Date.now()}`, role: "app", kind: "act", text, meta: took });
      setStatus(`Did: ${text}`, micOn ? "listening…" : "", "acted");
    } else {
      upsert({ id: `a-${Date.now()}`, role: "app", kind: "warn", text: `Couldn’t do that: ${entry.detail || "unknown error"}`, meta: "" });
      setStatus("That didn’t work", entry.detail || "");
    }
  }
  function onCandidates(list) {
    if (!list?.length) return;
    const actions = list.map((c, i) => ({ say: ["one", "two", "three", "four", "five"][i] || String(i + 1), label: `${i + 1} · ${c.label.replace(/^\w+\s+"(.*)"$/, "$1")}` }));
    upsert({ id: `c-${Date.now()}`, role: "app", kind: "ask", text: "Which one? Say the number.", actions });
    setStatus("Which one?", "say the number, or tap it");
  }
  function onPending(p) {
    if (!p) return;
    upsert({
      id: `p-${Date.now()}`,
      role: "app",
      kind: "warn",
      html: `This looks irreversible: <b>${esc(p.summary.replace(/^say "confirm" to /, ""))}</b>. Say “confirm” or “cancel”.`,
      actions: [
        { say: "confirm", label: "Confirm", primary: true },
        { say: "cancel", label: "Cancel" },
      ],
    });
    setStatus("Are you sure?", "say “confirm” or “cancel”");
  }
  function onError(e) {
    if (e?.code === "no_api_key" || e?.status === 401) {
      if (ui) ui.apiKey = { hasKey: e.status === 401, rejected: e.status === 401 };
      renderAlerts();
      setStatus("Add your API key first", "open Settings to paste it");
    } else if (e?.message) {
      upsert({ id: `e-${Date.now()}`, role: "app", kind: "warn", text: `Something went wrong: ${e.message}` });
    }
  }

  // ------------------------------------------------------------ alerts
  let micDenied = false;
  function renderAlerts() {
    const out = [];
    const k = ui?.apiKey;
    if (k && !k.hasKey) {
      out.push(alert("warn", "Add your TypeSafe API key", "Voice Browser asks TypeSafe’s Jev model what you meant. Paste your key once in Settings — it stays on this device.", [{ id: "openopt", label: "Open settings", primary: true }]));
    } else if (k?.rejected) {
      out.push(alert("warn", "Your API key was rejected", "Check it in Settings and try “Test connection”.", [{ id: "openopt", label: "Open settings", primary: true }]));
    }
    if (micDenied) {
      out.push(
        alert("warn", "Microphone is blocked", "Chrome blocked the microphone for this extension. Open the site settings, set Microphone to Allow, then press the mic again.", [
          { id: "micsettings", label: "Open Chrome settings", primary: true },
          { id: "micpage", label: "Ask again" },
        ]),
      );
    }
    if (sttProblem) {
      const ko = langSel.value === "ko-KR";
      out.push(
        alert(
          "warn",
          ko ? "ElevenLabs 음성 인식을 쓸 수 없어요" : "ElevenLabs speech recognition failed",
          `${sttProblem.message}${ko ? " — 지금은 Chrome 기본 인식기로 들어요. 설정에서 ElevenLabs 키를 확인하세요." : " — using Chrome’s recogniser instead. Check the ElevenLabs key in Settings."}`,
          [{ id: "openopt", label: "Open settings", primary: true }],
        ),
      );
    }
    const sn = ui?.snapshot;
    if (sn?.popup) {
      const kind = sn.popup.kind === "banner" ? "A banner" : "A pop-up";
      out.push(alert("info", `${kind} is covering the page`, `${sn.popup.text ? q(sn.popup.text.slice(0, 90)) + " — " : ""}say “close this”, “accept cookies” or “not now”.`, []));
    }
    if (sn?.restricted && sn.error && !sn.blank) {
      out.push(alert("info", "This page can’t be controlled", "Chrome doesn’t let extensions see this page. Navigation, back, reload and tab commands still work — say “go to …”.", []));
    }
    $("alerts").innerHTML = out.join("");
    const bind = (id, fn) => $("alerts").querySelectorAll(`[data-act="${id}"]`).forEach((b) => (b.onclick = fn));
    bind("openopt", () => chrome.runtime.openOptionsPage());
    bind("micsettings", () => chrome.tabs.create({ url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(`chrome-extension://${chrome.runtime.id}`)}` }));
    bind("micpage", () => chrome.tabs.create({ url: chrome.runtime.getURL("permission.html?reason=denied") }));
  }
  function alert(kind, title, body, actions) {
    const btns = actions.map((a) => `<button class="btn sm${a.primary ? " primary" : ""}" data-act="${a.id}">${esc(a.label)}</button>`).join("");
    return `<div class="notice ${kind} rise"><span class="ic">${ICON[kind === "warn" ? "warn" : "info"]}</span><div><b>${esc(title)}</b><p>${esc(body)}</p>${btns ? `<div class="row">${btns}</div>` : ""}</div></div>`;
  }

  // ------------------------------------------------------------ render: details
  function renderAll() {
    if (!ui) return;
    renderStats();
    renderPage();
    renderAlerts();
    $("log").innerHTML = "";
    (ui.log || []).forEach(appendLog);
    if (ui.lastDecision) renderDecision(ui.lastDecision);
    candIds = new Set((ui.candidates || []).map((c) => c.id));
    const k = ui.apiKey;
    $("apikey").textContent = k?.hasKey ? `set (${k.masked})` : "missing";
    if (ui.pending) onPending(ui.pending);
  }
  function renderStats() {
    const s = ui?.stats;
    if (!s) return;
    $("lat").textContent = s.lastLatencyMs ?? "–";
    $("lat2").textContent = s.lastLatencyMs ?? "–";
    $("p50").textContent = s.p50LatencyMs ?? "–";
    $("calls").textContent = s.calls;
    $("actions").textContent = s.actions;
    $("cost").textContent = (s.costUsd || 0).toFixed(4);
    $("cost2").textContent = (s.costUsd || 0).toFixed(6);
    $("tokens").textContent = s.inputTokens ?? 0;
    $("c2a").textContent = s.avgCommandToActionMs ?? "–";
    $("c2d").textContent = s.avgDecisionMs ?? "–";
    $("model").textContent = ui.model;
  }
  function renderPage() {
    const sn = ui?.snapshot;
    if (!sn) return;
    $("url").textContent = sn.url;
    $("title").textContent = sn.title || "–";
    $("site-name").textContent = sn.site;
    $("sbox").textContent = sn.searchBoxId || "none";
    $("popup").textContent = sn.popup ? `${sn.popup.kind}: ${sn.popup.text?.slice(0, 60) || ""}` : "none";
    if (sn.tabs) $("tabs").textContent = `${sn.tabs.length}`;
    renderElements();
  }
  function renderElements() {
    const sn = ui?.snapshot;
    if (!sn) return;
    $("elcount").textContent = `${sn.elements.length}${sn.restricted ? " (restricted page)" : ""}`;
    $("elements").innerHTML = sn.elements
      .map((e) => {
        const cls = hotIds.has(e.id) ? " hot" : candIds.has(e.id) ? " cand" : "";
        return `<div class="el${cls}"><span class="id">${e.id}</span><span class="role">${e.role}${e.popup ? " ▲" : ""}${e.below_fold ? " ↓" : ""}</span><span class="txt" title="${esc(e.href || "")}">${esc(e.text || e.placeholder || "")}</span></div>`;
      })
      .join("");
    const hot = $("elements").querySelector(".hot");
    if (hot && $("details").open) hot.scrollIntoView({ block: "nearest" });
  }
  function bars(container, probs, winner, opts = {}) {
    const entries = Object.entries(probs || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.max || 6);
    container.innerHTML = entries
      .map(([k, p]) => {
        const win = k === winner;
        const label = opts.labels ? opts.labels[k] || k : k;
        return `<div class="bar"><span class="lbl${win ? " win" : ""}" title="${esc(label)}">${esc(label)}</span><div class="track"><div class="fill${win ? " win" : ""}${opts.noul ? " noul" : ""}" style="width:${Math.round(p * 100)}%"></div></div><span class="num">${fmt(p)}</span></div>`;
      })
      .join("");
  }
  function barsHtml(probs, winner) {
    const tmp = document.createElement("div");
    bars(tmp, probs, winner, { max: 6 });
    return tmp.innerHTML;
  }
  function renderDecision(d) {
    const a = d.answers || {};
    const pol = d.policy || { decision: "wait", summary: "", reasons: [] };
    $("decmeta").textContent = `· ${d.latencyMs} ms · ${d.questionCount} questions · ${d.usage?.input_tokens ?? "?"} tokens · ${d.trigger}`;
    $("reqid").textContent = d.requestId || "–";
    const v = $("verdict");
    v.className = `verdict ${pol.decision}`;
    v.textContent = `${pol.decision.toUpperCase()} — ${pol.summary}` + (d.silentMs > 500 ? ` (silent ${d.silentMs} ms)` : "");
    $("reasons").querySelector("tbody").innerHTML = (pol.reasons || [])
      .map((r) => `<tr><td>${esc(r.name)}</td><td class="${r.pass ? "pass" : "fail"}">${esc(String(r.value))}</td><td>${esc(String(r.threshold))}</td><td class="muted">${esc(r.note || "")}</td></tr>`)
      .join("");
    $("intentconf").textContent = `· confidence ${fmt(a.intent?.confidence)}`;
    bars($("intent"), a.intent?.probabilities, a.intent?.choice);
    const labels = {};
    (ui?.snapshot?.elements || []).forEach((e) => (labels[e.id] = `${e.id} ${e.text || e.placeholder || e.role}`));
    labels.none = "none";
    $("targetconf").textContent = `· confidence ${fmt(a.target?.confidence)}`;
    bars($("target"), a.target?.probabilities, a.target?.choice, { labels, max: 6 });
    hotIds = new Set(
      Object.entries(a.target?.probabilities || {})
        .filter(([k, p]) => k !== "none" && p >= 0.15)
        .map(([k]) => k),
    );
    renderElements();
    const nouls = { is_command: a.is_command?.noul, complete: a.complete?.noul, destructive: a.destructive?.noul };
    if (a.is_correction) nouls.is_correction = a.is_correction.noul;
    $("nouls").innerHTML = Object.entries(nouls)
      .map(([k, p]) => `<div class="bar"><span class="lbl">${k}</span><div class="track"><div class="fill noul" style="width:${Math.round((p || 0) * 100)}%"></div></div><span class="num">${fmt(p)}</span></div>`)
      .join("");
    if (a.scroll_amount) bars($("scroll"), a.scroll_amount.probabilities, String(Math.round(a.scroll_amount.score)), { labels: { 0: "a little", 1: "one page", 2: "to the end" } });
    bars($("site"), a.site?.probabilities, a.site?.choice, { max: 5 });
    let spans = "";
    if (a.text_span) spans += `<div class="small muted">text_span</div>` + barsHtml(a.text_span.probabilities, a.text_span.choice);
    if (a.url_span) spans += `<div class="small muted">url_span</div>` + barsHtml(a.url_span.probabilities, a.url_span.choice);
    $("spans").innerHTML = spans || `<div class="small muted">no text / url candidates in the transcript</div>`;
  }
  function appendLog(e) {
    const div = document.createElement("div");
    div.className = e.level;
    div.textContent = `${new Date(e.t).toLocaleTimeString([], { hour12: false })} ${e.msg}`;
    const log = $("log");
    log.appendChild(div);
    while (log.children.length > 150) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }
  function speechLog(line) {
    const log = $("speechlog");
    if (log.querySelector("span.muted")) log.innerHTML = "";
    const div = document.createElement("div");
    div.textContent = `${new Date().toLocaleTimeString([], { hour12: false })} ${line}`;
    log.appendChild(div);
    while (log.children.length > 60) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  // ------------------------------------------------------------ controls
  $("cmdform").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = $("cmd").value.trim();
    if (!text) return;
    say(text);
    $("cmd").value = "";
  });
  $("chips").querySelectorAll(".chip").forEach((b) => (b.onclick = () => say(b.dataset.say)));
  $("undo").onclick = () => send({ type: MSG.UNDO });
  $("resnap").onclick = () => send({ type: MSG.SNAPSHOT });
  $("settingsbtn").onclick = () => chrome.runtime.openOptionsPage();
  $("brand").onclick = (ev) => ev.preventDefault();

  // ------------------------------------------------------------ speech
  // Side panels cannot show the microphone prompt (getUserMedia fails with "Permission dismissed").
  // The first time, permission.html is opened in a tab where Chrome shows the prompt; the grant is
  // per extension origin, so afterwards the side panel can listen.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let micOn = false;
  let starting = false;
  let utteranceBase = 0;
  let permPoll = null;
  // Local addition: which recogniser is listening ("elevenlabs" | "chrome"), the ElevenLabs
  // session, and an idle guard (ElevenLabs bills the audio time streamed while the mic is on).
  let engine = null;
  let scribe = null;
  let sttProblem = null;
  let lastHeardAt = 0;
  let idleTimer = null;
  const IDLE_STOP_MS = 3 * 60 * 1000;
  // Recognition language (local addition): remembered per browser; switching restarts a running mic.
  const langSel = $("lang");
  langSel.value = localStorage.getItem("vb-lang") || "ko-KR";
  langSel.onchange = () => {
    localStorage.setItem("vb-lang", langSel.value);
    if (micOn) {
      if (rec) rec.onend = null; // the old recognizer must not auto-restart after stop()
      stopMic();
      startMic();
    }
  };
  // Words on the controlled page → ElevenLabs keyterms (applied at the next quiet moment).
  const currentKeyterms = () => buildKeyterms(ui?.snapshot || null, langSel.value);
  function pushKeyterms() {
    if (scribe) scribe.updateKeyterms(currentKeyterms());
  }

  async function micPermissionState() {
    try {
      return (await navigator.permissions.query({ name: "microphone" })).state;
    } catch {
      return "prompt";
    }
  }
  async function ensureMicPermission() {
    const state = await micPermissionState();
    if (state === "granted") return true;
    if (state === "prompt") {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        return true;
      } catch (err) {
        if (err?.name !== "NotAllowedError" && err?.name !== "SecurityError") {
          setStatus("Microphone problem", `${err?.name || err} — you can still type commands`);
          return false;
        }
      }
    }
    if (state === "denied") {
      micDenied = true;
      renderAlerts();
      setStatus("Microphone is blocked", "allow it in Chrome’s settings, then try again");
      return false;
    }
    setStatus("Allow the microphone", "in the tab that just opened — I’ll start listening automatically");
    chrome.tabs.create({ url: chrome.runtime.getURL(`permission.html?reason=${encodeURIComponent(state)}`) });
    clearInterval(permPoll);
    let tries = 0;
    permPoll = setInterval(async () => {
      tries += 1;
      const st = await micPermissionState();
      if (st === "granted") {
        clearInterval(permPoll);
        startMic();
      } else if (st === "denied") {
        clearInterval(permPoll);
        micDenied = true;
        renderAlerts();
        setStatus("Microphone is blocked", "allow it in Chrome’s settings, then try again");
      } else if (tries > 180) clearInterval(permPoll);
    }, 1000);
    return false;
  }

  async function startMic() {
    if (micOn || starting) return;
    starting = true;
    try {
      if (!(await ensureMicPermission())) return;
      micDenied = false;
      renderAlerts();
      let stt = null;
      try {
        stt = await chrome.runtime.sendMessage({ type: MSG.STT_STATUS });
      } catch {}
      if (stt?.resolved === "elevenlabs" && (await startScribe())) return;
      startWebSpeech();
    } finally {
      starting = false;
    }
  }

  function listeningHint() {
    const ex = langSel.value === "ko-KR" ? "예: “위키피디아로 가 줘”, “유튜브 열어 줘”" : "say something like “go to wikipedia”";
    return `${ex} · ${engine === "elevenlabs" ? "ElevenLabs" : "Chrome"}`;
  }
  function setMicUi(on) {
    const b = $("micbtn");
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.setAttribute("aria-label", on ? "Stop listening" : "Start listening");
    const el = $("sttengine");
    if (el) el.textContent = on ? (engine === "elevenlabs" ? "ElevenLabs Scribe v2 Realtime" : "Chrome Web Speech") : "–";
  }

  /** ElevenLabs path (local addition). Resolves false when it could not start → caller falls back. */
  async function startScribe() {
    const s = new ScribeMic({
      getToken: () => chrome.runtime.sendMessage({ type: MSG.STT_TOKEN }),
      workletUrl: chrome.runtime.getURL("scribe-worklet.js"),
      onTranscript: (t) => {
        if (s !== scribe) return;
        lastHeardAt = Date.now();
        speechLog(`${t.final ? "final  " : "interim"} id=${t.utteranceId} “${t.text}” (elevenlabs)`);
        send({ type: MSG.TRANSCRIPT, text: t.text, final: t.final, utteranceId: t.utteranceId });
      },
      onState: (st) =>
        speechLog(
          `elevenlabs ${st.state}${st.reason ? ` (${st.reason})` : ""}${st.connectMs != null ? ` in ${st.connectMs} ms` : ""}${st.keyterms != null ? ` · ${st.keyterms} page words` : ""}${st.audioSeconds != null ? ` · ${st.audioSeconds}s streamed` : ""}`,
        ),
      onError: (e) => {
        speechLog(`elevenlabs error: ${e.code} — ${e.message}`);
        if (!e.fatal) {
          if (s === scribe) $("substatus").textContent = `ElevenLabs: ${e.message}`;
          return;
        }
        sttProblem = e;
        renderAlerts();
        if (s === scribe && micOn) {
          // keep listening with Chrome's recogniser instead
          scribe = null;
          micOn = false;
          clearInterval(idleTimer);
          startWebSpeech();
        }
      },
      onLog: (m) => speechLog(m),
    });
    scribe = s;
    try {
      await s.start({ lang: langSel.value, keyterms: currentKeyterms() });
    } catch (err) {
      speechLog(`elevenlabs start failed: ${err?.name || err} ${err?.message || ""}`);
      if (scribe === s) scribe = null;
      return false;
    }
    if (!s.active || scribe !== s) {
      if (scribe === s) scribe = null;
      return false;
    }
    sttProblem = null;
    renderAlerts();
    engine = "elevenlabs";
    micOn = true;
    lastHeardAt = Date.now();
    clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (engine === "elevenlabs" && micOn && Date.now() - lastHeardAt > IDLE_STOP_MS) {
        stopMic(langSel.value === "ko-KR" ? "3분 동안 말이 없어 마이크를 껐어요 (ElevenLabs 사용 시간 절약)" : "no speech for 3 minutes — mic paused to save ElevenLabs time");
      }
    }, 10000);
    setMicUi(true);
    setStatus("Listening…", listeningHint());
    return true;
  }

  /** Chrome Web Speech path (upstream behaviour). */
  function startWebSpeech() {
    if (!SR) {
      setStatus("Speech recognition isn’t available here", "type commands below instead");
      return;
    }
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = langSel.value;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const id = `u${utteranceBase}-${i}`;
        speechLog(`${r.isFinal ? "final  " : "interim"} idx=${i} id=${id} “${r[0].transcript.trim()}” (${(r[0].confidence || 0).toFixed(2)})`);
        send({ type: MSG.TRANSCRIPT, text: r[0].transcript, final: r.isFinal, utteranceId: id });
      }
    };
    rec.onerror = (e) => {
      speechLog(`error: ${e.error}`);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        stopMic();
        micDenied = true;
        renderAlerts();
        setStatus("Microphone is blocked", "allow it in Chrome’s settings, then try again");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        $("substatus").textContent = `speech error: ${e.error}`;
      }
    };
    rec.onend = () => {
      speechLog("end" + (micOn ? " → restart" : ""));
      if (micOn && engine === "chrome") {
        utteranceBase += 1;
        try {
          rec.start();
        } catch {}
      }
    };
    try {
      rec.start();
    } catch (err) {
      setStatus("Couldn’t start the microphone", err?.message || String(err));
      return;
    }
    engine = "chrome";
    micOn = true;
    setMicUi(true);
    setStatus("Listening…", listeningHint());
  }
  function stopMic(reason) {
    micOn = false;
    clearInterval(idleTimer);
    if (scribe) {
      const s = scribe;
      scribe = null;
      s.stop();
    }
    try {
      rec && rec.stop();
    } catch {}
    engine = null;
    setMicUi(false);
    setStatus("Paused", typeof reason === "string" ? reason : "tap the mic to listen again, or type below");
  }
  $("micbtn").onclick = () => (micOn ? stopMic() : startMic());

  connect();
})();
