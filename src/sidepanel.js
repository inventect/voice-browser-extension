/**
 * Side panel (local redesign after apple.com: one hero control, quiet everything else).
 *  - the mic button controls a microphone that lives in an offscreen document owned by the service
 *    worker, so listening continues when this panel is closed (toolbar badge "ON"; ⌥⇧V toggles it
 *    from anywhere). The panel only mirrors and controls that state.
 *  - headline status, conversation (what you said / what happened), suggestion chips, composer
 *  - Korean or English copy, following the recognition language (segmented control in the bar)
 *  - a collapsed "Details" developer view (gates, bars, elements, cost, raw speech events)
 * Talks to the service worker over a long-lived port using protocol.js message types.
 */
import { MSG, PORT_NAME } from "./protocol.js";

(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (x, d = 2) => (x == null ? "–" : Number(x).toFixed(d));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // SF Symbols-style filled glyphs: checkmark.circle.fill, questionmark.circle.fill,
  // exclamationmark.triangle.fill, info.circle.fill (inner marks use .cut / .cutf = white).
  const ICON = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path class="cut" d="M7.6 12.3l3 3.1 5.8-6.3" fill="none" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ask: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path class="cut" d="M9.7 9.7a2.4 2.4 0 1 1 3.4 2.2c-.7.3-1.1.8-1.1 1.5v.2" fill="none" stroke-width="2" stroke-linecap="round"/><circle class="cutf" cx="12" cy="16.8" r="1.15"/></svg>',
    warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.27 3.5a2 2 0 0 1 3.46 0l8.05 14a2 2 0 0 1-1.73 3H3.95a2 2 0 0 1-1.73-3z" fill="currentColor"/><path class="cut" d="M12 8.8v4.6" fill="none" stroke-width="2.1" stroke-linecap="round"/><circle class="cutf" cx="12" cy="16.6" r="1.15"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path class="cut" d="M12 10.8v5.6" fill="none" stroke-width="2.1" stroke-linecap="round"/><circle class="cutf" cx="12" cy="7.7" r="1.25"/></svg>',
  };

  const STR = {
    "ko-KR": {
      idle: "마이크를 누르고 말해 보세요",
      idleSub: "또는 아래에 입력하세요",
      starting: "마이크를 켜는 중…",
      listening: "듣고 있어요",
      listeningSub: "“유튜브 열어 줘”처럼 말해 보세요",
      stopped: "마이크를 껐어요",
      stoppedSub: "마이크를 누르면 다시 들어요",
      idleStopped: "3분 동안 말이 없어 마이크를 껐어요",
      thinking: "처리 중…",
      hearing: "듣는 중…",
      moreSpeech: "계속 말씀하세요…",
      notCommand: "명령으로 들리지 않았어요",
      twice: "방금 한 동작이에요",
      twiceSub: "다시 하려면 “다시”라고 말하세요",
      twiceCard: "방금 한 동작이라 건너뛰었어요. 다시 하려면 “다시”라고 말하세요.",
      failed: "실행하지 못했어요",
      couldNot: (d) => `실행하지 못했어요: ${d}`,
      which: "어느 것인가요?",
      whichSub: "번호를 말하거나 누르세요",
      whichCard: "어느 것인가요? 번호를 말하세요.",
      pick: (i) => `${i}번`,
      sure: "실행할까요?",
      sureSub: "“확인” 또는 “취소”라고 말하세요",
      sureCard: (what) => `되돌릴 수 없는 동작이에요: <b>${what}</b>. “확인” 또는 “취소”라고 말하세요.`,
      confirm: "확인",
      cancel: "취소",
      wrong: (m) => `문제가 생겼어요: ${m}`,
      took: (s) => `말 끝나고 ${s}초`,
      captionOn: (eng) => `${eng} · 패널을 닫아도 계속 들어요`,
      captionOff: "⌥⇧V로 어디서나 켜고 끌 수 있어요",
      tryTitle: "이렇게 말해 보세요",
      chips: ["네이버로 가 줘", "유튜브 열어 줘", "아래로 내려 줘", "뒤로 가 줘", "새 탭 열어 줘", "팝업 닫아 줘"],
      hint: "팝업이 화면을 가리면 “닫아 줘”라고 말하세요.",
      placeholder: "명령 입력",
      details: "자세히",
      keyMissingT: "TypeSafe API 키를 넣어 주세요",
      keyMissingB: "무슨 뜻인지 TypeSafe의 Jev 모델이 판단해요. 설정에 키를 한 번 붙여넣으면 이 기기에만 저장돼요.",
      keyRejectedT: "API 키가 거부됐어요",
      keyRejectedB: "설정에서 키를 확인하고 “Test connection”을 눌러 보세요.",
      addKey: "먼저 API 키를 넣어 주세요",
      addKeySub: "설정에서 붙여넣을 수 있어요",
      openSettings: "설정 열기",
      micPromptT: "마이크 허용이 필요해요",
      micPromptB: "새로 열린 탭에서 “허용”을 누르면 바로 듣기 시작해요.",
      micBlockedT: "마이크가 차단돼 있어요",
      micBlockedB: "Chrome 설정에서 이 확장의 마이크를 “허용”으로 바꾼 뒤 다시 누르세요.",
      openChrome: "Chrome 설정 열기",
      askAgain: "다시 요청",
      micFailT: "마이크를 켜지 못했어요",
      sttT: "ElevenLabs 인식을 쓸 수 없어요",
      sttB: (m) => `${m} — 지금은 Chrome 기본 인식기로 들어요. 설정에서 ElevenLabs 키를 확인하세요.`,
      popupT: (banner) => (banner ? "배너가 화면을 가리고 있어요" : "팝업이 화면을 가리고 있어요"),
      popupB: (txt) => `${txt ? `“${txt}” — ` : ""}“닫아 줘”, “쿠키 동의해 줘”, “나중에”라고 말해 보세요.`,
      restrictedT: "이 페이지는 제어할 수 없어요",
      restrictedB: "Chrome이 확장에 이 페이지를 보여 주지 않아요. 이동·뒤로·새로고침·탭 명령은 돼요.",
      engines: { elevenlabs: "ElevenLabs", chrome: "Chrome 음성 인식" },
      conn: { reconnecting: "다시 연결 중", "no worker": "연결 안 됨" },
    },
    "en-US": {
      idle: "Tap the mic and say something",
      idleSub: "or type a command below",
      starting: "Starting the microphone…",
      listening: "Listening",
      listeningSub: "say something like “go to wikipedia”",
      stopped: "Paused",
      stoppedSub: "tap the mic to listen again",
      idleStopped: "No speech for 3 minutes — mic paused",
      thinking: "thinking…",
      hearing: "listening…",
      moreSpeech: "waiting for the rest…",
      notCommand: "that didn’t sound like a command",
      twice: "Heard you twice",
      twiceSub: "say “again” if you meant it",
      twiceCard: "Already did that a moment ago — say “again” to repeat.",
      failed: "That didn’t work",
      couldNot: (d) => `Couldn’t do that: ${d}`,
      which: "Which one?",
      whichSub: "say the number, or tap it",
      whichCard: "Which one? Say the number.",
      pick: (i) => ["one", "two", "three", "four", "five"][i - 1] || String(i),
      sure: "Are you sure?",
      sureSub: "say “confirm” or “cancel”",
      sureCard: (what) => `This looks irreversible: <b>${what}</b>. Say “confirm” or “cancel”.`,
      confirm: "Confirm",
      cancel: "Cancel",
      wrong: (m) => `Something went wrong: ${m}`,
      took: (s) => `${s} s after your last word`,
      captionOn: (eng) => `${eng} · keeps listening with the panel closed`,
      captionOff: "⌥⇧V turns it on or off from anywhere",
      tryTitle: "Try saying",
      chips: ["go to wikipedia", "search for alan turing", "click the first result", "scroll down a bit", "go back", "open a new tab"],
      hint: "Pop-up in the way? Say “close this” or “accept cookies”.",
      placeholder: "Type a command",
      details: "Details",
      keyMissingT: "Add your TypeSafe API key",
      keyMissingB: "Voice Browser asks TypeSafe’s Jev model what you meant. Paste your key once in Settings — it stays on this device.",
      keyRejectedT: "Your API key was rejected",
      keyRejectedB: "Check it in Settings and try “Test connection”.",
      addKey: "Add your API key first",
      addKeySub: "open Settings to paste it",
      openSettings: "Open Settings",
      micPromptT: "Allow the microphone",
      micPromptB: "Choose “Allow” in the tab that just opened — listening starts right after.",
      micBlockedT: "Microphone is blocked",
      micBlockedB: "Set Microphone to Allow for this extension in Chrome’s settings, then tap the mic again.",
      openChrome: "Open Chrome settings",
      askAgain: "Ask again",
      micFailT: "Couldn’t start the microphone",
      sttT: "ElevenLabs recognition isn’t available",
      sttB: (m) => `${m} — using Chrome’s recogniser instead. Check the ElevenLabs key in Settings.`,
      popupT: (banner) => (banner ? "A banner is covering the page" : "A pop-up is covering the page"),
      popupB: (txt) => `${txt ? `“${txt}” — ` : ""}say “close this”, “accept cookies” or “not now”.`,
      restrictedT: "This page can’t be controlled",
      restrictedB: "Chrome doesn’t let extensions see this page. Navigation, back, reload and tab commands still work.",
      engines: { elevenlabs: "ElevenLabs", chrome: "Chrome speech" },
      conn: { reconnecting: "reconnecting", "no worker": "not connected" },
    },
  };

  let port = null;
  let ui = null;
  let lang = localStorage.getItem("vb-lang") === "en-US" ? "en-US" : "ko-KR";
  const S = () => STR[lang];
  let mic = { on: false, starting: false, engine: null };
  let permWaiting = false;
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
  const request = (msg) => chrome.runtime.sendMessage(msg).catch((err) => ({ error: String(err?.message || err) }));
  function setConn(state, text) {
    $("conn").className = `conn ${state}`;
    // "ready" stays in the DOM (hidden) — the e2e test waits for it
    $("conntext").textContent = state === "ok" ? text : S().conn[text] || text;
  }

  function onMessage({ type, payload }) {
    switch (type) {
      case MSG.HELLO:
        ui = payload;
        if (payload?.mic) mic = payload.mic;
        if (payload?.mic?.lang && payload.mic.lang !== lang) applyLang(payload.mic.lang, { keepStatus: true });
        renderAll();
        renderSpeech(payload?.speech);
        renderMic();
        if (!convo.length) resetStatus();
        break;
      case MSG.MIC:
        onMic(payload);
        break;
      case MSG.SPEECH:
        speechLog(payload);
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
        break;
      case MSG.SNAPSHOT:
        if (ui) ui.snapshot = payload;
        renderPage();
        renderAlerts();
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

  // ------------------------------------------------------------ language
  function applyLang(next, { keepStatus = false } = {}) {
    lang = next === "en-US" ? "en-US" : "ko-KR";
    localStorage.setItem("vb-lang", lang);
    document.documentElement.lang = lang === "ko-KR" ? "ko" : "en";
    $("lang")
      .querySelectorAll("button")
      .forEach((b) => b.setAttribute("aria-pressed", b.dataset.lang === lang ? "true" : "false"));
    $("cmd").placeholder = S().placeholder;
    $("emptytitle").textContent = S().tryTitle;
    $("chips").innerHTML = S()
      .chips.map((c) => `<button class="chip" type="button" data-say="${esc(c)}">${esc(c)}</button>`)
      .join("");
    $("chips")
      .querySelectorAll(".chip")
      .forEach((b) => (b.onclick = () => say(b.dataset.say)));
    $("hint").textContent = S().hint;
    $("detailslabel").textContent = S().details;
    if (!keepStatus) resetStatus();
    renderMic();
  }
  $("lang")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = async () => {
          if (b.dataset.lang === lang) return;
          applyLang(b.dataset.lang);
          await request({ type: MSG.SET_LANG, lang: b.dataset.lang });
        }),
    );

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
    const ko = lang === "ko-KR";
    switch (a.type) {
      case "navigate_url":
        if (a.query) return ko ? `${q(a.query)} 검색했어요` : `Searched for ${q(a.query)}`;
        return ko ? `${hostOf(a.url || a.label)} 열었어요` : `Opened ${hostOf(a.url || a.label)}`;
      case "click_element":
        if (a.via === "close_popup") return ko ? `팝업을 닫았어요 (${label || "닫기"})` : `Dismissed the pop-up (${label || "close"})`;
        return ko ? `${q(label || "요소")} 눌렀어요` : `Clicked ${q(label || "the element")}`;
      case "type_into_field":
        if (!a.text) return ko ? `${label || "입력칸"} 비웠어요` : `Cleared ${label || "the field"}`;
        return ko ? `${q(a.text)} 입력했어요${a.submit ? " (Enter)" : ""}` : `Typed ${q(a.text)}${a.submit ? " and pressed Enter" : ""}`;
      case "select_option":
        return ko ? `${q(a.text)} 선택했어요` : `Selected ${q(a.text)}`;
      case "press_enter":
        return ko ? "Enter를 눌렀어요" : "Pressed Enter";
      case "scroll_down":
        if (a.amount === "end") return ko ? "맨 아래로 내렸어요" : "Scrolled to the bottom";
        if (a.amount === "little") return ko ? "조금 내렸어요" : "Scrolled down a little";
        return ko ? "아래로 내렸어요" : "Scrolled down";
      case "scroll_up":
        if (a.amount === "end") return ko ? "맨 위로 올렸어요" : "Scrolled to the top";
        if (a.amount === "little") return ko ? "조금 올렸어요" : "Scrolled up a little";
        return ko ? "위로 올렸어요" : "Scrolled up";
      case "go_back":
        if (entry.via === "undo") return ko ? "되돌렸어요 (뒤로)" : "Went back (undo)";
        return ko ? "뒤로 갔어요" : "Went back";
      case "go_forward":
        return ko ? "앞으로 갔어요" : "Went forward";
      case "reload":
        return ko ? "새로고침했어요" : "Reloaded the page";
      case "open_new_tab":
        return ko ? "새 탭을 열었어요" : "Opened a new tab";
      case "close_tab":
        return ko ? "탭을 닫았어요" : "Closed the tab";
      case "switch_tab":
        return ko ? "탭을 바꿨어요" : "Switched tab";
      default:
        return a.label || a.type || (ko ? "완료" : "Done");
    }
  }
  function setStatus(text, sub = "", cls = "") {
    const s = $("status");
    s.textContent = text;
    s.className = `status ${cls}`;
    $("substatus").textContent = sub;
  }
  function resetStatus() {
    if (mic.on) setStatus(S().listening, S().listeningSub);
    else if (mic.starting) setStatus(S().starting, "");
    else setStatus(S().idle, S().idleSub);
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
        const actions = (c.actions || []).map((a) => `<button class="btn sm${a.primary ? " primary" : ""} numbtn" type="button" data-say="${esc(a.say)}">${esc(a.label)}</button>`).join("");
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
    setStatus(q(text), S().thinking);
  }

  function onTranscript(p) {
    if (p.duplicate) {
      speechLog({ t: Date.now(), line: `↩ duplicate ignored: “${p.text}”` });
      return;
    }
    if (!p.text) return;
    const id = String(p.utteranceId).split("+")[0];
    upsert({ id: `u-${id}`, role: "user", text: p.text, interim: !p.final && !p.actedOn });
    if (!p.actedOn) setStatus(q(p.text), p.final ? S().thinking : S().hearing);
  }
  function onDecision(d) {
    renderDecision(d);
    const pol = d.policy || {};
    if (pol.decision === "wait") $("substatus").textContent = S().moreSpeech;
    else if (pol.decision === "ignore" && !pol.repeated) {
      $("substatus").textContent = S().notCommand;
    } else if (pol.decision === "ignore" && pol.repeated) {
      upsert({ id: `d-${d.at}`, role: "app", kind: "info", text: S().twiceCard, meta: "" });
      setStatus(S().twice, S().twiceSub);
    }
  }
  function onAction(entry) {
    const text = friendly(entry);
    const took = entry.sinceLastWordMs != null ? S().took((entry.sinceLastWordMs / 1000).toFixed(1)) : entry.executeMs != null ? `${entry.executeMs} ms` : "";
    if (entry.ok) {
      upsert({ id: `a-${Date.now()}`, role: "app", kind: "act", text, meta: took });
      setStatus(text, mic.on ? S().listening : "", "acted");
    } else {
      upsert({ id: `a-${Date.now()}`, role: "app", kind: "warn", text: S().couldNot(entry.detail || "unknown error"), meta: "" });
      setStatus(S().failed, entry.detail || "");
    }
  }
  function onCandidates(list) {
    if (!list?.length) return;
    const actions = list.map((c, i) => ({ say: S().pick(i + 1), label: `${i + 1} · ${c.label.replace(/^\w+\s+"(.*)"$/, "$1")}` }));
    upsert({ id: `c-${Date.now()}`, role: "app", kind: "ask", text: S().whichCard, actions });
    setStatus(S().which, S().whichSub);
  }
  function onPending(p) {
    if (!p) return;
    upsert({
      id: `p-${Date.now()}`,
      role: "app",
      kind: "warn",
      html: S().sureCard(esc(p.summary.replace(/^say "confirm" to /, ""))),
      // the spoken words stay English: they are the verified confirm / cancel path
      actions: [
        { say: "confirm", label: S().confirm, primary: true },
        { say: "cancel", label: S().cancel },
      ],
    });
    setStatus(S().sure, S().sureSub);
  }
  function onError(e) {
    if (e?.code === "no_api_key" || e?.status === 401) {
      if (ui) ui.apiKey = { hasKey: e.status === 401, rejected: e.status === 401 };
      renderAlerts();
      setStatus(S().addKey, S().addKeySub);
    } else if (e?.message) {
      upsert({ id: `e-${Date.now()}`, role: "app", kind: "warn", text: S().wrong(e.message) });
    }
  }

  // ------------------------------------------------------------ microphone (worker-owned)
  function engineName(e) {
    return S().engines[e] || e || "";
  }
  function renderMic() {
    const b = $("micbtn");
    const on = Boolean(mic.on);
    const starting = Boolean(mic.starting) && !on;
    b.classList.toggle("on", on);
    b.classList.toggle("starting", starting);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.setAttribute("aria-label", on || starting ? "Stop listening" : "Start listening");
    $("caption").textContent = on ? S().captionOn(engineName(mic.engine)) : starting ? "" : S().captionOff;
    const full = (e) => (e === "elevenlabs" ? "ElevenLabs Scribe v2 Realtime" : "Chrome Web Speech");
    $("sttengine").textContent = on ? full(mic.engine) : ui?.stt ? `${full(ui.stt.resolved)} (off)` : "–";
    renderAlerts();
  }
  function onMic(next) {
    const prev = mic;
    mic = next || {};
    if (mic.on && !prev.on) {
      permWaiting = false;
      setStatus(S().listening, S().listeningSub);
    } else if (mic.starting && !prev.starting && !mic.on) {
      setStatus(S().starting, "");
    } else if (!mic.on && !mic.starting && (prev.on || prev.starting)) {
      if (mic.error?.code === "mic_permission") {
        /* the alert explains it */
      } else if (mic.error) setStatus(S().micFailT, mic.error.message || mic.error.code);
      else if (mic.stopReason === "idle") setStatus(S().idleStopped, S().stoppedSub);
      else if (mic.stopReason !== "language") setStatus(S().stopped, S().stoppedSub);
    } else if (mic.on && mic.notice?.transient) {
      $("substatus").textContent = mic.notice.message;
    }
    renderMic();
  }
  async function toggleMic() {
    const r = await request({ type: MSG.MIC_TOGGLE });
    if (r && typeof r === "object" && "on" in r) onMic(r);
    if (r?.error?.code === "mic_permission" && r.error.state !== "denied") {
      // Offscreen documents and side panels cannot show Chrome's prompt: ask in a tab, which starts
      // the mic itself once allowed.
      permWaiting = true;
      chrome.tabs.create({ url: chrome.runtime.getURL("permission.html?reason=prompt&start=1") });
      setStatus(S().micPromptT, S().micPromptB);
      renderAlerts();
    }
  }
  $("micbtn").onclick = () => toggleMic();

  // ------------------------------------------------------------ alerts
  let lastAlertsHtml = null;
  function renderAlerts() {
    const out = [];
    const k = ui?.apiKey;
    if (k && !k.hasKey) out.push(alert("warn", S().keyMissingT, S().keyMissingB, [{ id: "openopt", label: S().openSettings, primary: true }]));
    else if (k?.rejected) out.push(alert("warn", S().keyRejectedT, S().keyRejectedB, [{ id: "openopt", label: S().openSettings, primary: true }]));
    const err = !mic.on ? mic.error : null;
    if (err?.code === "mic_permission" && err.state === "denied") {
      out.push(
        alert("warn", S().micBlockedT, S().micBlockedB, [
          { id: "micsettings", label: S().openChrome, primary: true },
          { id: "micpage", label: S().askAgain },
        ]),
      );
    } else if (err?.code === "mic_permission" || permWaiting) {
      out.push(alert("info", S().micPromptT, S().micPromptB, [{ id: "micpage", label: S().askAgain }]));
    } else if (err) {
      out.push(alert("warn", S().micFailT, err.message || err.code, []));
    }
    if (mic.on && mic.engine === "chrome" && mic.notice && !mic.notice.transient) {
      out.push(alert("warn", S().sttT, S().sttB(mic.notice.message), [{ id: "openopt", label: S().openSettings, primary: true }]));
    }
    const sn = ui?.snapshot;
    if (sn?.popup) out.push(alert("info", S().popupT(sn.popup.kind === "banner"), S().popupB(sn.popup.text ? sn.popup.text.slice(0, 90) : ""), []));
    if (sn?.restricted && sn.error && !sn.blank) out.push(alert("info", S().restrictedT, S().restrictedB, []));
    // re-render only on change: replacing the cards replays their fade-in (visible flicker)
    const html = out.join("");
    if (html === lastAlertsHtml) return;
    lastAlertsHtml = html;
    $("alerts").innerHTML = html;
    const bind = (id, fn) => $("alerts").querySelectorAll(`[data-act="${id}"]`).forEach((b) => (b.onclick = fn));
    bind("openopt", () => chrome.runtime.openOptionsPage());
    bind("micsettings", () => chrome.tabs.create({ url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(`chrome-extension://${chrome.runtime.id}`)}` }));
    bind("micpage", () => {
      permWaiting = true;
      chrome.tabs.create({ url: chrome.runtime.getURL(`permission.html?reason=${err?.state === "denied" ? "denied" : "prompt"}&start=1`) });
    });
  }
  function alert(kind, title, body, actions) {
    const btns = actions.map((a) => `<button class="btn sm${a.primary ? " primary" : ""}" type="button" data-act="${a.id}">${esc(a.label)}</button>`).join("");
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
  function renderSpeech(list) {
    if (!Array.isArray(list) || !list.length) return;
    $("speechlog").innerHTML = "";
    list.forEach(speechLog);
  }
  function speechLog(e) {
    const log = $("speechlog");
    if (log.querySelector("span.muted")) log.innerHTML = "";
    const div = document.createElement("div");
    div.textContent = `${new Date(e?.t || Date.now()).toLocaleTimeString([], { hour12: false })} ${e?.line ?? e}`;
    log.appendChild(div);
    while (log.children.length > 80) log.removeChild(log.firstChild);
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
  $("undo").onclick = () => send({ type: MSG.UNDO });
  $("resnap").onclick = () => send({ type: MSG.SNAPSHOT });
  $("settingsbtn").onclick = () => chrome.runtime.openOptionsPage();

  applyLang(lang);
  connect();
})();
