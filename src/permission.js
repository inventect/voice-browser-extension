/**
 * permission.html: request microphone access for the extension origin in a real tab. Side panels
 * and offscreen documents cannot show Chrome's prompt; once granted here, the offscreen microphone
 * can listen. With ?start=1 (opened by the mic button / shortcut) it also switches listening on,
 * then closes itself. Copy follows the side panel's language (Korean by default).
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const reason = params.get("reason");
  const autoStart = params.get("start") === "1";
  const ko = (localStorage.getItem("vb-lang") || "ko-KR") !== "en-US";
  const T = ko
    ? {
        title: "마이크를 허용해 주세요",
        lede: "Voice Browser가 말을 들으려면 마이크가 필요해요. Chrome은 사이드 패널 안에서 물어볼 수 없어서 여기서 한 번만 물어봐요. 창이 뜨면 <b>허용</b>을 고르세요(“이번만 허용” 말고).",
        allow: "마이크 허용",
        allowed: "허용됨",
        waiting: "Chrome의 허용 창을 기다리는 중…",
        ok: "✓ 마이크를 허용했어요. 듣기를 시작해요 — 이 탭은 2초 뒤 닫혀요.",
        okNoStart: "✓ 마이크를 허용했어요. 이 탭은 2초 뒤 닫혀요.",
        blocked: "Chrome이 마이크를 막았어요. 아래 ‘Chrome 사이트 설정’에서 마이크를 ‘허용’으로 바꾼 뒤 ‘마이크 허용’을 다시 누르세요.",
        blockedEarlier: "마이크가 이전에 차단됐어요. ‘Chrome 사이트 설정’에서 마이크를 ‘허용’으로 바꾼 뒤 ‘마이크 허용’을 누르세요.",
        none: "이 컴퓨터에서 마이크를 찾지 못했어요.",
        settings: "Chrome 사이트 설정",
        close: "탭 닫기",
        note: "마이크는 사이드 패널을 닫아도 계속 들을 수 있어요(도구 막대 아이콘에 ON 표시, ⌥⇧V로 켜고 끄기). 확장은 녹음 파일을 남기지 않아요.",
      }
    : {
        title: "Allow the microphone",
        lede: "Voice Browser needs to hear you. Chrome can’t ask from inside the side panel, so it asks here, once. Choose <b>Allow</b> in the prompt — not “Allow this time”.",
        allow: "Allow microphone",
        allowed: "Allowed",
        waiting: "Waiting for Chrome’s prompt…",
        ok: "✓ Microphone allowed. Listening now — this tab closes in 2 s.",
        okNoStart: "✓ Microphone allowed. This tab closes in 2 s.",
        blocked: "Chrome blocked the microphone. Open the site settings below, set Microphone to Allow, then press “Allow microphone” again.",
        blockedEarlier: "Microphone access was blocked earlier. Open the site settings, set Microphone to Allow, then press “Allow microphone”.",
        none: "No microphone was found on this computer.",
        settings: "Open Chrome site settings",
        close: "Close this tab",
        note: "The microphone keeps listening with the side panel closed (ON badge on the toolbar icon, ⌥⇧V toggles it). Nothing is recorded by the extension.",
      };
  document.documentElement.lang = ko ? "ko" : "en";
  $("ptitle").textContent = T.title;
  $("plede").innerHTML = T.lede;
  $("retry").textContent = T.allow;
  $("status").textContent = T.waiting;
  $("settings").textContent = T.settings;
  $("close").textContent = T.close;
  $("pnote").textContent = T.note;

  function show(kind, text) {
    const el = $("status");
    el.className = `status-line ${kind}`;
    el.textContent = text;
  }

  async function request() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      $("retry").textContent = T.allowed;
      $("retry").disabled = true;
      window.__vbMicGranted = true;
      if (autoStart) {
        show("ok", T.ok);
        try {
          await chrome.runtime.sendMessage({ type: "mic-start" });
        } catch {}
      } else {
        show("ok", T.okNoStart);
      }
      setTimeout(closeTab, 2000);
      return true;
    } catch (err) {
      const name = err?.name || "Error";
      if (name === "NotAllowedError") show("err", T.blocked);
      else if (name === "NotFoundError") show("err", T.none);
      else show("err", `${name}: ${err?.message || err}`);
      window.__vbMicError = name;
      return false;
    }
  }

  async function closeTab() {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id != null) await chrome.tabs.remove(tab.id);
      else window.close();
    } catch {
      window.close();
    }
  }

  $("retry").onclick = request;
  $("close").onclick = closeTab;
  $("settings").onclick = () => chrome.tabs.create({ url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(`chrome-extension://${chrome.runtime.id}`)}` });

  if (reason === "denied") show("err", T.blockedEarlier);
  else request();
})();
