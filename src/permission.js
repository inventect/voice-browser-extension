/**
 * permission.html: request microphone access for the extension origin in a real tab (side panels
 * and popups cannot show the prompt). Closes itself once granted.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const reason = new URLSearchParams(location.search).get("reason");

  function show(kind, text) {
    const el = $("status");
    el.className = `status-line ${kind}`;
    el.textContent = text;
  }

  async function request() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      show("ok", "✓ Microphone allowed. Back to the side panel — this tab closes in 2 s.");
      $("retry").textContent = "Allowed";
      $("retry").disabled = true;
      window.__vbMicGranted = true;
      setTimeout(closeTab, 2000);
      return true;
    } catch (err) {
      const name = err?.name || "Error";
      if (name === "NotAllowedError") {
        show("err", "Chrome blocked the microphone. Open the site settings below, set Microphone to Allow, then press “Allow microphone” again.");
      } else if (name === "NotFoundError") {
        show("err", "No microphone was found on this computer.");
      } else {
        show("err", `${name}: ${err?.message || err}`);
      }
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

  if (reason === "denied") {
    show("err", "Microphone access was blocked earlier. Open the site settings, set Microphone to Allow, then press “Allow microphone”.");
  } else {
    request();
  }
})();
