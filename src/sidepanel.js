/**
 * Side panel: microphone (Web Speech API), live transcript, gate table, probability bars, action
 * log, stats, typed-command fallback. Talks to the service worker over a long-lived port using the
 * same message types the old control page sent over WebSocket (protocol.js).
 */
import { MSG, PORT_NAME } from "./protocol.js";

(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (x, d = 2) => (x == null ? "–" : Number(x).toFixed(d));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let port = null;
  let ui = null;
  let hotIds = new Set();
  let candIds = new Set();
  let keepAlive = null;

  // ------------------------------------------------------------ service worker port
  function connect() {
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch (err) {
      $("ws").textContent = "no service worker";
      setTimeout(connect, 1000);
      return;
    }
    $("ws").textContent = "connected";
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      $("ws").textContent = "reconnecting…";
      clearInterval(keepAlive);
      setTimeout(connect, 500);
    });
    // Tell the worker which window this panel belongs to, so it controls this window's active tab.
    chrome.windows.getCurrent().then((w) => send({ type: MSG.SET_WINDOW, windowId: w.id })).catch(() => {});
    // Any message resets the worker's idle timer; keep it warm while the panel is open.
    clearInterval(keepAlive);
    keepAlive = setInterval(() => send({ type: MSG.PING }), 20000);
  }
  const send = (obj) => {
    try {
      port?.postMessage(obj);
    } catch {
      /* port gone; reconnect handler takes over */
    }
  };

  function onMessage({ type, payload }) {
    switch (type) {
      case MSG.HELLO:
        ui = payload;
        renderAll();
        break;
      case MSG.TRANSCRIPT:
        renderTranscript(payload);
        break;
      case MSG.DECISION:
        renderDecision(payload);
        break;
      case MSG.ACTION:
        ui = { ...ui, ...payload.ui };
        renderStats();
        renderSnapshot();
        break;
      case MSG.SNAPSHOT:
        if (ui) ui.snapshot = payload;
        renderSnapshot();
        break;
      case MSG.LOG:
        appendLog(payload);
        break;
      case MSG.CANDIDATES:
        candIds = new Set((payload || []).map((c) => c.id));
        renderSnapshot();
        break;
      case MSG.PENDING:
        $("pending").textContent = payload ? `⚠ pending: ${payload.summary} — say "confirm" or "cancel"` : "";
        break;
      case MSG.TABS:
        $("tabs").textContent = `${payload.length} tab${payload.length === 1 ? "" : "s"}`;
        break;
      case MSG.ERROR:
        if (payload?.code === "no_api_key" || payload?.status === 401) {
          $("apikey").className = "pill warn";
          $("apikey").innerHTML = `key: <b>${payload.status === 401 ? "rejected" : "missing"}</b> → <a href="options.html" target="_blank">options</a>`;
        }
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ render
  function renderAll() {
    if (!ui) return;
    $("model").textContent = ui.model;
    renderStats();
    renderSnapshot();
    renderApiKey(ui.apiKey);
    $("log").innerHTML = "";
    (ui.log || []).forEach(appendLog);
    if (ui.lastDecision) renderDecision(ui.lastDecision);
    $("pending").textContent = ui.pending ? `⚠ pending: ${ui.pending.summary} — say "confirm" or "cancel"` : "";
    candIds = new Set((ui.candidates || []).map((c) => c.id));
  }
  function renderApiKey(k) {
    const el = $("apikey");
    if (!k) return;
    if (k.hasKey) {
      el.className = "pill ok";
      el.innerHTML = `key <b>${esc(k.masked)}</b>`;
    } else {
      el.className = "pill warn";
      el.innerHTML = `key: <b>missing</b> → <a href="options.html" target="_blank">options</a>`;
    }
  }
  function renderStats() {
    const s = ui?.stats;
    if (!s) return;
    $("lat").textContent = s.lastLatencyMs ?? "–";
    $("p50").textContent = s.p50LatencyMs ?? "–";
    $("calls").textContent = s.calls;
    $("actions").textContent = s.actions;
    $("cost").textContent = "$" + (s.costUsd || 0).toFixed(6);
    $("c2a").textContent = s.avgCommandToActionMs ?? "–";
    $("c2d").textContent = s.avgDecisionMs ?? "–";
    $("model").textContent = ui.model;
  }
  function renderSnapshot() {
    const sn = ui && ui.snapshot;
    if (!sn) return;
    $("url").textContent = sn.url;
    $("title").textContent = sn.title || "–";
    $("site-name").textContent = sn.site;
    $("sbox").textContent = sn.searchBoxId || "none";
    $("elcount").textContent = `${sn.elements.length}`;
    if (sn.tabs) $("tabs").textContent = `${sn.tabs.length} tab${sn.tabs.length === 1 ? "" : "s"}`;
    const r = $("restricted");
    if (sn.restricted && sn.error) {
      r.style.display = "";
      r.textContent = `Can't control this page (${sn.error}). Navigation, back/forward, reload and tab commands still work — say "go to …".`;
    } else r.style.display = "none";
    const rows = sn.elements.map((e) => {
      const cls = hotIds.has(e.id) ? " hot" : candIds.has(e.id) ? " cand" : "";
      return `<div class="el${cls}"><span class="id">${e.id}</span><span class="role">${e.role}${e.below_fold ? " ↓" : ""}</span><span class="txt" title="${esc(e.href || "")}">${esc(e.text || e.placeholder || "")}</span></div>`;
    });
    $("elements").innerHTML = rows.join("");
    const hot = $("elements").querySelector(".hot");
    if (hot) hot.scrollIntoView({ block: "center" });
  }
  function renderTranscript(p) {
    const el = $("transcript");
    el.className = p.actedOn ? "acted" : "";
    el.innerHTML = p.final ? esc(p.text) : `${esc(p.text)} <span class="interim">…</span>`;
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
    $("decmeta").textContent = `${d.latencyMs} ms · ${d.questionCount} q · ${d.usage?.input_tokens ?? "?"} tok · $${(d.costUsd || 0).toFixed(6)} · ${d.trigger}`;
    const v = $("verdict");
    v.className = `verdict ${pol.decision}`;
    v.textContent = `${pol.decision.toUpperCase()} — ${pol.summary}` + (d.silentMs > 500 ? ` (silent ${d.silentMs}ms)` : "");
    $("reasons").querySelector("tbody").innerHTML = (pol.reasons || [])
      .map((r) => `<tr><td>${esc(r.name)}</td><td class="${r.pass ? "pass" : "fail"}">${esc(String(r.value))}</td><td>${esc(String(r.threshold))}</td><td class="small">${esc(r.note || "")}</td></tr>`)
      .join("");

    $("intentconf").textContent = `confidence ${fmt(a.intent?.confidence)}`;
    bars($("intent"), a.intent?.probabilities, a.intent?.choice);

    const labels = {};
    (ui?.snapshot?.elements || []).forEach((e) => (labels[e.id] = `${e.id} ${e.text || e.placeholder || e.role}`));
    labels.none = "none";
    $("targetconf").textContent = `(confidence ${fmt(a.target?.confidence)})`;
    bars($("target"), a.target?.probabilities, a.target?.choice, { labels, max: 6 });
    hotIds = new Set(
      Object.entries(a.target?.probabilities || {})
        .filter(([k, p]) => k !== "none" && p >= 0.15)
        .map(([k]) => k),
    );
    renderSnapshot();

    const nouls = { is_command: a.is_command?.noul, complete: a.complete?.noul, destructive: a.destructive?.noul };
    if (a.is_correction) nouls.is_correction = a.is_correction.noul;
    $("nouls").innerHTML = Object.entries(nouls)
      .map(([k, p]) => `<div class="bar"><span class="lbl">${k}</span><div class="track"><div class="fill noul" style="width:${Math.round((p || 0) * 100)}%"></div></div><span class="num">${fmt(p)}</span></div>`)
      .join("");

    if (a.scroll_amount) bars($("scroll"), a.scroll_amount.probabilities, String(Math.round(a.scroll_amount.score)), { labels: { 0: "a little", 1: "one page", 2: "to the end" } });
    bars($("site"), a.site?.probabilities, a.site?.choice, { max: 5 });

    let spans = "";
    if (a.text_span) spans += `<div class="small">text_span</div>` + barsHtml(a.text_span.probabilities, a.text_span.choice);
    if (a.url_span) spans += `<div class="small">url_span</div>` + barsHtml(a.url_span.probabilities, a.url_span.choice);
    $("spans").innerHTML = spans || `<div class="small">no text/url candidates in transcript</div>`;
  }
  function appendLog(e) {
    const div = document.createElement("div");
    div.className = e.level;
    const t = new Date(e.t).toLocaleTimeString([], { hour12: false });
    div.textContent = `${t} ${e.msg}`;
    const log = $("log");
    log.appendChild(div);
    while (log.children.length > 150) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  // ------------------------------------------------------------ controls
  $("cmdform").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = $("cmd").value.trim();
    if (!text) return;
    send({ type: MSG.COMMAND, text });
    renderTranscript({ text, final: true, actedOn: false });
    $("cmd").value = "";
  });
  $("undo").onclick = () => send({ type: MSG.UNDO });
  $("resnap").onclick = () => send({ type: MSG.SNAPSHOT });
  $("optlink").onclick = (ev) => {
    ev.preventDefault();
    chrome.runtime.openOptionsPage();
  };

  // ------------------------------------------------------------ speech
  // Side panels cannot show the microphone permission prompt (getUserMedia fails with
  // "Permission dismissed"). The first time, permission.html is opened in a tab, where Chrome
  // shows the prompt; the grant is per extension origin, so afterwards the side panel can listen.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let micOn = false;
  let utteranceBase = 0;
  let permPoll = null;

  async function micPermissionState() {
    try {
      const st = await navigator.permissions.query({ name: "microphone" });
      return st.state; // granted | prompt | denied
    } catch {
      return "prompt";
    }
  }

  async function ensureMicPermission() {
    const state = await micPermissionState();
    if (state === "granted") return true;
    if (state === "prompt") {
      // Some Chrome versions do show the prompt inside the panel; try once, cheaply.
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        return true;
      } catch (err) {
        if (err?.name !== "NotAllowedError" && err?.name !== "SecurityError") {
          $("micstate").textContent = `mic error: ${err?.name || err}`;
          return false;
        }
      }
    }
    // Open the permission page in a tab and auto-start once the grant lands.
    $("micstate").textContent = state === "denied" ? "mic blocked — allow it in the tab that just opened" : "allow the mic in the tab that just opened…";
    chrome.tabs.create({ url: chrome.runtime.getURL(`permission.html?reason=${encodeURIComponent(state)}`) });
    clearInterval(permPoll);
    let tries = 0;
    permPoll = setInterval(async () => {
      tries += 1;
      if ((await micPermissionState()) === "granted") {
        clearInterval(permPoll);
        startMic();
      } else if (tries > 180) clearInterval(permPoll); // give up after 3 minutes
    }, 1000);
    return false;
  }

  async function startMic() {
    if (!SR) {
      $("micstate").textContent = "Web Speech API not available — type commands below";
      return;
    }
    if (micOn) return;
    if (!(await ensureMicPermission())) return;
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => {
      // Results before ev.resultIndex are finished. Each result index is a distinct utterance.
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        send({ type: MSG.TRANSCRIPT, text: r[0].transcript, final: r.isFinal, utteranceId: `u${utteranceBase}-${i}` });
      }
    };
    rec.onerror = (e) => {
      $("micstate").textContent = "error: " + e.error;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        stopMic();
        ensureMicPermission();
      }
    };
    rec.onend = () => {
      // Chrome ends continuous sessions after ~60 s of silence; restart while the user wants it on.
      if (micOn) {
        utteranceBase += 1;
        try {
          rec.start();
        } catch {}
      }
    };
    try {
      rec.start();
    } catch (err) {
      $("micstate").textContent = `mic error: ${err?.message || err}`;
      return;
    }
    micOn = true;
    $("micdot").classList.add("on");
    $("micstate").textContent = "listening";
    $("micbtn").textContent = "Stop mic";
    $("micbtn").classList.remove("primary");
  }
  function stopMic() {
    micOn = false;
    try {
      rec && rec.stop();
    } catch {}
    $("micdot").classList.remove("on");
    $("micstate").textContent = "off";
    $("micbtn").textContent = "Start mic";
    $("micbtn").classList.add("primary");
  }
  $("micbtn").onclick = () => (micOn ? stopMic() : startMic());

  connect();
})();
