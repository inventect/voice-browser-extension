/**
 * permission.html: request microphone access for the extension origin in a real tab (side panels
 * and popups cannot show the prompt). Closes itself once granted.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  $("origin").textContent = `chrome-extension://${chrome.runtime.id}`;
  const params = new URLSearchParams(location.search);
  const reason = params.get("reason");

  function show(kind, text) {
    const el = $("status");
    el.className = `notice ${kind}`;
    el.textContent = text;
  }

  async function request() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      const st = await navigator.permissions.query({ name: "microphone" }).catch(() => null);
      show("ok", `✓ microphone allowed${st ? ` (state: ${st.state})` : ""}. You can go back to the side panel — this tab closes in 2 s.`);
      window.__vbMicGranted = true;
      setTimeout(closeTab, 2000);
      return true;
    } catch (err) {
      const name = err?.name || "Error";
      if (name === "NotAllowedError") {
        show("err", "✗ microphone blocked. Click the icon left of the address bar (or the button below) and set Microphone to Allow, then press “Request microphone access” again.");
      } else if (name === "NotFoundError") {
        show("err", "✗ no microphone found on this computer.");
      } else {
        show("err", `✗ ${name}: ${err?.message || err}`);
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
    show("err", "Microphone access was blocked for this extension earlier. Open the site settings (button below), set Microphone to Allow, then press “Request microphone access”.");
  } else {
    request();
  }
})();
